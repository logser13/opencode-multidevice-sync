import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentReporter } from "../src/core/reporter.js";
import { exportSessions, importSessions } from "../src/core/sessions.js";
import { openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

const DAY = 24 * 60 * 60 * 1000;
let root = "";
let available = false;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omds-regression-"));
  available = await sqliteAvailable();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const opts = (now: number) => ({
  enabled: true,
  days: 7,
  maxSessions: 50,
  maxSessionBytes: 5 * 1024 * 1024,
  include: [],
  exclude: [],
  directories: [],
  backupBeforeImport: false,
  backupRetention: 10,
  pathMappings: [],
  now,
});
async function makeDb(file: string, now: number, worktree = "/source"): Promise<void> {
  const db = await openDatabase(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL,
      directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES project(id) ON DELETE CASCADE);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
      data TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE);`);
  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("global", worktree, now, now, "[]");
  for (const id of ["ses_a", "ses_b"]) {
    const updated = now - DAY;
    db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)").run(
      id,
      "global",
      id,
      "/work",
      "/work",
      id,
      "1.0.0",
      updated,
      updated,
    );
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
      `msg_${id}`,
      id,
      "{}",
      updated,
      updated,
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      `part_${id}`,
      id,
      `msg_${id}`,
      "{}",
      updated,
      updated,
    );
  }
  db.close();
}
describe("multi-device safety regressions", () => {
  it("keeps all sessions that share the synthetic global project", async () => {
    expect(available, "SQLite is required: tests must actually execute").toBe(true);
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const target = path.join(root, "target.sqlite");
    const repo = path.join(root, "repo");
    await makeDb(source, now);
    fs.mkdirSync(repo);
    await exportSessions(source, repo, opts(now), silentReporter);
    await makeDb(target, now, "/target-local");
    const targetDb = await openDatabase(target);
    targetDb.exec("DELETE FROM message; DELETE FROM part; DELETE FROM session;");
    targetDb.close();

    const result = await importSessions(target, repo, silentReporter);
    expect(result.failed).toEqual([]);
    const check = await openDatabase(target, { readOnly: true });
    const sessions = check.prepare("SELECT id FROM session ORDER BY id").all() as { id: string }[];
    const worktree = (
      check.prepare("SELECT worktree FROM project WHERE id='global'").all() as any[]
    )[0].worktree;
    check.close();
    expect(sessions.map((row) => row.id)).toEqual(["ses_a", "ses_b"]);
    expect(worktree).toBe("/target-local");
  });
  it("produces byte-identical shards when the session did not change", async () => {
    expect(available, "SQLite is required: tests must actually execute").toBe(true);
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    await makeDb(source, now);
    fs.mkdirSync(repo);
    await exportSessions(source, repo, opts(now), silentReporter);
    const shard = path.join(repo, "_sessions", "ses_a.json.gz");
    const before = fs.readFileSync(shard);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await exportSessions(source, repo, opts(now), silentReporter);
    expect(fs.readFileSync(shard).equals(before)).toBe(true);
  });

  it("never serializes machine-local metadata for project global", async () => {
    expect(available, "SQLite is required: tests must actually execute").toBe(true);
    const now = Date.now();
    const source = path.join(root, "source.sqlite");
    const repo = path.join(root, "repo");
    await makeDb(source, now, "/machine-a");
    fs.mkdirSync(repo);
    await exportSessions(source, repo, opts(now), silentReporter);
    const raw = gunzipSync(fs.readFileSync(path.join(repo, "_sessions", "ses_a.json.gz")));
    const shard = JSON.parse(raw.toString("utf8"));
    expect(shard.session.project_id).toBe("global");
    expect(shard.project).toBeUndefined();
    expect(shard.exportedAt).toBe(shard.session.time_updated);
  });
});
