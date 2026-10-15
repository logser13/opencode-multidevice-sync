import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseBackup, restoreDatabaseBackup } from "../src/core/backup.js";
import { isV2Database } from "../src/core/database-generation.js";
import { checkDatabaseHealth } from "../src/core/health.js";
import { silentReporter } from "../src/core/reporter.js";
import {
  acknowledgeExport,
  exportSessions,
  importSessions,
  listSessions,
} from "../src/core/sessions.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { openDatabase } from "../src/core/sqlite.js";

const schema = fs.readFileSync(
  fileURLToPath(new URL("./fixtures/opencode-2.0.29.sql", import.meta.url)),
  "utf8",
);
let root: string;
let a: string;
let b: string;
let repo: string;
const select = {
  ...DEFAULT_SETTINGS.sessions,
  enabled: true,
  days: 36500,
  backupBeforeImport: false,
};
const offline = { offlineConfirmed: true, backupBeforeImport: false };

async function database(file: string, project = "p1", directory = "C:/app") {
  const db = await openDatabase(file);
  db.exec(schema);
  db.prepare(
    "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?,?,?,?,?)",
  ).run(project, directory, 1, 1, "[]");
  db.close();
}
async function addSession(file: string, id = "ses_one", parent: string | null = null) {
  const db = await openDatabase(file);
  db.prepare(
    "INSERT INTO session_v2 (id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, "p1", parent, id, "C:/app", id, "2.0.29", 1, Date.now());
  db.prepare("INSERT INTO event_sequence (aggregate_id,seq) VALUES (?,?)").run(id, 2);
  db.prepare(
    "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
  ).run(
    `msg_${id}`,
    id,
    "user",
    1,
    1,
    1,
    JSON.stringify({ text: "Original text", time: { created: 1 } }),
  );
  db.prepare("INSERT INTO event (id,aggregate_id,seq,type,data) VALUES (?,?,?,?,?)").run(
    `evt_${id}`,
    id,
    2,
    "session.next.created.1",
    JSON.stringify({ sessionID: id, projectID: "p1", location: { directory: "C:/app" } }),
  );
  db.close();
}
async function append(file: string, id = "msg_second") {
  const db = await openDatabase(file);
  db.prepare(
    "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)",
  ).run(
    id,
    "ses_one",
    "user",
    3,
    2,
    2,
    JSON.stringify({ text: "Reply from B", time: { created: 2 } }),
  );
  db.prepare("UPDATE event_sequence SET seq=4 WHERE aggregate_id='ses_one'").run();
  db.prepare("UPDATE session_v2 SET time_updated=? WHERE id='ses_one'").run(Date.now() + 100);
  db.close();
}
function shard(id = "ses_one") {
  return path.join(repo, "_sessions", `${id}.json.gz`);
}
function read(id = "ses_one") {
  return JSON.parse(gunzipSync(fs.readFileSync(shard(id))).toString());
}
function tamper(fn: (s: any) => void, id = "ses_one") {
  const value = read(id);
  fn(value);
  fs.writeFileSync(shard(id), gzipSync(JSON.stringify(value)));
}
async function exportAndAcknowledge(file: string) {
  const result = await exportSessions(file, repo, select, silentReporter);
  await acknowledgeExport(file, repo, [], result.exportedHashes);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omds-v2-"));
  a = path.join(root, "a.db");
  b = path.join(root, "b.db");
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  await database(a);
  await database(b);
  await addSession(a);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function instructions(file: string) {
  const value = JSON.stringify({ path: "C:/app" });
  const hash = createHash("sha256").update(value).digest("hex");
  const db = await openDatabase(file);
  db.prepare("INSERT INTO instruction_blob (hash,value) VALUES (?,?)").run(hash, value);
  db.prepare(
    "INSERT INTO instruction_state (session_id,epoch_start,through_seq,initial_values,current_values) VALUES (?,?,?,?,?)",
  ).run("ses_one", 1, 1, JSON.stringify({ key: hash }), JSON.stringify({ key: hash }));
  db.close();
  return { hash, value };
}

describe("V2 sessions", () => {
  it("acknowledges the exported snapshot when live state advances or excluded history is active", async () => {
    await addSession(a, "ses_excluded");
    const first = await exportSessions(a, repo, select, silentReporter);
    const db = await openDatabase(a);
    db.prepare("UPDATE session_v2 SET time_suspended=123 WHERE id='ses_excluded'").run();
    db.prepare("UPDATE session_v2 SET title='Updated during push' WHERE id='ses_one'").run();
    db.close();
    await acknowledgeExport(a, repo, [], first.exportedHashes);
    const next = await exportSessions(
      a,
      repo,
      { ...select, exclude: ["ses_excluded"] },
      silentReporter,
    );
    expect(next.conflicts).toEqual([]);
    expect(read().session.title).toBe("Updated during push");
    await acknowledgeExport(a, repo, [], next.exportedHashes);
    expect(JSON.parse(fs.readFileSync(a + ".omds-v2-bases.json", "utf8")).hashes.ses_one).toBe(
      next.exportedHashes?.ses_one,
    );
  });
  it("does not acknowledge a shard changed after its export receipt", async () => {
    const result = await exportSessions(a, repo, select, silentReporter);
    tamper((s) => {
      s.session.title = "Different shard";
    });
    await expect(acknowledgeExport(a, repo, [], result.exportedHashes)).rejects.toThrow(
      /changed.*export|receipt/i,
    );
    expect(fs.existsSync(a + ".omds-v2-bases.json")).toBe(false);
  });
  it("preserves historical tool-like paths inside message metadata across Windows mapping", async () => {
    const data = {
      text: "Original text",
      time: { created: 1 },
      metadata: { path: "C:\\app\\important.ts", directory: "C:\\literal\\keep" },
    };
    const db = await openDatabase(a);
    db.prepare("UPDATE session_message SET data=?").run(JSON.stringify(data));
    db.close();
    const other = await openDatabase(b);
    other.prepare("UPDATE project SET worktree='D:/work/app'").run();
    other.close();
    await exportSessions(a, repo, select, silentReporter);
    const result = await importSessions(b, repo, silentReporter, {
      ...offline,
      pathMappings: [{ from: "C:/app", to: "D:/work/app" }],
    });
    expect(result.failed).toEqual([]);
    const imported = await openDatabase(b, { readOnly: true });
    expect(JSON.parse(imported.prepare("SELECT data FROM session_message").all()[0]!.data)).toEqual(
      data,
    );
    imported.close();
  });
  it("accepts the equivalent append-column layout created by real V1 migration", async () => {
    const db = await openDatabase(b);
    db.exec(
      "ALTER TABLE project DROP COLUMN time_archived; ALTER TABLE project ADD COLUMN time_archived integer",
    );
    db.close();
    await exportSessions(a, repo, select, silentReporter);
    const result = await importSessions(b, repo, silentReporter, offline);
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);
  });
  it("rejects newer unverified migration lineage even if columns are unchanged", async () => {
    const db = await openDatabase(a);
    db.exec(
      "CREATE TABLE migration (id text); INSERT INTO migration VALUES ('20990101000000_unknown')",
    );
    db.close();
    await expect(exportSessions(a, repo, select, silentReporter)).rejects.toThrow(
      /migration|schema/i,
    );
  });
  it("detects an offline WAL database without manufacturing live journals", async () => {
    const db = await openDatabase(b);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
    expect(fs.existsSync(b + "-wal")).toBe(false);
    expect(await isV2Database(b)).toBe(true);
    expect(fs.existsSync(b + "-wal")).toBe(false);
    expect(fs.existsSync(b + "-shm")).toBe(false);
  });
  it("can pull after a read-only export leaves an empty WAL on a stopped DB", async () => {
    const db = await openDatabase(b);
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
    await exportSessions(a, repo, select, silentReporter);
    const reader = await openDatabase(b, { readOnly: true });
    reader.prepare("SELECT id FROM session_v2").all();
    reader.close();
    expect(fs.statSync(b + "-wal").size).toBe(0);
    const result = await importSessions(b, repo, silentReporter, offline);
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);
  });
  it("preserves immutable instruction blobs across path mappings", async () => {
    const blob = await instructions(a);
    const db = await openDatabase(b);
    db.prepare("UPDATE project SET id='p2',worktree='D:/work/app'").run();
    db.close();
    await exportSessions(a, repo, select, silentReporter);
    const result = await importSessions(b, repo, silentReporter, {
      ...offline,
      pathMappings: [{ from: "C:/app", to: "D:/work/app" }],
    });
    expect(result.failed).toEqual([]);
    const imported = await openDatabase(b, { readOnly: true });
    expect(
      imported.prepare("SELECT value FROM instruction_blob WHERE hash=?").all(blob.hash),
    ).toEqual([{ value: blob.value }]);
    imported.close();
  });
  it("rejects missing instruction blobs before committing any history", async () => {
    await instructions(a);
    await exportSessions(a, repo, select, silentReporter);
    tamper((s) => {
      s.tables.instruction_blob = [];
    });
    const result = await importSessions(b, repo, silentReporter, offline);
    expect(result.imported).toBe(0);
    expect(result.failed[0]?.reason).toMatch(/blob/i);
  });
  it("rejects duplicate event sequence numbers and nonnumeric message sequences", async () => {
    await exportSessions(a, repo, select, silentReporter);
    tamper((s) => {
      s.tables.event.push({ ...s.tables.event[0], id: "evt_replacement" });
    });
    expect((await importSessions(b, repo, silentReporter, offline)).failed[0]?.reason).toMatch(
      /duplicate|sequence/i,
    );
    await exportSessions(a, path.join(root, "clean"), select, silentReporter);
    fs.copyFileSync(path.join(root, "clean/_sessions/ses_one.json.gz"), shard());
    tamper((s) => {
      s.tables.session_message[0].seq = "invalid";
    });
    expect((await importSessions(b, repo, silentReporter, offline)).failed[0]?.reason).toMatch(
      /sequence|integer/i,
    );
  });
  it("validates unknown columns in direct import dry run", async () => {
    await exportSessions(a, repo, select, silentReporter);
    tamper((s) => {
      s.tables.session_message[0].future_column = "invalid";
    });
    const result = await importSessions(b, repo, silentReporter, { ...offline, dryRun: true });
    expect(result.imported).toBe(0);
    expect(result.failed[0]?.reason).toMatch(/schema|column/i);
    expect(await listSessions(b, 10)).toEqual([]);
  });
  it("reports a committed DB accurately if baseline storage fails", async () => {
    await exportSessions(a, repo, select, silentReporter);
    const original = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(".omds-v2-bases.json"))
        throw new Error("injected baseline storage failure");
      return original(from, to);
    });
    try {
      const result = await importSessions(b, repo, silentReporter, offline);
      expect(result.imported).toBe(1);
      expect(result.rolledBack).not.toBe(true);
      expect(result.failed[0]?.reason).toMatch(/committed.*baseline/i);
      expect((await listSessions(b, 10)).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("invalidates V2 baselines on restore and prevents exporting a shorter history", async () => {
    const backup = await createDatabaseBackup(a, path.join(root, "backup"), 1);
    await exportAndAcknowledge(a);
    await append(a);
    await exportAndAcknowledge(a);
    const remote = fs.readFileSync(shard());
    await restoreDatabaseBackup(a, backup.path, { offlineConfirmed: true });
    expect(fs.existsSync(a + ".omds-v2-bases.json")).toBe(false);
    const result = await exportSessions(a, repo, select, silentReporter);
    expect(result.conflicts).toEqual(["ses_one"]);
    expect(fs.readFileSync(shard())).toEqual(remote);
  });
  it("exports real V2 sessions even when legacy tables coexist", async () => {
    const db = await openDatabase(a);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    db.close();
    const result = await exportSessions(a, repo, select, silentReporter);
    expect(result.written).toEqual(["ses_one"]);
    expect(read().formatVersion).toBe(2);
    expect(read().tables.session_message[0].data).toContain("Original text");
    expect((await listSessions(a, 10))[0]?.id).toBe("ses_one");
    expect((await checkDatabaseHealth(a)).sessions).toBe(1);
  });
  it("round trips A to B to A with stable bytes, sequence and complete history", async () => {
    await exportAndAcknowledge(a);
    const first = fs.readFileSync(shard());
    expect((await importSessions(b, repo, silentReporter, offline)).imported).toBe(1);
    await exportSessions(b, repo, select, silentReporter);
    expect(fs.readFileSync(shard())).toEqual(first);
    await append(b);
    await exportAndAcknowledge(b);
    expect((await importSessions(a, repo, silentReporter, offline)).imported).toBe(1);
    const db = await openDatabase(a, { readOnly: true });
    expect(
      db
        .prepare("SELECT id FROM session_message ORDER BY seq")
        .all()
        .map((r) => r.id),
    ).toEqual(["msg_ses_one", "msg_second"]);
    expect(
      db.prepare("SELECT seq,owner_id FROM event_sequence WHERE aggregate_id='ses_one'").all(),
    ).toEqual([{ seq: 4, owner_id: null }]);
    db.close();
    expect((await importSessions(a, repo, silentReporter, offline)).imported).toBe(0);
  });
  it("requires offline confirmation and refuses live journal files", async () => {
    await exportSessions(a, repo, select, silentReporter);
    expect((await importSessions(b, repo, silentReporter)).failed[0]?.reason).toMatch(/offline/i);
    fs.writeFileSync(b + "-wal", "live");
    expect((await importSessions(b, repo, silentReporter, offline)).failed[0]?.reason).toMatch(
      /journal|wal/i,
    );
    fs.unlinkSync(b + "-wal");
    expect(await listSessions(b, 10)).toEqual([]);
  });
  it("includes ancestors outside selection to retain child and fork references", async () => {
    await addSession(a, "ses_child", "ses_one");
    await exportSessions(
      a,
      repo,
      { ...select, include: ["ses_child"], maxSessions: 0 },
      silentReporter,
    );
    expect(fs.existsSync(shard("ses_one"))).toBe(true);
    expect((await importSessions(b, repo, silentReporter, offline)).imported).toBe(2);
  });
  it("refuses export while execution or inbox input is pending", async () => {
    const db = await openDatabase(a);
    db.prepare("UPDATE session_v2 SET time_suspended=123").run();
    db.close();
    await expect(exportSessions(a, repo, select, silentReporter)).rejects.toThrow(
      /active|running|execution/i,
    );
    expect(fs.existsSync(shard())).toBe(false);
  });
  it("rejects unknown schema rather than silently dropping columns", async () => {
    await exportSessions(a, repo, select, silentReporter);
    const db = await openDatabase(b);
    db.exec("ALTER TABLE session_v2 ADD future_column TEXT");
    db.close();
    expect((await importSessions(b, repo, silentReporter, offline)).failed[0]?.reason).toMatch(
      /schema/i,
    );
  });
  it("rolls back the whole batch on a foreign-owned row", async () => {
    await addSession(a, "ses_two");
    await exportSessions(a, repo, select, silentReporter);
    tamper((s) => {
      s.tables.session_message[0].session_id = "ses_intruder";
    }, "ses_two");
    const result = await importSessions(b, repo, silentReporter, offline);
    expect(result.imported).toBe(0);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(await listSessions(b, 10)).toEqual([]);
  });
  it("rejects divergent edits without overwriting either history", async () => {
    await exportAndAcknowledge(a);
    await importSessions(b, repo, silentReporter, offline);
    await append(a, "msg_from_a");
    await append(b, "msg_from_b");
    await exportSessions(b, repo, select, silentReporter);
    const result = await importSessions(a, repo, silentReporter, offline);
    expect(result.conflicts).toHaveLength(1);
    expect(result.imported).toBe(0);
    const db = await openDatabase(a, { readOnly: true });
    expect(db.prepare("SELECT id FROM session_message WHERE seq=3").all()).toEqual([
      { id: "msg_from_a" },
    ]);
    db.close();
  });
  it("maps Windows paths and binds to the initialized destination project", async () => {
    const db = await openDatabase(b);
    db.prepare("UPDATE project SET id='p2',worktree='D:/work/app'").run();
    db.close();
    await exportSessions(a, repo, select, silentReporter);
    const mappings = [{ from: "C:/app", to: "D:/work/app" }];
    const result = await importSessions(b, repo, silentReporter, {
      ...offline,
      pathMappings: mappings,
    });
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);
    expect((await listSessions(b, 10))[0]).toMatchObject({
      directory: "D:/work/app",
      projectId: "p2",
    });
    const first = fs.readFileSync(shard());
    await exportSessions(b, repo, { ...select, pathMappings: mappings }, silentReporter);
    expect(fs.readFileSync(shard())).toEqual(first);
  });
  it("rejects V1 shards in V2 without invoking the one-time migration", async () => {
    fs.mkdirSync(path.join(repo, "_sessions"));
    fs.writeFileSync(
      shard(),
      gzipSync(
        JSON.stringify({
          formatVersion: 1,
          session: { id: "ses_one", time_updated: 1 },
          tables: {},
        }),
      ),
    );
    const result = await importSessions(b, repo, silentReporter, offline);
    expect(result.failed[0]?.reason).toMatch(/V1|generation|format/i);
    expect(await listSessions(b, 10)).toEqual([]);
  });
});
