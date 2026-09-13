import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabaseBackup } from "./backup.js";
import { git } from "./git.js";
import { type Roots, getRoots } from "./paths.js";
import { loadSettings } from "./settings.js";
import type { SyncOptions, SyncResult } from "./sync.js";
export async function previewSync(
  action: "push" | "pull",
  options: SyncOptions,
  run: (o: SyncOptions) => Promise<SyncResult>,
): Promise<SyncResult> {
  const roots = options.roots ?? getRoots();
  const settings = options.settings ?? loadSettings(roots.config);
  if (settings.extraPaths.length)
    throw new Error(
      "Preview with extraPaths is not supported yet; refusing to touch external files",
    );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omds-preview-"));
  const isolated = {} as Roots;
  try {
    const marker = path.join(roots.config, ".git");
    if (fs.existsSync(marker) && !fs.lstatSync(marker).isDirectory())
      throw new Error("Preview of linked Git worktrees is not supported");
    for (const key of ["config", "data", "state", "agents", "cache"] as const) {
      isolated[key] = path.join(temp, key);
      fs.mkdirSync(isolated[key], { recursive: true });
      if (!fs.existsSync(roots[key]) || key === "cache") continue;
      fs.cpSync(roots[key], isolated[key], {
        recursive: true,
        dereference: false,
        filter: (p) => {
          const name = path.basename(p);
          return (
            ![
              "node_modules",
              "backups",
              "log",
              "tool-output",
              "snapshot",
              "repos",
              "locks",
              ".opencode-sync.lock",
            ].includes(name) && !/^opencode\.db(?:-|$)/.test(name)
          );
        },
      });
    }
    const database = path.join(roots.data, "opencode.db");
    if (settings.sessions.enabled && fs.existsSync(database)) {
      const snapshot = await createDatabaseBackup(database, path.join(temp, "snapshot"), 1);
      fs.copyFileSync(snapshot.path, path.join(isolated.data, "opencode.db"));
    }
    fs.mkdirSync(path.join(temp, "no-hooks"));
    git(["config", "core.hooksPath", path.join(temp, "no-hooks")], { cwd: isolated.config });
    const result = await run({ ...options, roots: isolated, settings, dryRun: action === "push" });
    return { ...result, message: `Preview only: ${result.message}`, restartRequired: false };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
