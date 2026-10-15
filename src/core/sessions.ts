import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createDatabaseBackup } from "./backup.js";
import { isV2Database, sessionTable } from "./database-generation.js";
import { ensureDir } from "./fsx.js";
import { healthProblems, inspectDatabase } from "./health.js";
import { SESSIONS_DIR } from "./paths.js";
import type { Reporter } from "./reporter.js";
import { acknowledgeV2, exportV2, importV2 } from "./sessions-v2.js";
import type { SessionSettings } from "./settings.js";
import { type SqliteDatabase, existingTables, openDatabase, tableColumns } from "./sqlite.js";

/**
 * Selective session sync.
 *
 * The naive approach - committing `opencode.db` - stops working almost immediately.
 * A real database reaches several gigabytes, dominated by tool output stored in
 * `part.data`, and Git has no way to delta-compress it. Worse, copying a live
 * database together with its write-ahead log can capture a torn state that only
 * reveals itself much later.
 *
 * So sessions are exported one at a time. Each session becomes an independent,
 * gzipped JSON shard containing its own rows plus the project and workspace
 * rows it depends on. That buys three things:
 *
 *   - **No large files.** Shards are individually small and compress well.
 *   - **Conflict isolation.** Two machines editing different sessions touch
 *     different files, so Git merges them without any special handling. The
 *     only true conflict is the same session edited in two places, where the
 *     newer `time_updated` wins.
 *   - **Selectivity.** A time window, an explicit include list, a project
 *     filter and a per-session size cap decide what travels. Ancient sessions
 *     stay on the machine that created them.
 *
 * Import is an upsert inside a transaction, so a failure leaves the local
 * database exactly as it was.
 */

/** Tables whose rows belong to exactly one session. */
const SESSION_TABLES = [
  "session_message",
  "message",
  "part",
  "todo",
  "session_share",
  "session_context_epoch",
  "session_input",
] as const;

/**
 * `event` and `event_sequence` are deliberately excluded. They are an internal
 * append-only runtime log, they dwarf everything else in row count, and nothing
 * about resuming a conversation on another machine depends on them.
 */

export interface SessionRecord {
  id: string;
  title: string;
  directory: string;
  timeUpdated: number;
  timeCreated: number;
  projectId: string;
}

export interface SessionLocation {
  directory: string;
  totalSessions: number;
  rootSessions: number;
  childSessions: number;
  latestUpdated: number;
}

export interface SessionShard {
  formatVersion: 1;
  session: Record<string, unknown>;
  project?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
  exportedAt: number;
}

export interface SelectOptions extends SessionSettings {
  now?: number;
}

export interface ExportResult {
  /** V2 snapshot receipts, captured before network operations or further local edits. */
  exportedHashes?: Record<string, string>;
  written: string[];
  skippedTooLarge: { id: string; title: string; bytes: number }[];
  considered: number;
  conflicts?: string[];
}

export interface ImportResult {
  imported: number;
  skippedOlder: number;
  conflicts: { sessionId: string; reason: string }[];
  failed: { file: string; reason: string }[];
  backup?: string;
  rolledBack?: boolean;
  dryRun?: boolean;
}

export interface ImportOptions {
  offlineConfirmed?: boolean;
  dryRun?: boolean;
  preferRemote?: boolean;
  backupBeforeImport?: boolean;
  backupRetention?: number;
  pathMappings?: Array<{ from: string; to: string }>;
}

function shardPath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, SESSIONS_DIR, `${sanitizeId(sessionId)}.json.gz`);
}

/** Session ids are opaque; keep them filesystem-safe without losing identity. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function readRows(db: SqliteDatabase, sql: string, params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

/**
 * Choose which sessions to export.
 *
 * Explicitly included ids always win, even when they fall outside the window.
 * Everything else must be inside the time window, pass the directory filter and
 * survive the count cap, which keeps the newest sessions.
 */
