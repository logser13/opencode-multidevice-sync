import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";

const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf("=");
    return [arg.slice(0, at), arg.slice(at + 1)];
  }),
);
assert(
  flags["--root"] && flags["--cli"],
  "Required: --root=<new disposable directory> --cli=<pinned opencode.exe>",
);
const root = path.resolve(flags["--root"]),
  exe = path.resolve(flags["--cli"]);
const pluginDirectory = path.resolve(flags["--plugin-dir"] ?? ".");
const { push, pull } = await import(
  pathToFileURL(path.join(pluginDirectory, "dist/core/sync.js")).href
);
const { DEFAULT_SETTINGS } = await import(
  pathToFileURL(path.join(pluginDirectory, "dist/core/settings.js")).href
);
assert(!fs.existsSync(root), "Acceptance root must be new; never overwrite an existing tree");
fs.mkdirSync(root, { recursive: true });
const report = {
  runtime: "2.0.29",
  platform: process.platform,
  started: new Date().toISOString(),
  checks: [],
  modelRequests: 0,
};
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const check = (name, details = {}) => {
  report.checks.push({ name, ...details });
  console.log("PASS " + name);
};
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const stub = http.createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
  assert.equal(body.model, "stub", "Only the isolated model may receive requests");
  report.modelRequests++;
  const text = "ISOLATED_REPLY_" + report.modelRequests;
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = {
      id: "chatcmpl-isolated",
      object: "chat.completion.chunk",
      created: 1,
      model: "stub",
    };
    for (const delta of [{ role: "assistant", content: text }, {}])
      res.write(
        "data: " +
          JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }],
          }) +
          "\n\n",
      );
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-isolated",
        object: "chat.completion",
        created: 1,
        model: "stub",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
});
stub.listen(0, "127.0.0.1");
await once(stub, "listening");
const stubURL = `http://127.0.0.1:${stub.address().port}/v1`;
const machines = {};
const children = new Set();
const settings = () => ({
  ...DEFAULT_SETTINGS,
  repo: { url: path.join(root, "remote.git"), branch: "main" },
  includeSkills: false,
  includeState: false,
  autoPullOnStartup: false,
  autoPushOnIdle: false,
  sessions: {
    ...DEFAULT_SETTINGS.sessions,
    enabled: true,
    days: 36500,
    maxSessions: 10000,
    maxSessionBytes: 128 * 1024 * 1024,
  },
});
function machine(name) {
  const home = path.join(root, name);
  const roots = {
    config: path.join(home, "config/opencode"),
    data: path.join(home, "data/opencode"),
    state: path.join(home, "state/opencode"),
    cache: path.join(home, "cache/opencode"),
    agents: path.join(home, "agents"),
  };
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /API_KEY|TOKEN|AUTH|^SYNC_|^OPENCODE_|^OPENAI_|^ANTHROPIC_|^DEEPSEEK_|^GEMINI_|^GOOGLE_|^XDG_/i.test(
        key,
      )
    )
      delete env[key];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "roaming"),
    LOCALAPPDATA: path.join(home, "local"),
    TEMP: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCODE_DB: path.join(roots.data, "opencode.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_SERVER_PASSWORD: "isolated-acceptance-only",
    OMDS_STUB_KEY: "isolated-not-a-real-key",
  });
  fs.mkdirSync(env.TEMP, { recursive: true });
  for (const [key, value] of Object.entries(roots)) env[`SYNC_${key.toUpperCase()}_ROOT`] = value;
  const config = {
    model: "omds-stub/stub",
    provider: {
      "omds-stub": {
        npm: "@ai-sdk/openai-compatible",
        name: "Isolated stub",
        options: { baseURL: stubURL, apiKey: "{env:OMDS_STUB_KEY}" },
        models: { stub: { name: "stub", limit: { context: 1000000, output: 1024 } } },
      },
    },
    permission: { "*": "deny" },
    plugin: [pathToFileURL(pluginDirectory).href],
  };
  fs.writeFileSync(path.join(roots.config, "opencode.json"), JSON.stringify(config));
  const m = { name, home, roots, project, env, settings: settings(), database: env.OPENCODE_DB };
  machines[name] = m;
  return m;
}
async function start(m) {
  const log = fs.openSync(path.join(m.home, "server.log"), "a");
  const child = spawn(exe, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: m.env,
    cwd: m.project,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  children.add(child);
  m.child = child;
  m.log = log;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const logText = fs.readFileSync(path.join(m.home, "server.log"), "utf8");
    const match = [...logText.matchAll(/server listening on (http:\/\/127\.0\.0\.1:\d+)/g)].at(-1);
    if (match) {
      const baseUrl = match[1];
      const headers = {
        authorization:
          "Basic " + Buffer.from("opencode:isolated-acceptance-only").toString("base64"),
      };
      m.client = OpenCode.make({
        baseUrl,
        headers,
        fetch: async (url, init) => {
          assert(new URL(String(url)).origin === baseUrl, "Client egress outside isolated server");
          return fetch(url, init);
        },
      });
      try {
        const info = await m.client.server.info();
        assert.equal(info.version, "2.0.29");
        assert.equal(info.pid, child.pid);
        return;
      } catch (e) {
        if (i === 119) throw e;
      }
    }
    if (child.exitCode !== null)
      throw new Error("OpenCode startup failed: " + logText.slice(-4000));
  }
  throw new Error("OpenCode did not become ready");
}
async function stop(m) {
  if (!m.child) return;
  const child = m.child;
  m.child = undefined;
  child.kill();
  if (child.exitCode === null) await once(child, "exit");
  children.delete(child);
  fs.closeSync(m.log);
  // Recover only the disposable test DB through SQLite, never by deleting journals.
  const db = new DatabaseSync(m.database);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of ["-wal", "-shm", "-journal"])
    assert(!fs.existsSync(m.database + suffix), "Sandbox DB still has a live journal");
}
async function initialize(m) {
  await start(m);
  await m.client.location.get({ location: { directory: m.project } });
  let plugins;
  for (let i = 0; i < 30; i++) {
    plugins = await m.client.plugin.list({ location: { directory: m.project } });
    if (plugins.data.length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(
    plugins.data.some((p) => p.id === "opencode-multidevice-sync" && p.state.status === "active"),
    "V2 host did not load OMDS: " + JSON.stringify(plugins),
  );
  await stop(m);
}
async function prompt(m, id, text) {
  await m.client.session.switchModel({
    sessionID: id,
    model: { id: "stub", providerID: "omds-stub" },
  });
  await m.client.session.prompt({ sessionID: id, text });
  await m.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(30000) });
  const data = await m.client.session.export({ sessionID: id });
  assert(
    data.messages.some(
      (msg) =>
        msg.type === "assistant" &&
        msg.content.some((c) => c.type === "text" && c.text.startsWith("ISOLATED_REPLY_")),
    ),
    "No completed local model response",
  );
  return data;
}
const options = (m) => ({ roots: m.roots, settings: m.settings, offlineConfirmed: true });
try {
  git(root, "init", "--bare", "remote.git");
  const A = machine("A"),
    B = machine("B");
  B.settings.sessions.pathMappings = [{ from: A.project, to: B.project }];
  if (flags["--source-db"]) {
    const source = path.resolve(flags["--source-db"]);
    assert(!source.startsWith(root + path.sep));
    const db = new DatabaseSync(source, { readOnly: true });
    await backup(db, A.database);
    db.close();
    // Remap only the copy before any OpenCode process sees its original directories.
    const copy = new DatabaseSync(A.database);
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    if (tables.includes("session")) {
      report.source = {
        sessions: Number(copy.prepare("SELECT count(*) AS n FROM session").get().n),
        messages: Number(copy.prepare("SELECT count(*) AS n FROM message").get().n),
        parts: Number(copy.prepare("SELECT count(*) AS n FROM part").get().n),
      };
      copy.prepare("UPDATE session SET directory=?").run(A.project.replaceAll("\\", "/"));
      copy
        .prepare("UPDATE project SET worktree=?,sandboxes='[]'")
        .run(A.project.replaceAll("\\", "/"));
    }
    copy.close();
    check("consistent read-only source snapshot", report.source);
  }
  await initialize(A);
  await initialize(B);
  check("real V2 plugin loaded on both isolated machines");
  if (report.source) {
    const copy = new DatabaseSync(A.database);
    const project = copy
      .prepare(
        "SELECT id FROM project WHERE worktree=? AND id!='global' ORDER BY time_active DESC LIMIT 1",
      )
      .get(A.project.replaceAll("\\", "/"));
    assert(project, "Isolated destination project not initialized");
    const sessions = copy.prepare("SELECT id FROM session_v2").all();
    report.migrated = {
      sessions: sessions.length,
      messages: Number(copy.prepare("SELECT count(*) AS n FROM session_message").get().n),
    };
    assert.equal(
      sessions.length,
      report.source.sessions,
      "V1 migration did not preserve every session",
    );
    // Fixture location rebinding avoids the known V1 synthetic-global project visibility bug.
    copy
      .prepare("UPDATE session_v2 SET project_id=?,directory=?")
      .run(project.id, A.project.replaceAll("\\", "/"));
    const excluded = new Map();
    for (const session of copy
      .prepare(
        "SELECT id,parent_id,fork_session_id,workspace_id,time_suspended,time_compacting FROM session_v2",
      )
      .all()) {
      if (session.workspace_id || session.time_suspended != null || session.time_compacting != null)
        excluded.set(session.id, "active or workspace-bound");
    }
    for (const row of copy.prepare("SELECT session_id,type,data FROM session_message").all()) {
      const data = JSON.parse(row.data);
      if (
        (row.type === "assistant" && data.time?.completed == null) ||
        (["shell", "compaction"].includes(row.type) && data.status === "running")
      )
        excluded.set(row.session_id, "historical unfinished message");
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of copy.prepare("SELECT id,parent_id,fork_session_id FROM session_v2").all())
        if (
          !excluded.has(row.id) &&
          (excluded.has(row.parent_id) || excluded.has(row.fork_session_id))
        ) {
          excluded.set(row.id, "depends on unsupported session");
          changed = true;
        }
    }
    A.settings.sessions.exclude = [...excluded.keys()];
    B.settings.sessions.exclude = [...excluded.keys()];
    report.excludedSourceSessions = [...excluded].map(([id, reason]) => ({ id, reason }));
    const excludedMessages = excluded.size
      ? Number(
          copy
            .prepare(
              `SELECT count(*) AS n FROM session_message WHERE session_id IN (${[...excluded].map(() => "?").join(",")})`,
            )
            .get(...excluded.keys()).n,
        )
      : 0;
    report.eligible = {
      sourceSessions: sessions.length - excluded.size,
      sourceMessages: report.migrated.messages - excludedMessages,
      excludedMessages,
    };
    copy.close();
    check("copied V1 histories migrated; fixture locations rebound", report.migrated);
  }
  await start(A);
  const parent = await A.client.session.create({
    title: "Isolated acceptance parent",
    location: { directory: A.project },
    model: { providerID: "omds-stub", id: "stub" },
  });
  const child = await A.client.session.create({
    title: "Isolated acceptance child",
    parentID: parent.id,
    location: { directory: A.project },
    model: { providerID: "omds-stub", id: "stub" },
  });
  const first = await prompt(A, parent.id, "Acceptance request from A");
  await prompt(A, child.id, "Acceptance child request from A");
  report.synthetic = { parent: parent.id, child: child.id, initialMessages: first.messages.length };
  await stop(A);
  check("native parent and child conversations completed against local stub");
  await push(options(A));
  // B has local machine config before linking; preserve it through overrides.
  fs.writeFileSync(
    path.join(B.roots.config, "opencode-sync.overrides.jsonc"),
    fs.readFileSync(path.join(B.roots.config, "opencode.json")),
  );
  await pull(options(B));
  check("A -> local Git -> B sessions imported");
  await start(B);
  const atB = await B.client.session.export({ sessionID: parent.id });
  assert.deepEqual(atB.messages, first.messages);
  assert.equal((await B.client.session.get({ sessionID: child.id })).parentID, parent.id);
  const listing = await B.client.session.list({ directory: B.project, limit: 1000 });
  assert(listing.data.some((s) => s.id === parent.id));
  const listingDB = new DatabaseSync(B.database, { readOnly: true });
  const expectedRoots = listingDB
    .prepare("SELECT id FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL")
    .all();
  listingDB.close();
  for (const row of expectedRoots)
    assert(
      listing.data.some((s) => s.id === row.id),
      "Imported root missing from native project listing: " + row.id,
    );
  check("all unarchived root sessions visible through native project listing", {
    roots: expectedRoots.length,
  });
  const second = await prompt(B, parent.id, "Acceptance continuation from B");
  assert(second.messages.length > first.messages.length);
  if (report.source) {
    const db = new DatabaseSync(B.database, { readOnly: true });
    const candidates = db
      .prepare("SELECT id FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated")
      .all()
      .map((r) => r.id)
      .filter((id) => id !== parent.id);
    db.close();
    assert(candidates.length, "No copied real session was transferred");
    const id = candidates[0];
    const before = await B.client.session.export({ sessionID: id });
    const after = await prompt(B, id, "Isolated continuation check on copied history");
    assert(after.messages.length > before.messages.length);
    report.realContinuation = {
      sessionID: id,
      before: before.messages.length,
      after: after.messages.length,
    };
    check("copied real history can continue on B with local stub", report.realContinuation);
  }
  await stop(B);
  check("B reads full history, lists project sessions and continues", {
    messages: second.messages.length,
  });
  // Pull preserves local append history when its remote baseline is unchanged.
  await push(options(B));
  await pull(options(A));
  check("B -> local Git -> A updated sessions imported");
  await start(A);
  const returned = await A.client.session.export({ sessionID: parent.id });
  assert.deepEqual(returned.messages, second.messages);
  const third = await prompt(A, parent.id, "Acceptance continuation after return to A");
  assert(third.messages.length > second.messages.length);
  await stop(A);
  check("A reads returned history and continues without sequence collisions", {
    messages: third.messages.length,
  });
  await push(options(A));
  await pull(options(B));
  const again = await pull(options(B));
  assert.equal(again.sessions?.imported, 0);
  check("repeated pull is idempotent");
  const beforeAuto = git(root, "--git-dir=remote.git", "rev-parse", "refs/heads/main");
  fs.writeFileSync(
    path.join(B.roots.config, "opencode-sync.jsonc"),
    JSON.stringify({ ...B.settings, autoPushOnIdle: true }),
  );
  await start(B);
  await prompt(B, parent.id, "Native idle auto-push smoke test");
  let pushed = false;
  for (let i = 0; i < 120; i++) {
    if (git(root, "--git-dir=remote.git", "rev-parse", "refs/heads/main") !== beforeAuto) {
      pushed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(pushed, "Native idle subscription did not push to the isolated local remote");
  // A changed remote ref proves send; wait for acknowledgement/lock cleanup before stopping its host.
  for (let i = 0; i < 120 && fs.existsSync(path.join(B.roots.config, ".opencode-sync.lock")); i++)
    await new Promise((r) => setTimeout(r, 250));
  assert(
    !fs.existsSync(path.join(B.roots.config, ".opencode-sync.lock")),
    "Native push did not release its lock",
  );
  await stop(B);
  await pull(options(A));
  check("packaged native idle event exports and pushes to local Git");
  const dbA = new DatabaseSync(A.database, { readOnly: true }),
    dbB = new DatabaseSync(B.database, { readOnly: true });
  const excluded = new Set(A.settings.sessions.exclude);
  const canonicalDB = (db) => ({
    sessions: db
      .prepare("SELECT id,parent_id,fork_session_id FROM session_v2 ORDER BY id")
      .all()
      .filter((r) => !excluded.has(r.id)),
    messages: db
      .prepare("SELECT id,session_id,type,seq,data FROM session_message ORDER BY session_id,seq")
      .all()
      .filter((r) => !excluded.has(r.session_id))
      .map((row) => ({ ...row, data: JSON.parse(row.data) })),
    sequences: db
      .prepare(
        "SELECT aggregate_id,seq FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session_v2) ORDER BY aggregate_id",
      )
      .all()
      .filter((r) => !excluded.has(r.aggregate_id)),
  });
  const left = canonicalDB(dbA),
    right = canonicalDB(dbB);
  assert.deepEqual(right, left);
  assert.equal(dbA.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(dbB.prepare("PRAGMA quick_check").get().quick_check, "ok");
  assert.equal(dbA.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(dbB.prepare("PRAGMA foreign_key_check").all().length, 0);
  report.final = {
    sessions: left.sessions.length,
    messages: left.messages.length,
    canonicalHash: hash(left),
  };
  dbA.close();
  dbB.close();
  check("complete session/message/sequence equality and SQLite integrity", report.final);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const m of Object.values(machines)) if (m.child) await stop(m).catch(() => {});
  for (const child of children) child.kill();
  stub.close();
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
}
