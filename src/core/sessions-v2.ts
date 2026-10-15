import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createDatabaseBackup } from "./backup.js";
import { assertOfflineV2 } from "./database-generation.js";
import { healthProblems, inspectDatabase } from "./health.js";
import { SESSIONS_DIR } from "./paths.js";
import type { Reporter } from "./reporter.js";
import {
  type ExportResult,
  type ImportOptions,
  type ImportResult,
  type SelectOptions,
  selectSessions,
} from "./sessions.js";
import { type SqliteDatabase, openDatabase } from "./sqlite.js";

type Row = Record<string, any>;
type Mapping = { from: string; to: string };
const SCHEMA_TABLES = [
  "session_v2",
  "session_message",
  "event_sequence",
  "event",
  "instruction_entry",
  "instruction_state",
  "instruction_blob",
  "session_pending",
  "session_inbox",
  "project",
  "worktree",
];
// PRAGMA columns/FKs of the released 2.0.29 schema, not a guessed compatibility range.
const SCHEMA = "a914381779841dbfc4b8a8e2313ba7b3bab43ae9f4621116027ab0a1b5ff82b9";
const TABLES = [
  "session_message",
  "instruction_entry",
  "instruction_state",
  "event",
  "event_sequence",
];
interface Shard {
  formatVersion: 2;
  engine: "opencode-v2";
  schema: string;
  session: Row;
  project: Row;
  tables: Record<string, Row[]>;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function rows(db: SqliteDatabase, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...params);
}
function assertSchema(db: SqliteDatabase): void {
  const signature = SCHEMA_TABLES.map((t) => [
    t,
    rows(db, `PRAGMA table_info(${t})`)
      .map(({ cid: _, ...r }) => r)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "en")),
    rows(db, `PRAGMA foreign_key_list(${t})`),
  ]);
  const hash = createHash("sha256").update(JSON.stringify(signature)).digest("hex");
  if (hash !== SCHEMA)
    throw new Error("Unsupported V2 schema: only the verified OpenCode 2.0.29 schema is supported");
  if (rows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration'").length) {
    const newer = rows(
      db,
      "SELECT id FROM migration WHERE id > ? LIMIT 1",
      "20261010180456_project_time_archived",
    );
    if (newer.length)
      throw new Error("Unsupported V2 migration lineage newer than verified OpenCode 2.0.29");
  }
}
function mapPath(value: string, mappings: Mapping[]): string {
  const candidate = value.replaceAll("\\", "/");
  for (const m of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
    const from = m.from.replaceAll("\\", "/").replace(/\/$/, "");
    const windows = /^[a-z]:|^\/\//i.test(from);
    const c = windows ? candidate.toLowerCase() : candidate;
    const f = windows ? from.toLowerCase() : from;
    if (c === f || c.startsWith(f + "/"))
      return m.to.replaceAll("\\", "/").replace(/\/$/, "") + candidate.slice(from.length);
  }
  return candidate;
}
function translateRow(row: Row, mappings: Mapping[], fromID: string, toID: string): Row {
  const copy = { ...row };
  if (copy.project_id === fromID) copy.project_id = toID;
  for (const key of ["directory", "worktree", "path"])
    if (typeof copy[key] === "string") copy[key] = mapPath(copy[key], mappings);
  if (typeof copy.data === "string") {
    const data = JSON.parse(copy.data);
    // Only protocol-owned location fields travel. Historical tool input/output,
    // arbitrary metadata and immutable instruction values remain byte-for-byte values.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (data.projectID === fromID) data.projectID = toID;
      if (data.location && typeof data.location.directory === "string")
        data.location.directory = mapPath(data.location.directory, mappings);
    }
    copy.data = canonical(data);
  }
  return copy;
}
function assertSettled(db: SqliteDatabase, id: string): void {
  const session = rows(db, "SELECT * FROM session_v2 WHERE id=?", id)[0];
  if (!session) throw new Error(`Missing V2 session ${id}`);
  if (session.time_suspended !== null || session.time_compacting !== null)
    throw new Error(`Active execution in ${id}; wait until idle`);
  if (session.workspace_id !== null)
    throw new Error(`Workspace-bound session ${id} is not portable in this release`);
  for (const table of ["session_pending", "session_inbox"])
    if (rows(db, `SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`, id).length)
      throw new Error(`Pending input in ${id}; wait until idle`);
  for (const row of rows(db, "SELECT type,data FROM session_message WHERE session_id=?", id)) {
    const data = JSON.parse(row.data);
    if (
      (row.type === "assistant" && data.time?.completed == null) ||
      (["shell", "compaction"].includes(row.type) && data.status === "running")
    )
      throw new Error(`Running message in ${id}; wait until settled`);
  }
}
function snapshot(db: SqliteDatabase, id: string, mappings: Mapping[]): Shard {
  assertSettled(db, id);
  const original = rows(db, "SELECT * FROM session_v2 WHERE id=?", id)[0]!;
  const project = rows(db, "SELECT * FROM project WHERE id=?", original.project_id)[0];
  if (!project) throw new Error("Missing V2 project");
  const reverse = mappings.map((m) => ({ from: m.to, to: m.from }));
  const portableID = "omds:" + digest(mapPath(project.worktree, reverse));
  const session = translateRow(original, reverse, original.project_id, portableID);
  // Local read markers, execution ownership and approval grants never travel.
  session.time_viewed = null;
  session.time_suspended = null;
  session.resume_attempts = 0;
  session.permission = null;
  const tables: Record<string, Row[]> = {};
  for (const table of TABLES) {
    const column = table === "event" || table === "event_sequence" ? "aggregate_id" : "session_id";
    tables[table] = rows(db, `SELECT * FROM ${table} WHERE ${column}=?`, id)
      .map((r) => {
        const row = translateRow(r, reverse, original.project_id, portableID);
        if (table === "event_sequence") row.owner_id = null;
        return row;
      })
      .sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
  }
  // Instruction state can reference content-addressed blobs. Copy only referenced hashes.
  const references = canonical({ session, tables });
  tables.instruction_blob = rows(db, "SELECT * FROM instruction_blob")
    .filter((r) => references.includes(r.hash))
    .sort((a, b) => String(a.hash).localeCompare(String(b.hash), "en"));
  return {
    formatVersion: 2,
    engine: "opencode-v2",
    schema: SCHEMA,
    session,
    project: { ...translateRow(project, reverse, original.project_id, portableID), id: portableID },
    tables,
  };
}
function hash(shard: Shard): string {
  return digest({ session: shard.session, tables: shard.tables });
}
function shardPath(repo: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Invalid V2 session id");
  return path.join(repo, SESSIONS_DIR, `${id}.json.gz`);
}
function baselines(file: string): Record<string, string> {
  const name = file + ".omds-v2-bases.json";
  if (!fs.existsSync(name)) return {};
  const data = JSON.parse(fs.readFileSync(name, "utf8"));
  if (data.version !== 2 || !data.hashes || typeof data.hashes !== "object")
    throw new Error("Invalid V2 conflict baseline");
  return data.hashes;
}
function saveBaselines(file: string, hashes: Record<string, string>): void {
  const name = file + ".omds-v2-bases.json";
  const temp = name + `.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 2, hashes }), { mode: 0o600 });
  fs.renameSync(temp, name);
}
function readShard(file: string): Shard {
  if (fs.statSync(file).size > 64 * 1024 * 1024)
    throw new Error("V2 compressed shard exceeds safety limit");
  const s = JSON.parse(
    gunzipSync(fs.readFileSync(file), { maxOutputLength: 128 * 1024 * 1024 }).toString("utf8"),
  ) as Shard;
  if (s.formatVersion !== 2 || s.engine !== "opencode-v2")
    throw new Error("Session format/generation mismatch: V1 and V2 must not mix");
  if (s.schema !== SCHEMA) throw new Error("V2 schema mismatch");
  if (
    !s.session ||
    typeof s.session.id !== "string" ||
    path.basename(file) !== path.basename(shardPath(path.dirname(file), s.session.id))
  )
    throw new Error("Invalid V2 session identity");
  if (
    !s.project ||
    s.project.id !== s.session.project_id ||
    !Number.isFinite(s.session.time_updated)
  )
    throw new Error("V2 project ownership mismatch");
  if (
    s.session.workspace_id != null ||
    s.session.time_suspended != null ||
    s.session.time_compacting != null ||
    s.session.permission != null
  )
    throw new Error("Unsafe V2 runtime state");
  if (!s.tables || typeof s.tables !== "object") throw new Error("Missing V2 tables");
  for (const required of [...TABLES, "instruction_blob"])
    if (!Array.isArray(s.tables[required])) throw new Error(`Missing V2 table ${required}`);
  for (const [table, values] of Object.entries(s.tables)) {
    if (![...TABLES, "instruction_blob"].includes(table) || !Array.isArray(values))
      throw new Error(`Unsupported V2 table ${table}`);
    const identities = new Set<string>();
    const sequences = new Set<number>();
    for (const row of values) {
      const owner = table === "event" || table === "event_sequence" ? "aggregate_id" : "session_id";
      if (
        !row ||
        typeof row !== "object" ||
        (table !== "instruction_blob" && row[owner] !== s.session.id)
      )
        throw new Error(`V2 row ownership mismatch in ${table}`);
      if (table === "event_sequence" && row.owner_id != null)
        throw new Error("V2 execution owner cannot be imported");
      const identity =
        table === "instruction_blob"
          ? row.hash
          : table === "instruction_entry"
            ? row.key
            : (row.id ?? row.session_id ?? row.aggregate_id);
      if (typeof identity !== "string" || identities.has(identity))
        throw new Error(`Duplicate or invalid V2 row identity in ${table}`);
      identities.add(identity);
      if (["session_message", "event", "event_sequence"].includes(table)) {
        if (!Number.isSafeInteger(row.seq) || row.seq < 0 || sequences.has(row.seq))
          throw new Error(`Invalid or duplicate V2 sequence in ${table}`);
        sequences.add(row.seq);
      }
    }
  }
  const sequence = s.tables.event_sequence!;
  const high = Math.max(
    0,
    ...[...s.tables.session_message!, ...s.tables.event!].map((r) => Number(r.seq)),
  );
  if (sequence.length !== 1 || !Number.isSafeInteger(sequence[0]!.seq) || sequence[0]!.seq < high)
    throw new Error("Invalid V2 event sequence watermark");
  validateBlobs(s);
  return s;
}
function validateBlobs(s: Shard): void {
  const blobs = new Map<string, string | null>();
  for (const blob of s.tables.instruction_blob!) {
    if (typeof blob.hash !== "string" || !/^[a-f0-9]{64}$/.test(blob.hash))
      throw new Error("Invalid instruction blob hash");
    const value = blob.value === null ? null : JSON.parse(blob.value);
    if (digest(value) !== blob.hash) throw new Error("Instruction blob hash/content mismatch");
    blobs.set(blob.hash, blob.value);
  }
  const requireValues = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid instruction blob references");
    for (const ref of Object.values(value)) {
      if (ref === null || ref === "removed") continue;
      if (typeof ref !== "string" || !blobs.has(ref))
        throw new Error("Referenced instruction blob is missing");
    }
  };
  for (const row of s.tables.instruction_state!) {
    requireValues(JSON.parse(row.initial_values));
    requireValues(JSON.parse(row.current_values));
  }
  for (const row of s.tables.event!) {
    if (String(row.type).includes("instructions.")) {
      const value = JSON.parse(row.data);
      if (value.delta) requireValues(value.delta);
    }
  }
}
function validateRow(db: SqliteDatabase, table: string, row: Row): void {
  const columns = rows(db, `PRAGMA table_info(${table})`);
  if (
    Object.keys(row).length !== columns.length ||
    columns.some((c) => !Object.hasOwn(row, c.name))
  )
    throw new Error(`V2 schema/column mismatch in ${table}`);
  for (const c of columns) {
    const value = row[c.name];
    if (value === null) {
      if (c.notnull || c.pk) throw new Error(`Missing V2 required column ${table}.${c.name}`);
      continue;
    }
    if (c.type.toLowerCase() === "integer" && !Number.isSafeInteger(value))
      throw new Error(`V2 integer column invalid: ${table}.${c.name}`);
    if (c.type.toLowerCase() === "real" && (typeof value !== "number" || !Number.isFinite(value)))
      throw new Error(`V2 real column invalid: ${table}.${c.name}`);
    if (c.type.toLowerCase() === "text" && typeof value !== "string")
      throw new Error(`V2 text column invalid: ${table}.${c.name}`);
    if (["data", "initial_values", "current_values"].includes(c.name)) JSON.parse(value);
  }
}
function selection(db: SqliteDatabase, options: SelectOptions): string[] {
  const ids = new Set(selectSessions(db, options).map((s) => s.id));
  const visiting = new Set<string>();
  const ordered: string[] = [];
  function visit(id: string) {
    if (ordered.includes(id)) return;
    if (visiting.has(id)) throw new Error("Cyclic V2 parent/fork references");
    if (options.exclude.includes(id))
      throw new Error("Selected V2 session depends on an excluded ancestor");
    visiting.add(id);
    const row = rows(db, "SELECT parent_id,fork_session_id FROM session_v2 WHERE id=?", id)[0];
    if (!row) throw new Error("Missing V2 parent/fork dependency");
    for (const dependency of [row.parent_id, row.fork_session_id])
      if (dependency) visit(dependency);
    visiting.delete(id);
    ordered.push(id);
  }
  for (const id of ids) visit(id);
  return ordered;
}
export async function exportV2(
  file: string,
  repo: string,
  options: SelectOptions,
  _reporter: Reporter,
): Promise<ExportResult> {
  const db = await openDatabase(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    assertSchema(db);
    const bases = baselines(file);
    const ids = selection(db, options);
    const result: ExportResult = {
      exportedHashes: {},
      written: [],
      skippedTooLarge: [],
      considered: ids.length,
      conflicts: [],
    };
    // Validate the whole export before writing a single shard.
    const plan = ids.map((id) => ({ id, data: snapshot(db, id, options.pathMappings) }));
    for (const item of plan) {
      const dest = shardPath(repo, item.id);
      if (fs.existsSync(dest)) {
        const previous = readShard(dest);
        if (hash(previous) !== hash(item.data) && bases[item.id] !== hash(previous)) {
          result.conflicts!.push(item.id);
          continue;
        }
        preserveRows(previous, item.data);
      }
      const bytes = gzipSync(Buffer.from(canonical(item.data)), { level: 9 });
      if (bytes.length > options.maxSessionBytes) {
        result.skippedTooLarge.push({
          id: item.id,
          title: String(item.data.session.title ?? ""),
          bytes: bytes.length,
        });
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(bytes)) {
        const temp = dest + `.${randomUUID()}.tmp`;
        fs.writeFileSync(temp, bytes, { mode: 0o600 });
        fs.renameSync(temp, dest);
      }
      result.written.push(item.id);
      result.exportedHashes![item.id] = hash(item.data);
    }
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
export async function acknowledgeV2(
  file: string,
  repo: string,
  exportedHashes?: Record<string, string>,
): Promise<void> {
  if (!exportedHashes) throw new Error("V2 acknowledgement requires an exported snapshot receipt");
  const bases = baselines(file);
  for (const [id, expected] of Object.entries(exportedHashes)) {
    const dest = shardPath(repo, id);
    if (!fs.existsSync(dest) || hash(readShard(dest)) !== expected)
      throw new Error(`V2 shard changed after export receipt: ${id}`);
    bases[id] = expected;
  }
  saveBaselines(file, bases);
}
function insert(db: SqliteDatabase, table: string, row: Row): void {
  const allowed = rows(db, `PRAGMA table_info(${table})`).map((r) => r.name);
  const keys = Object.keys(row);
  if (keys.some((k) => !allowed.includes(k))) throw new Error(`V2 schema mismatch in ${table}`);
  const quoted = keys.map((k) => `"${k}"`).join(",");
  const primary = rows(db, `PRAGMA table_info(${table})`)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => `"${c.name}"`)
    .join(",");
  if (!primary) throw new Error(`Missing primary key in V2 table ${table}`);
  if (table === "instruction_blob") {
    const existing = rows(db, "SELECT value FROM instruction_blob WHERE hash=?", row.hash)[0];
    if (existing && existing.value !== row.value)
      throw new Error("Immutable instruction blob content collision");
  }
  db.prepare(
    `INSERT INTO ${table} (${quoted}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT (${primary}) DO UPDATE SET ${keys.map((k) => `"${k}"=excluded."${k}"`).join(",")}`,
  ).run(...keys.map((k) => row[k]));
}
function preserveRows(local: Shard, remote: Shard): void {
  if (Number(remote.tables.event_sequence![0]?.seq) < Number(local.tables.event_sequence![0]?.seq))
    throw new Error("Incoming V2 event sequence would move backwards");
  for (const table of ["session_message", "event"]) {
    const key = "id";
    const incoming = new Map(remote.tables[table]!.map((r) => [r[key], r]));
    for (const row of local.tables[table]!) {
      const next = incoming.get(row[key]);
      if (!next || next.seq !== row.seq || canonical(next) !== canonical(row))
        throw new Error(`Incoming V2 snapshot would discard or rewrite local ${table} history`);
    }
  }
}
export async function importV2(
  file: string,
  repo: string,
  _reporter: Reporter,
  options: ImportOptions,
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    skippedOlder: 0,
    conflicts: [],
    failed: [],
    dryRun: options.dryRun ?? false,
  };
  let db: SqliteDatabase | undefined;
  let transaction = false;
  try {
    await assertOfflineV2(file, options.offlineConfirmed);
    if (options.dryRun) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omds-v2-preview-"));
      try {
        const copy = path.join(temp, "opencode.db");
        const saved = await createDatabaseBackup(file, path.join(temp, "backup"), 1);
        fs.copyFileSync(saved.path, copy);
        if (fs.existsSync(file + ".omds-v2-bases.json"))
          fs.copyFileSync(file + ".omds-v2-bases.json", copy + ".omds-v2-bases.json");
        return {
          ...(await importV2(copy, repo, _reporter, {
            ...options,
            dryRun: false,
            backupBeforeImport: false,
          })),
          dryRun: true,
        };
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
    const names = fs.existsSync(path.join(repo, SESSIONS_DIR))
      ? fs
          .readdirSync(path.join(repo, SESSIONS_DIR))
          .filter((n) => n.endsWith(".json.gz"))
          .sort()
      : [];
    const incoming = names.map((name) => ({
      name,
      shard: readShard(path.join(repo, SESSIONS_DIR, name)),
    }));
    db = await openDatabase(file, { readOnly: options.dryRun });
    db.exec(options.dryRun ? "BEGIN" : "BEGIN IMMEDIATE");
    transaction = true;
    assertSchema(db);
    const before = inspectDatabase(db);
    for (const { shard } of incoming) {
      validateRow(db, "session_v2", shard.session);
      validateRow(db, "project", shard.project);
      for (const [table, values] of Object.entries(shard.tables))
        for (const row of values) validateRow(db, table, row);
    }
    if (!before.ok) throw new Error(`Unsafe V2 database: ${healthProblems(before).join("; ")}`);
    const bases = baselines(file);
    const nextBases = { ...bases };
    const plan: typeof incoming = [];
    for (const item of incoming) {
      const id = item.shard.session.id;
      const remoteHash = hash(item.shard);
      if (rows(db, "SELECT 1 FROM session_v2 WHERE id=?", id).length) {
        const local = snapshot(db, id, options.pathMappings ?? []);
        const localHash = hash(local);
        if (localHash === remoteHash) {
          result.skippedOlder++;
          nextBases[id] = remoteHash;
          continue;
        }
        if (bases[id] === remoteHash) {
          result.skippedOlder++;
          continue;
        }
        if (!bases[id] || bases[id] !== localHash) {
          result.conflicts.push({
            sessionId: id,
            reason: "V2 histories diverged without a matching baseline",
          });
          continue;
        }
        preserveRows(local, item.shard);
      }
      plan.push(item);
      nextBases[id] = remoteHash;
    }
    if (result.conflicts.length) throw new Error("V2 conflicts: no sessions imported");
    const ordered: typeof plan = [];
    const visiting = new Set<string>();
    function visit(item: (typeof plan)[number]) {
      if (ordered.includes(item)) return;
      if (visiting.has(item.shard.session.id)) throw new Error("Cyclic V2 dependencies");
      visiting.add(item.shard.session.id);
      for (const id of [item.shard.session.parent_id, item.shard.session.fork_session_id]) {
        if (!id) continue;
        const ancestor = plan.find((i) => i.shard.session.id === id);
        if (ancestor) visit(ancestor);
        else if (!rows(db!, "SELECT 1 FROM session_v2 WHERE id=?", id).length)
          throw new Error("Missing V2 parent/fork dependency");
      }
      visiting.delete(item.shard.session.id);
      ordered.push(item);
    }
    plan.forEach(visit);
    if (!options.dryRun && plan.length && options.backupBeforeImport !== false)
      result.backup = (
        await createDatabaseBackup(file, undefined, options.backupRetention ?? 10)
      ).path;
    for (const { shard } of ordered) {
      const mappings = options.pathMappings ?? [];
      const directory = mapPath(shard.project.worktree, mappings);
      const project = rows(db, "SELECT * FROM project").find(
        (p) => mapPath(p.worktree, []).toLowerCase() === directory.toLowerCase(),
      );
      if (!project)
        throw new Error(`Initialize the destination V2 project before import: ${directory}`);
      const session = translateRow(shard.session, mappings, shard.project.id, project.id);
      const existing = rows(
        db,
        "SELECT time_viewed,permission FROM session_v2 WHERE id=?",
        session.id,
      )[0];
      session.time_viewed = existing?.time_viewed ?? null;
      session.permission = existing?.permission ?? null;
      if (options.dryRun) continue;
      insert(db, "session_v2", session);
      for (const table of [
        "instruction_blob",
        "event_sequence",
        "session_message",
        "instruction_entry",
        "instruction_state",
        "event",
      ]) {
        for (const original of shard.tables[table]!) {
          const row =
            table === "instruction_blob"
              ? original
              : translateRow(original, mappings, shard.project.id, project.id);
          const ownership =
            table === "event" || table === "event_sequence" ? "aggregate_id" : "session_id";
          if (["event", "session_message"].includes(table)) {
            const other = rows(db, `SELECT ${ownership} FROM ${table} WHERE id=?`, row.id)[0];
            if (other && other[ownership] !== session.id)
              throw new Error(`V2 row belongs to another session in ${table}`);
          }
          insert(db, table, row);
        }
      }
    }
    if (options.dryRun) db.exec("ROLLBACK");
    else {
      const after = inspectDatabase(db);
      if (!after.ok || after.sessions < before.sessions)
        throw new Error("V2 post-import integrity failed");
      db.exec("COMMIT");
      transaction = false;
      result.imported = plan.length;
      try {
        saveBaselines(file, nextBases);
      } catch (error) {
        result.failed.push({
          file: "<v2-baseline>",
          reason: `Database committed; baseline storage failed: ${(error as Error).message}. Stop syncing and recover the baseline before continuing.`,
        });
        return result;
      }
    }
    transaction = false;
    result.imported = plan.length;
    return result;
  } catch (error) {
    if (transaction) {
      db!.exec("ROLLBACK");
      transaction = false;
    }
    result.rolledBack = true;
    result.imported = 0;
    result.failed.push({ file: "<v2-transaction>", reason: (error as Error).message });
    return result;
  } finally {
    if (transaction) db?.exec("ROLLBACK");
    db?.close();
  }
}
