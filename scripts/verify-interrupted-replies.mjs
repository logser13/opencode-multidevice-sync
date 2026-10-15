import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { requireNewCompletedReply } from "./acceptance-reply.mjs";

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf("="); return [arg.slice(0, at), arg.slice(at + 1)];
}));
const root = path.resolve(flags["--root"]);
const report = JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8"));
assert.equal(report.passed, true);
assert.equal(report.modelRequests, 8, "Expected eight local model requests");
function reader(file) {
  assert(!fs.existsSync(file + "-journal"));
  assert(!fs.existsSync(file + "-wal") || fs.statSync(file + "-wal").size === 0);
  return new DatabaseSync(pathToFileURL(file).href + "?immutable=1", { readOnly: true });
}
const source = reader(path.resolve(flags["--source-fixture"]));
const A = reader(path.join(root, "A/data/opencode/opencode.db"));
const B = reader(path.join(root, "B/data/opencode/opencode.db"));
const completed = [];
try {
  const originals = report.source.targets;
  for (let i = 0; i < originals.length; i++) {
    const id = originals[i], target = report.continuedAtA[id].targetID;
    assert.equal(target, report.continuedAtB[id].targetID);
    const beforeIDs = source.prepare("SELECT id FROM session_message WHERE session_id=?").all(id);
    const messages = db => db.prepare("SELECT * FROM session_message WHERE session_id=? ORDER BY seq").all(target).map(r => ({ ...JSON.parse(r.data), id: r.id, type: r.type, seq: r.seq }));
    for (const [machine, db] of [["A", A], ["B", B]]) {
      const rows = messages(db);
      const bReply = requireNewCompletedReply({ messages: beforeIDs }, { messages: rows }, "ISOLATED_REPLY_" + (i + 1));
      const aReply = requireNewCompletedReply({ messages: rows.filter(r => r.seq <= bReply.seq) }, { messages: rows }, "ISOLATED_REPLY_" + (i + 5));
      for (const [phase, reply] of [["B", bReply], ["A", aReply]]) {
        assert(reply.time.completed >= Date.parse(report.started));
        completed.push({ replica: machine, phase, originalSessionID: id, sessionID: target, messageID: reply.id, completed: reply.time.completed });
      }
    }
  }
  assert.equal(new Set(completed.map(r => r.messageID)).size, 8);
} finally { source.close(); A.close(); B.close(); }
const result = { passed: true, completedResponses: 8, verifiedReplicas: 2, checks: completed };
fs.writeFileSync(path.join(root, "completed-replies.json"), JSON.stringify(result, null, 2) + "\n");
console.log("PASS eight new completed stub responses, preserved on both replicas");