export function selectSessions(db: SqliteDatabase, options: SelectOptions): SessionRecord[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.days * 24 * 60 * 60 * 1000;

  const rows = readRows(
    db,
    `SELECT id, title, directory, time_updated, time_created, project_id
       FROM ${sessionTable(db)}
      ORDER BY time_updated DESC`,
    [],
  ) as any[];

  const exclude = new Set(options.exclude);
  const include = new Set(options.include);
  const directories = options.directories.map((d) => path.resolve(d));

  const matchesDirectory = (directory: string): boolean => {
    if (directories.length === 0) return true;
    const resolved = path.resolve(String(directory ?? ""));
    return directories.some((d) => resolved === d || resolved.startsWith(`${d}${path.sep}`));
  };

  const selected: SessionRecord[] = [];
  let windowCount = 0;

  for (const row of rows) {
    const id = String(row.id);
    if (exclude.has(id)) continue;

    const record: SessionRecord = {
      id,
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      timeUpdated: Number(row.time_updated ?? 0),
      timeCreated: Number(row.time_created ?? 0),
      projectId: String(row.project_id ?? ""),
    };

    if (include.has(id)) {
      selected.push(record);
      continue;
    }
    if (record.timeUpdated < cutoff) continue;
    if (!matchesDirectory(record.directory)) continue;
    if (windowCount >= options.maxSessions) continue;

    windowCount++;
    selected.push(record);
  }

  return selected;
}

