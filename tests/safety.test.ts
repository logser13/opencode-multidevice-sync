import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseBackup, restoreDatabaseBackup } from "../src/core/backup.js";
import { checkDatabaseHealth } from "../src/core/health.js";
import { silentReporter } from "../src/core/reporter.js";
import { acknowledgeExport, exportSessions, importSessions } from "../src/core/sessions.js";
import { openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

let root = "";
let available = false;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omds-safety-"));
  available = await sqliteAvailable();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function makeDb(file: string, directory = "/source"): Promise<void> {
  const db = await openDatabase(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
      directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE);`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
      data TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE);`);
  const now = Date.now();
  db.prepare("INSERT INTO project VALUES (?,?)").run("global", directory);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)").run(
    "ses_1",
    "global",
    "ses_1",
    directory,
    directory,
    "Session",
    "1",
    now,
    now,
  );
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("msg_1", "ses_1", "{}");
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("part_1", "ses_1", "msg_1", "{}");
  db.close();
}

const options = (pathMappings: Array<{ from: string; to: string }> = []) => ({
  enabled: true,
  days: 7,
  maxSessions: 50,
  maxSessionBytes: 5 * 1024 * 1024,
  include: [],
  exclude: [],
  directories: [],
  backupBeforeImport: false,
  backupRetention: 3,
  pathMappings,
  now: Date.now(),
});

describe("database safety", () => {
  it("creates a consistent backup and can restore it", async () => {
    expect(available, "SQLite is required: tests must actually execute").toBe(true);
    const file = path.join(root, "opencode.db");
    await makeDb(file);
    const backup = await createDatabaseBackup(file, path.join(root, "backups"), 3);
    expect(fs.existsSync(backup.path)).toBe(true);

    const db = await openDatabase(file);
    db.exec("DELETE FROM message; DELETE FROM part; DELETE FROM session;");
    db.close();
    const safetyCopy = await restoreDatabaseBackup(file, backup.path, { offlineConfirmed: true });
    expect(safetyCopy).toBeTruthy();

    const health = await checkDatabaseHealth(file);
    expect(health.ok).toBe(true);
    expect(health.sessions).toBe(1);
    expect(health.messages).toBe(1);
    expect(health.parts).toBe(1);
  });

  it("maps session paths without changing the local synthetic project", async () => {
    expect(available, "SQLite is required: tests must actually execute").toBe(true);
    const source = path.join(root, "source.db");
    const target = path.join(root, "target.db");
    const repo = path.join(root, "repo");
    await makeDb(source, "C:/source/project");
    await makeDb(target, "D:/local/project");
    fs.mkdirSync(repo);
    await exportSessions(source, repo, options(), silentReporter);

    const targetDb = await openDatabase(target);
    targetDb.exec("DELETE FROM message; DELETE FROM part; DELETE FROM session;");
    targetDb.close();
    const result = await importSessions(target, repo, silentReporter, {
      ...options([{ from: "C:/source", to: "D:/mapped" }]),
    });
    expect(result.failed).toEqual([]);

    const check = await openDatabase(target, { readOnly: true });
    const session = check
      .prepare("SELECT directory, path FROM session WHERE id='ses_1'")
      .all()[0] as any;
    const project = check.prepare("SELECT worktree FROM project WHERE id='global'").all()[0] as any;
    check.close();
    expect(session.directory).toBe("D:/mapped/project");
    expect(session.path).toBe("D:/mapped/project");
    expect(project.worktree).toBe("D:/local/project");
  });

  it("reports an equal-timestamp conflict instead of overwriting local metadata", async () => {
    expect(available, "SQLite is required: tests must actually execute").toBe(true);
    const source = path.join(root, "source-conflict.db");
    const target = path.join(root, "target-conflict.db");
    const repo = path.join(root, "repo-conflict");
    await makeDb(source);
    await makeDb(target);
    fs.mkdirSync(repo);
    await exportSessions(source, repo, options(), silentReporter);

    const src = await openDatabase(source, { readOnly: true });
    const time = Number(
      (src.prepare("SELECT time_updated FROM session WHERE id='ses_1'").all()[0] as any)
        .time_updated,
    );
    src.close();
    const db = await openDatabase(target);
    db.prepare("UPDATE session SET title=?, time_updated=? WHERE id='ses_1'").run(
      "Local version",
      time,
    );
    db.close();

    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.conflicts).toHaveLength(1);
    const check = await openDatabase(target, { readOnly: true });
    const title = (check.prepare("SELECT title FROM session WHERE id='ses_1'").all()[0] as any)
      .title;
    check.close();
    expect(title).toBe("Local version");
  });
});

