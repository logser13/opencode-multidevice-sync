import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import type { Settings } from "./settings.js";
export function assertPrivateRemote(remote: string, settings: Settings): void {
  if (!settings.sessions.enabled && !settings.includeCredentials) return;
  if (path.isAbsolute(remote) || remote.startsWith("file://")) return; // Local test/development repository.
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (!match)
    throw new Error(
      "Sensitive sync requires a verified private GitHub repo (or local development remote)",
    );
  const check = spawnSync(
    "gh",
    ["repo", "view", `${match[1]}/${match[2]}`, "--json", "visibility", "--jq", ".visibility"],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  if (check.status !== 0 || check.stdout.trim() !== "PRIVATE")
    throw new Error(
      "Cannot verify PRIVATE repository; sync blocked. Check gh authentication and repository visibility.",
    );
}
export function assertSafeTrackedFiles(root: string, settings: Settings): void {
  const files = git(["ls-files", "-z"], { cwd: root });
  if (!files.ok) throw new Error("Cannot inspect staged file list");
  for (const name of files.stdout.split("\0").filter(Boolean)) {
    const normalized = name.replace(/\\/g, "/");
    const credential = /(^|\/)(auth|account)\.json$/i.test(normalized);
    if (
      credential &&
      settings.includeCredentials &&
      /^_data\/(auth|account)\.json$/.test(normalized)
    )
      continue;
    if (
      credential ||
      /(^|\/)\.env(?:\.|$)|\.(?:db|sqlite)(?:-|$)|(?:\.backup-|\.bak-)|^_state\/locks\//i.test(
        normalized,
      )
    )
      throw new Error(`Sensitive/runtime file is staged: ${name}. Untrack it before pushing.`);
    const full = path.join(root, name);
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink())
      throw new Error(`Symlink cannot be shared safely: ${name}`);
    if (/\.jsonc?$/.test(name) && fs.statSync(full).size < 2 * 1024 * 1024) {
      const text = fs.readFileSync(full, "utf8");
      const pattern =
        /["'](?:apiKey|api_key|access_token|refresh_token|client_secret|password)["']\s*:\s*["']([^"']+)["']/g;
      for (const m of text.matchAll(pattern))
        if (!/^\{(?:env|file):[^}]+\}$|^<[^>]+>$/.test(m[1] ?? ""))
          throw new Error(
            `Possible embedded credential in ${name}; use an environment/file reference. Value not logged.`,
          );
    }
  }
}
export function createConfigBackup(config: string, data: string): void {
  if (!fs.existsSync(config)) return;
  const ignored = new Set([
    ".git",
    "node_modules",
    "_sessions",
    "_data",
    "_state",
    "_agents",
    ".opencode-sync.lock",
  ]);
  const list: string[] = [];
  function walk(dir: string): void {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) list.push(full);
    }
  }
  walk(config);
  if (!list.length) return;
  const hash = createHash("sha256");
  for (const file of list.sort()) {
    hash.update(path.relative(config, file));
    hash.update(fs.readFileSync(file));
  }
  const digest = hash.digest("hex");
  const backups = path.join(data, "backups", "opencode-multidevice-sync", "config");
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const previous = fs
    .readdirSync(backups)
    .filter((n) => n.startsWith("config-"))
    .sort()
    .reverse();
  if (previous[0]?.includes(digest.slice(0, 16))) return;
  const dest = path.join(backups, `config-${Date.now()}-${digest.slice(0, 16)}-${randomUUID()}`);
  for (const file of list) {
    const target = path.join(dest, path.relative(config, file));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, target);
  }
  for (const old of previous.slice(9))
    fs.rmSync(path.join(backups, old), { recursive: true, force: true });
}