type Row = Record<string, unknown>;
type Mapping = { from: string; to: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
function mapPath(value: unknown, mappings: Mapping[]): unknown {
  if (typeof value !== "string") return value;
  const candidate = value.replace(/\\/g, "/");
  for (const m of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
    const from = m.from.replace(/\\/g, "/").replace(/\/$/, "");
    const windows = /^[a-z]:/i.test(from);
    const c = windows ? candidate.toLowerCase() : candidate;
    const f = windows ? from.toLowerCase() : from;
    if (c === f || c.startsWith(`${f}/`))
      return m.to.replace(/\\/g, "/").replace(/\/$/, "") + candidate.slice(from.length);
  }
  return value;
}
function mapRow(table: string, row: Row, mappings: Mapping[]): Row {
  const copy = { ...row };
  for (const key of table === "session"
    ? ["directory", "path"]
    : table === "project"
      ? ["worktree"]
      : []) {
    if (key in copy) copy[key] = mapPath(copy[key], mappings);
  }
  return copy;
}
function buildShard(
  db: SqliteDatabase,
  id: string,
  tables: string[],
  mappings: Mapping[] = [],
): SessionShard {
  const row = readRows(db, "SELECT * FROM session WHERE id=?", [id])[0];
  if (!row) throw new Error(`Session ${id} disappeared while exporting`);
  const reverse = mappings.map((m) => ({ from: m.to, to: m.from }));
  const shard: SessionShard = {
    formatVersion: 1,
    session: mapRow("session", row, reverse),
    tables: {},
    exportedAt: Number(row.time_updated ?? 0),
  };
  if (row.project_id && row.project_id !== "global") {
    const project = readRows(db, "SELECT * FROM project WHERE id=?", [row.project_id])[0];
    if (project) shard.project = mapRow("project", project, reverse);
  }
  if (row.workspace_id) {
    const ws = readRows(db, "SELECT * FROM workspace WHERE id=?", [row.workspace_id])[0];
    if (ws) shard.workspace = ws;
  }
  for (const table of tables)
    shard.tables[table] = readRows(db, `SELECT * FROM "${table}" WHERE session_id=?`, [id]).sort(
      (a, b) => {
        const x = canonical(a);
        const y = canonical(b);
        return x < y ? -1 : x > y ? 1 : 0;
      },
    );
  return shard;
}
function contentHash(shard: SessionShard): string {
  const tables = Object.fromEntries(
    Object.entries(shard.tables)
      .filter(([, rows]) => rows.length)
      .map(([t, rows]) => [
        t,
        [...rows].sort((a, b) => {
          const x = canonical(a);
          const y = canonical(b);
          return x < y ? -1 : x > y ? 1 : 0;
        }),
      ]),
  );
  return createHash("sha256")
    .update(canonical({ session: shard.session, tables }))
    .digest("hex");
}
function readBases(file: string): Record<string, string> {
  if (!fs.existsSync(file + ".omds-bases.json")) return {};
  const raw = JSON.parse(fs.readFileSync(file + ".omds-bases.json", "utf8"));
  if (raw.version !== 1 || !raw.hashes || typeof raw.hashes !== "object")
    throw new Error("Invalid local sync baseline; refusing to guess conflict resolution");
  return raw.hashes;
}
function saveBases(file: string, hashes: Record<string, string>): void {
  const target = file + ".omds-bases.json";
  const temp = target + `.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, hashes }), { mode: 0o600 });
  fs.renameSync(temp, target);
}
function readShard(file: string): SessionShard {
  if (fs.statSync(file).size > 64 * 1024 * 1024)
    throw new Error("Compressed shard exceeds 64 MiB safety limit");
  const s = JSON.parse(
    gunzipSync(fs.readFileSync(file), { maxOutputLength: 128 * 1024 * 1024 }).toString("utf8"),
  ) as SessionShard;
  if (
    s.formatVersion !== 1 ||
    !s.session ||
    typeof s.session.id !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(s.session.id)
  )
    throw new Error("Invalid session shard");
  if (path.basename(file) !== `${s.session.id}.json.gz`)
    throw new Error("Shard filename does not match session id");
  if (!Number.isFinite(s.session.time_updated) || !s.tables || typeof s.tables !== "object")
    throw new Error("Invalid shard metadata");
  if (s.project && s.project.id !== s.session.project_id)
    throw new Error("Project ownership mismatch");
  if (s.workspace && s.workspace.id !== s.session.workspace_id)
    throw new Error("Workspace ownership mismatch");
  for (const [table, rows] of Object.entries(s.tables)) {
    if (!(SESSION_TABLES as readonly string[]).includes(table) || !Array.isArray(rows))
      throw new Error(`Unsupported shard table: ${table}`);
    for (const row of rows)
      if (!row || row.session_id !== s.session.id)
        throw new Error(`Row ownership mismatch in ${table}`);
  }
  return s;
}
function availableTables(db: SqliteDatabase): string[] {
  return existingTables(db, [...SESSION_TABLES]).filter((t) =>
    tableColumns(db, t).includes("session_id"),
  );
}
export async function exportSessions(
  file: string,
  repo: string,
  options: SelectOptions,
  reporter: Reporter,
): Promise<ExportResult> {
  if (await isV2Database(file)) return exportV2(file, repo, options, reporter);
  const result: ExportResult = { written: [], skippedTooLarge: [], considered: 0, conflicts: [] };
  if (!fs.existsSync(file)) return result;
  const bases = readBases(file);
  const db = await openDatabase(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const tables = availableTables(db);
    const selected = selectSessions(db, options);
    result.considered = selected.length;
    ensureDir(path.join(repo, SESSIONS_DIR));
    for (const session of selected) {
      const shard = buildShard(db, session.id, tables, options.pathMappings ?? []);
      const dest = shardPath(repo, session.id);
      if (fs.existsSync(dest)) {
        const remote = readShard(dest);
        const remoteHash = contentHash(remote);
        const localHash = contentHash(shard);
        if (remoteHash !== localHash && bases[session.id] !== remoteHash) {
          result.conflicts?.push(session.id);
          reporter.warn(`Export conflict ${session.id}: pull/review remote changes first`);
          continue;
        }
      }
      const payload = gzipSync(Buffer.from(canonical(shard)), { level: 9 });
      if (payload.length > options.maxSessionBytes) {
        result.skippedTooLarge.push({
          id: session.id,
          title: session.title,
          bytes: payload.length,
        });
        continue;
      }
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(payload)) {
        const tmp = dest + `.${randomUUID()}.tmp`;
        fs.writeFileSync(tmp, payload, { mode: 0o600 });
        fs.renameSync(tmp, dest);
      }
      result.written.push(session.id);
    }
    // Never delete remote shards merely because this machine lacks a session or has a different retention window.
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
export async function acknowledgeExport(
  file: string,
  repo: string,
  mappings: Mapping[] = [],
  exportedHashes?: Record<string, string>,
): Promise<void> {
  if (await isV2Database(file)) return acknowledgeV2(file, repo, exportedHashes);
  if (!fs.existsSync(file)) return;
  const bases = readBases(file);
  const db = await openDatabase(file, { readOnly: true });
  try {
    const tables = availableTables(db);
    for (const row of readRows(db, "SELECT id FROM session", [])) {
      const id = String(row.id);
      const p = shardPath(repo, id);
      if (!fs.existsSync(p)) continue;
      const incoming = contentHash(readShard(p));
      const local = contentHash(buildShard(db, id, tables, mappings));
      if (incoming === local) bases[id] = local;
    }
    saveBases(file, bases);
  } finally {
    db.close();
  }
}
function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value))
    return JSON.stringify(value);
  return value;
}
function upsert(db: SqliteDatabase, table: string, row: Row): void {
  const allowed = tableColumns(db, table);
  if (!allowed.length) throw new Error(`Missing table ${table}`);
  const columns = Object.keys(row).filter((c) => allowed.includes(c));
  if (columns.length !== Object.keys(row).length)
    throw new Error(`Schema mismatch in ${table}; unsupported columns present`);
  const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
  const quoted = columns.map(q).join(",");
  const places = columns.map(() => "?").join(",");
  const updates = columns.map((c) => `${q(c)}=excluded.${q(c)}`).join(",");
  if (allowed.includes("session_id") && allowed.includes("id") && row.id) {
    const existing = readRows(db, `SELECT session_id FROM ${q(table)} WHERE id=?`, [row.id])[0];
    if (existing && existing.session_id !== row.session_id)
      throw new Error(`Existing row belongs to another session: ${table}`);
  }
  db.prepare(
    `INSERT INTO ${q(table)} (${quoted}) VALUES (${places}) ON CONFLICT DO UPDATE SET ${updates}`,
  ).run(...columns.map((c) => normalize(row[c])));
}

export async function importSessions(
  file: string,
  repo: string,
  reporter: Reporter,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (await isV2Database(file)) return importV2(file, repo, reporter, options);
  const result: ImportResult = {
    imported: 0,
    skippedOlder: 0,
    conflicts: [],
    failed: [],
    dryRun: options.dryRun ?? false,
  };
  const dir = path.join(repo, SESSIONS_DIR);
  if (!fs.existsSync(dir)) return result;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json.gz"))
    .sort();
  if (!files.length) return result;
  if (!fs.existsSync(file)) {
    result.failed.push({
      file: "<database>",
      reason: "Start OpenCode once to initialize its schema, then pull again",
    });
    return result;
  }
  const bases = readBases(file);
  const nextBases = { ...bases };
  const mappings = options.pathMappings ?? [];
  const db = await openDatabase(file, { readOnly: options.dryRun ?? false });
  let transaction = false;
  try {
    db.exec(options.dryRun ? "BEGIN" : "BEGIN IMMEDIATE");
    transaction = true;
    const before = inspectDatabase(db);
    if (!before.ok) throw new Error(`Unsafe database: ${healthProblems(before).join("; ")}`);
    const tables = availableTables(db);
    const plan: Array<{ name: string; shard: SessionShard; hash: string }> = [];
    for (const name of files) {
      try {
        const shard = readShard(path.join(dir, name));
        const id = String(shard.session.id);
        const hash = contentHash(shard);
        const localRow = readRows(db, "SELECT * FROM session WHERE id=?", [id])[0];
        if (localRow) {
          const localShard = buildShard(db, id, tables, mappings);
          const localHash = contentHash(localShard);
          if (hash === localHash) {
            result.skippedOlder++;
            nextBases[id] = hash;
            continue;
          }
          const base = bases[id];
          if (base === hash) {
            result.skippedOlder++;
            continue;
          }
          if (!options.preferRemote && (!base || localHash !== base)) {
            if (Number(localRow.time_updated) > Number(shard.session.time_updated))
              result.skippedOlder++;
            result.conflicts.push({
              sessionId: id,
              reason: base
                ? "both devices changed since last sync"
                : "different local history without a common baseline",
            });
            continue;
          }
          // Do not silently prune local history, even when an incoming snapshot is newer.
          for (const table of tables) {
            const keys = (
              db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
                name: string;
                pk: number;
              }>
            )
              .filter((c) => c.pk > 0)
              .sort((a, b) => a.pk - b.pk)
              .map((c) => c.name);
            if (!keys.length) throw new Error(`No primary key in ${table}`);
            const identity = (row: Row) => canonical(keys.map((k) => row[k]));
            const incoming = new Set((shard.tables[table] ?? []).map(identity));
            if ((localShard.tables[table] ?? []).some((row) => !incoming.has(identity(row))))
              throw new Error(
                `Incoming snapshot would discard local ${table} rows; explicit reconciliation required`,
              );
          }
        }
        plan.push({ name, shard, hash });
      } catch (error) {
        result.failed.push({ file: name, reason: (error as Error).message });
      }
    }
    if (result.failed.length || result.conflicts.length) {
      db.exec("ROLLBACK");
      transaction = false;
      result.rolledBack = true;
      for (const c of result.conflicts)
        reporter.warn(`Session conflict ${c.sessionId}: ${c.reason}; no sessions imported`);
      return result;
    }
    if (options.dryRun) {
      result.imported = plan.length;
      db.exec("ROLLBACK");
      transaction = false;
      return result;
    }
    if (plan.length && options.backupBeforeImport !== false) {
      const backup = await createDatabaseBackup(file, undefined, options.backupRetention ?? 10);
      result.backup = backup.path;
      reporter.detail(`Verified backup: ${backup.path}`);
    }
    for (const item of plan) {
      const { shard } = item;
      const session = mapRow("session", shard.session, mappings);
      const id = String(session.id);
      const projectId = session.project_id;
      const project = readRows(db, "SELECT id FROM project WHERE id=?", [projectId])[0];
      if (!project) {
        if (projectId === "global")
          throw new Error("Synthetic global project must be initialized locally by OpenCode");
        if (!shard.project) throw new Error("Missing project row in session shard");
        upsert(db, "project", mapRow("project", shard.project, mappings));
      }
      if (
        shard.workspace &&
        !readRows(db, "SELECT id FROM workspace WHERE id=?", [shard.workspace.id])[0]
      )
        upsert(db, "workspace", shard.workspace);
      upsert(db, "session", session);
      // Insert referenced messages before parts, independent of JSON object key order.
      for (const table of [
        "message",
        "part",
        ...SESSION_TABLES.filter((t) => t !== "message" && t !== "part"),
      ]) {
        for (const row of shard.tables[table] ?? []) upsert(db, table, row);
      }
      nextBases[id] = item.hash;
      result.imported++;
    }
    const after = inspectDatabase(db);
    if (!after.ok || after.sessions < before.sessions)
      throw new Error(`Post-import integrity failed: ${healthProblems(after).join("; ")}`);
    db.exec("COMMIT");
    transaction = false;
    saveBases(file, nextBases);
    return result;
  } catch (error) {
    if (transaction) {
      db.exec("ROLLBACK");
      transaction = false;
      result.imported = 0;
      result.rolledBack = true;
    }
    result.failed.push({ file: "<transaction>", reason: (error as Error).message });
    return result;
  } finally {
    if (transaction) db.exec("ROLLBACK");
    db.close();
  }
}

export async function listSessionLocations(databaseFile: string): Promise<SessionLocation[]> {
  if (!fs.existsSync(databaseFile)) return [];
  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    const table = sessionTable(db);
    const hasParent = tableColumns(db, table).includes("parent_id");
    const rootExpr = hasParent ? "SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END)" : "COUNT(*)";
    const rows = db
      .prepare(
        `SELECT directory, COUNT(*) AS total, ${rootExpr} AS roots, MAX(time_updated) AS latest\n      FROM ${table} GROUP BY directory ORDER BY roots DESC, latest DESC`,
      )
      .all() as any[];
    return rows.map((row) => {
      const totalSessions = Number(row.total ?? 0);
      const rootSessions = Number(row.roots ?? totalSessions);
      return {
        directory: String(row.directory ?? ""),
        totalSessions,
        rootSessions,
        childSessions: Math.max(0, totalSessions - rootSessions),
        latestUpdated: Number(row.latest ?? 0),
      };
    });
  } finally {
    db.close();
  }
}

/** List sessions available locally, newest first - powers `sessions list`. */
export async function listSessions(databaseFile: string, limit: number): Promise<SessionRecord[]> {
  if (!fs.existsSync(databaseFile)) return [];
  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    const rows = readRows(
      db,
      `SELECT id, title, directory, time_updated, time_created, project_id
         FROM ${sessionTable(db)} ORDER BY time_updated DESC LIMIT ?`,
      [limit],
    ) as any[];
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      timeUpdated: Number(row.time_updated ?? 0),
      timeCreated: Number(row.time_created ?? 0),
      projectId: String(row.project_id ?? ""),
    }));
  } finally {
    db.close();
  }
}