async function fixture() {
  const source = path.join(root, "s.db");
  const target = path.join(root, "t.db");
  const repo = path.join(root, "r");
  await makeDb(source);
  fs.copyFileSync(source, target);
  fs.mkdirSync(repo);
  await exportSessions(source, repo, options(), silentReporter);
  await acknowledgeExport(source, repo);
  const first = await importSessions(target, repo, silentReporter, options());
  expect(first.failed).toEqual([]);
  return { source, target, repo };
}
async function change(file: string, title: string) {
  const db = await openDatabase(file);
  db.prepare("UPDATE session SET title=?,time_updated=time_updated+1").run(title);
  db.close();
}
function mutateShard(repo: string, mutate: (s: any) => void) {
  const p = path.join(repo, "_sessions", "ses_1.json.gz");
  const s = JSON.parse(gunzipSync(fs.readFileSync(p)).toString());
  mutate(s);
  fs.writeFileSync(p, gzipSync(JSON.stringify(s)));
}
describe("release hardening", () => {
  it("imports a one-sided change using a common baseline", async () => {
    const { source, target, repo } = await fixture();
    await change(source, "remote update");
    await exportSessions(source, repo, options(), silentReporter);
    const result = await importSessions(target, repo, silentReporter, { backupBeforeImport: true });
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);
    expect(fs.existsSync(result.backup ?? "")).toBe(true);
    expect((await checkDatabaseHealth(target)).ok).toBe(true);
  });
  it("detects edits on BOTH devices even with different timestamps", async () => {
    const { source, target, repo } = await fixture();
    await change(source, "remote");
    await change(source, "remote 2");
    await change(target, "local");
    await exportSessions(source, repo, options(), silentReporter);
    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.imported).toBe(0);
    expect(result.conflicts).toHaveLength(1);
  });
  it("detects changed message content with unchanged session metadata", async () => {
    const { target, repo } = await fixture();
    mutateShard(repo, (s) => {
      s.tables.message[0].data = '{"text":"remote edit"}';
    });
    const db = await openDatabase(target);
    db.prepare("UPDATE message SET data=?").run('{"text":"local edit"}');
    db.close();
    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.conflicts).toHaveLength(1);
  });
  it("rejects unknown shard tables and keeps the DB intact", async () => {
    const { target, repo } = await fixture();
    mutateShard(repo, (s) => {
      s.tables.project = [{ id: "other", session_id: "ses_1" }];
    });
    const before = fs.readFileSync(target);
    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.imported).toBe(0);
    expect(fs.readFileSync(target)).toEqual(before);
  });
  it("rejects cross-session rows", async () => {
    const { target, repo } = await fixture();
    mutateShard(repo, (s) => {
      s.tables.message[0].session_id = "foreign";
    });
    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.failed.length).toBeGreaterThan(0);
  });
  it("never updates local global project from legacy v1 shards", async () => {
    const { source, target, repo } = await fixture();
    await change(source, "remote");
    await exportSessions(source, repo, options(), silentReporter);
    mutateShard(repo, (s) => {
      s.project = { id: "global", worktree: "/unwanted-machine" };
    });
    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.failed).toEqual([]);
    const db = await openDatabase(target, { readOnly: true });
    expect(db.prepare("SELECT worktree FROM project").all()[0].worktree).toBe("/source");
    db.close();
  });
  it("rolls back the entire batch when an FK violation is introduced", async () => {
    const { source, target, repo } = await fixture();
    await change(source, "remote");
    await exportSessions(source, repo, options(), silentReporter);
    mutateShard(repo, (s) => {
      s.tables.part[0].message_id = "missing";
    });
    const result = await importSessions(target, repo, silentReporter, options());
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.imported).toBe(0);
    expect(result.rolledBack).toBe(true);
    expect((await checkDatabaseHealth(target)).ok).toBe(true);
  });
  it("previews an import without changing DB, baseline or creating backups", async () => {
    const { source, target, repo } = await fixture();
    await change(source, "remote");
    await exportSessions(source, repo, options(), silentReporter);
    const before = fs.readFileSync(target);
    const base = fs.readFileSync(target + ".omds-bases.json");
    const result = await importSessions(target, repo, silentReporter, { dryRun: true });
    expect(result.imported).toBe(1);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.readFileSync(target + ".omds-bases.json")).toEqual(base);
    expect(result.backup).toBeUndefined();
  });
  it("refuses restore unless offline is explicitly confirmed", async () => {
    const { target } = await fixture();
    await expect(restoreDatabaseBackup(target, "missing")).rejects.toThrow("offline");
  });
  it("does not delete WAL while refusing restore", async () => {
    const { target } = await fixture();
    fs.writeFileSync(target + "-wal", "keep");
    await expect(
      restoreDatabaseBackup(target, "missing", { offlineConfirmed: true }),
    ).rejects.toThrow("-wal");
    expect(fs.readFileSync(target + "-wal", "utf8")).toBe("keep");
    fs.rmSync(target + "-wal");
  });
  it("refuses corrupt backups without changing the target", async () => {
    const { target } = await fixture();
    const bad = path.join(root, "bad.db");
    const before = fs.readFileSync(target);
    fs.writeFileSync(bad, "not a database");
    await expect(restoreDatabaseBackup(target, bad, { offlineConfirmed: true })).rejects.toThrow();
    expect(fs.readFileSync(target)).toEqual(before);
  });
  it("backs up WAL-resident data consistently", async () => {
    const file = path.join(root, "wal.db");
    await makeDb(file);
    const db = await openDatabase(file);
    db.exec("PRAGMA journal_mode=WAL");
    db.prepare("UPDATE session SET title=?").run("committed in WAL");
    const backup = await createDatabaseBackup(file, path.join(root, "snapshots"), 2);
    const copied = await openDatabase(backup.path, { readOnly: true });
    expect(copied.prepare("SELECT title FROM session").all()[0].title).toBe("committed in WAL");
    copied.close();
    db.close();
  });
  it("converts mapped paths back to canonical paths on export", async () => {
    const { source, target, repo } = await fixture();
    await change(source, "remote");
    await exportSessions(source, repo, options(), silentReporter);
    const mapped = [{ from: "/source", to: "D:/local" }];
    const result = await importSessions(target, repo, silentReporter, {
      pathMappings: mapped,
      preferRemote: true,
      backupBeforeImport: false,
    });
    expect(result.failed).toEqual([]);
    await change(target, "target change");
    await exportSessions(target, repo, options(mapped), silentReporter);
    const shard = JSON.parse(
      gunzipSync(fs.readFileSync(path.join(repo, "_sessions", "ses_1.json.gz"))).toString(),
    );
    expect(shard.session.directory).toBe("/source");
  });
});
