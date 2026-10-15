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
import { requireNewCompletedReply } from "./acceptance-reply.mjs";

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
        models: { stub: { name: "stub", limit: { context: 1000000000, output: 1024 } } },
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
        connection: "close",
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
        await m.client.location.get({ location: { directory: m.project } });
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
  const before = await m.client.session.export({ sessionID: id });
  const requestNumber = report.modelRequests + 1;
  await m.client.session.switchModel({
    sessionID: id,
    model: { id: "stub", providerID: "omds-stub" },
  });
  await m.client.session.prompt({ sessionID: id, text });
  await m.client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(90000) });
  const data = await m.client.session.export({ sessionID: id });
  assert.equal(report.modelRequests, requestNumber, "Expected one local model request per prompt");
  const reply = requireNewCompletedReply(before, data, "ISOLATED_REPLY_" + requestNumber);
  (report.completedReplies ??= []).push({ machine: m.name, sessionID: id, messageID: reply.id, completed: reply.time.completed, marker: "ISOLATED_REPLY_" + requestNumber });
  return data;
}
const diagnostic = JSON.parse(fs.readFileSync(path.resolve(flags["--manifest"]), "utf8"));
const ids = diagnostic.sessions.map((s) => s.id);
const tail = diagnostic.sessions.find((s) =>
  s.unfinished.some((m) => m.laterCompletedAssistants === 0),
);
assert(tail, "Expected one interrupted tail for the immutable-fork continuation check");
const tailMessage = tail.unfinished.find((m) => m.laterCompletedAssistants === 0).id;
assert.equal(new Set(ids).size, 4, "Provide exactly four isolated diagnostic targets");
const fixture = path.resolve(flags["--source-fixture"]);
const allowed = path.resolve("..") + path.sep;
assert(
  fixture.toLowerCase().startsWith(allowed.toLowerCase()),
  "Source must be an existing disposable work fixture",
);
assert(!fixture.toLowerCase().startsWith((root + path.sep).toLowerCase()));
const options = (m) => ({ roots: m.roots, settings: m.settings, offlineConfirmed: true });
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const contentHash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
async function fileHash(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
function closedReader(file) {
  assert(!fs.existsSync(file + "-journal"), "Rollback journal in source fixture");
  assert(
    !fs.existsSync(file + "-wal") || fs.statSync(file + "-wal").size === 0,
    "Pending WAL in source fixture",
  );
  return new DatabaseSync(pathToFileURL(file).href + "?immutable=1", { readOnly: true });
}
function capture(m, prefix, selected = ids) {
  const db = m.child ? new DatabaseSync(m.database, { readOnly: true }) : closedReader(m.database);
  try {
    db.exec("BEGIN");
    const result = {};
    for (const id of selected) {
      const rows = db
        .prepare("SELECT * FROM session_message WHERE session_id=? ORDER BY seq")
        .all(id)
        .map((r) => ({ ...r, data: JSON.parse(r.data) }));
      const partial = rows
        .filter((r) => r.type === "assistant" && r.data.time?.completed == null)
        .map((r) => ({ id: r.id, seq: r.seq, hash: contentHash(r) }));
      result[id] = { messages: rows.length, historyHash: contentHash(rows), unfinished: partial };
      if (prefix?.[id]) {
        const before = prefix[id];
        assert(rows.length >= before.messages, "History shortened: " + id);
        assert.equal(
          contentHash(rows.slice(0, before.messages)),
          before.historyHash,
          "An original message was changed or lost: " + id,
        );
        assert.equal(
          contentHash(partial),
          contentHash(before.unfinished),
          "Interrupted records changed: " + id,
        );
      }
    }
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}
function integrity(m) {
  const db = closedReader(m.database);
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
  }
}
const apiHash = (data) => contentHash(data.messages);
async function cliOfflinePush(m) {
  fs.writeFileSync(path.join(m.roots.config, "opencode-sync.jsonc"), JSON.stringify(m.settings));
  const r = spawnSync(
    process.execPath,
    [path.join(pluginDirectory, "dist/cli/index.js"), "push", "--offline"],
    {
      env: m.env,
      cwd: m.project,
      encoding: "utf8",
      windowsHide: true,
      timeout: 300000,
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  fs.writeFileSync(path.join(m.home, "cli-push.log"), r.stdout + "\n" + r.stderr);
  assert.equal(r.status, 0, "Isolated CLI offline push failed; inspect the private fixture log");
}
try {
  git(root, "init", "--bare", "remote.git");
  const A = machine("A"),
    B = machine("B");
  for (const m of [A, B])
    Object.assign(m.settings.sessions, { maxSessions: 0, include: [...ids], exclude: [] });
  B.settings.sessions.pathMappings = [{ from: A.project, to: B.project }];
  const sourceHash = await fileHash(fixture);
  const reader = closedReader(fixture);
  try {
    await backup(reader, A.database);
  } finally {
    reader.close();
  }
  report.source = {
    kind: "previous isolated migrated V2 fixture",
    sha256: sourceHash,
    targets: ids,
  };
  const initial = capture(A);
  report.original = initial;
  assert.equal(
    Object.values(initial).reduce((n, r) => n + r.messages, 0),
    7669,
  );
  assert.equal(
    Object.values(initial).reduce((n, r) => n + r.unfinished.length, 0),
    5,
  );
  check("consistent copy of the existing isolated fixture; all 7669 original messages captured");
  await initialize(A);
  await initialize(B);
  capture(A, initial);
  const db = new DatabaseSync(A.database);
  const project = db
    .prepare(
      "SELECT id FROM project WHERE worktree=? AND id!='global' ORDER BY time_active DESC LIMIT 1",
    )
    .get(A.project.replaceAll("\\", "/"));
  assert(project);
  for (const id of ids)
    db.prepare("UPDATE session_v2 SET project_id=?,directory=? WHERE id=?").run(
      project.id,
      A.project.replaceAll("\\", "/"),
      id,
    );
  db.close();
  capture(A, initial);
  check(
    "native V2 initialization leaves all original history unchanged; only fixture project bindings rebound",
  );
  const originalApi = {};
  await start(A);
  for (const id of ids) {
    const data = await A.client.session.export({ sessionID: id });
    originalApi[id] = { messages: data.messages.length, hash: apiHash(data) };
  }
  capture(A, initial);
  await stop(A);
  report.originalNativeApi = originalApi;
  check("all four histories readable through the native source API");
  await cliOfflinePush(A);
  fs.writeFileSync(
    path.join(B.roots.config, "opencode-sync.overrides.jsonc"),
    fs.readFileSync(path.join(B.roots.config, "opencode.json")),
  );
  const intoB = await pull(options(B));
  assert.equal(intoB.sessions.imported, 4);
  capture(B, initial);
  check(
    "A -> local bare Git -> B preserves every original raw message and five incomplete records",
  );
  const continuedAtB = {};
  let forkID;
  await start(B);
  const listed = await B.client.session.list({ directory: B.project, limit: 1000 });
  for (const id of ids)
    assert(
      listed.data.some((s) => s.id === id),
      "Missing native project session " + id,
    );
  for (const id of ids) {
    const before = await B.client.session.export({ sessionID: id });
    assert.equal(
      apiHash(before),
      originalApi[id].hash,
      "Native API visibility changed on B: " + id,
    );
    let targetID = id;
    if (id === tail.id) {
      const fork = await B.client.session.fork({ sessionID: id, before: tailMessage });
      forkID = fork.id;
      targetID = fork.id;
      for (const m of [A, B]) m.settings.sessions.include.push(forkID);
      report.fork = {
        originalSessionID: id,
        beforeMessageID: tailMessage,
        sessionID: forkID,
        reason:
          "Native same-ID continuation completes the historical tail timestamp; fork retains the immutable original",
      };
      capture(B, initial);
    }
    const targetBefore =
      targetID === id ? before : await B.client.session.export({ sessionID: targetID });
    const after = await prompt(
      B,
      targetID,
      "Isolated continuation of interrupted legacy history on B",
    );
    assert(after.messages.length > targetBefore.messages.length);
    capture(B, initial);
    continuedAtB[id] = { targetID, messages: after.messages.length, hash: apiHash(after) };
    check("copied history continues on B without rewriting its original prefix", { sessionID: id });
  }
  await stop(B);
  report.continuedAtB = continuedAtB;
  await push(options(B));
  const intoA = await pull(options(A));
  assert(intoA.sessions.imported >= 4 && intoA.sessions.imported <= 5);
  capture(A, initial);
  check("B -> local bare Git -> A preserves all original messages and new B responses");
  const continuedAtA = {};
  await start(A);
  for (const id of ids) {
    const targetID = continuedAtB[id].targetID;
    const before = await A.client.session.export({ sessionID: targetID });
    assert.equal(apiHash(before), continuedAtB[id].hash, "Native B response missing on A: " + id);
    const after = await prompt(
      A,
      targetID,
      "Isolated continuation after returning the interrupted history to A",
    );
    assert(after.messages.length > before.messages.length);
    capture(A, initial);
    continuedAtA[id] = { targetID, messages: after.messages.length, hash: apiHash(after) };
    check("returned history continues on A without rewriting its original prefix", {
      sessionID: id,
    });
  }
  await stop(A);
  report.continuedAtA = continuedAtA;
  await push(options(A));
  await pull(options(B));
  const again = await pull(options(B));
  assert.equal(again.sessions.imported, 0);
  const allIDs = [...ids, forkID];
  const finalA = capture(A, initial, allIDs),
    finalB = capture(B, initial, allIDs);
  assert.equal(
    contentHash(finalA),
    contentHash(finalB),
    "Final complete message history differs between A and B",
  );
  const { exportSessions } = await import(
    pathToFileURL(path.join(pluginDirectory, "dist/core/sessions.js")).href
  );
  const { silentReporter } = await import(
    pathToFileURL(path.join(pluginDirectory, "dist/core/reporter.js")).href
  );
  const proofA = await exportSessions(
    A.database,
    path.join(root, "proof-A"),
    { ...A.settings.sessions, offlineConfirmed: true },
    silentReporter,
  );
  const proofB = await exportSessions(
    B.database,
    path.join(root, "proof-B"),
    { ...B.settings.sessions, offlineConfirmed: true },
    silentReporter,
  );
  assert.equal(proofA.written.length, 5);
  assert.equal(proofB.written.length, 5);
  assert.equal(
    contentHash(proofA.exportedHashes),
    contentHash(proofB.exportedHashes),
    "Session/events/instruction snapshots differ",
  );
  integrity(A);
  integrity(B);
  const all = await exportSessions(
    A.database,
    path.join(root, "all-source-export"),
    {
      ...A.settings.sessions,
      include: [],
      maxSessions: 10000,
      exclude: [],
      offlineConfirmed: true,
    },
    silentReporter,
  );
  assert.equal(all.skippedTooLarge.length, 0);
  assert.equal(all.conflicts.length, 0);
  const allDB = closedReader(A.database);
  const allCount = allDB.prepare("SELECT count(*) AS n FROM session_v2").get().n;
  allDB.close();
  assert.equal(all.written.length, allCount);
  await assert.rejects(
    exportSessions(
      A.database,
      path.join(root, "blocked-live-export"),
      A.settings.sessions,
      silentReporter,
    ),
    /running|interrupted|offline/i,
  );
  assert.equal(await fileHash(fixture), sourceHash, "Source fixture changed");
  report.final = {
    originalSessions: 4,
    continuationForks: 1,
    sessions: 5,
    originalMessages: 7669,
    messages: Object.values(finalA).reduce((n, r) => n + r.messages, 0),
    unchangedIncompleteRecords: 5,
    historyHash: contentHash(finalA),
    snapshotHash: contentHash(proofA.exportedHashes),
    allSourceSessionsExported: allCount,
    idempotent: true,
    sourceFixtureUnchanged: true,
    sqliteIntegrity: true,
  };
  report.finalBySession = finalA;
  check(
    "A/B full session/message/event/instruction equality, idempotence and SQLite integrity",
    report.final,
  );
  check(
    "all source fixture sessions export without exclusions; default live export remains blocked",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack ?? error);
  report.childState = Object.fromEntries(
    Object.values(machines).map((m) => [
      m.name,
      m.child
        ? { pid: m.child.pid, exitCode: m.child.exitCode, signalCode: m.child.signalCode }
        : null,
    ]),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const m of Object.values(machines)) if (m.child) await stop(m).catch(() => {});
  for (const child of children) child.kill();
  stub.close();
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
}
