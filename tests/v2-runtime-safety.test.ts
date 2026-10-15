import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopState } from "../src/core/desktop.js";
import { git } from "../src/core/git.js";
import { assertSafeTrackedFiles } from "../src/core/guard.js";
import { getDatabasePath, getRoots } from "../src/core/paths.js";
import { ensureGitIdentity, initRepo } from "../src/core/repo.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omds-runtime-safety-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function repo(directory: string) {
  fs.mkdirSync(directory);
  git(["init", "-b", "main"], { cwd: directory });
  ensureGitIdentity(directory);
}
describe("V2 runtime file isolation", () => {
  it("uses the V2 host config/database overrides without redirecting explicitly isolated roots", () => {
    vi.stubEnv("SYNC_CONFIG_ROOT", "");
    vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(root, "v2-config"));
    vi.stubEnv("OPENCODE_DB", path.join(root, "v2-custom.db"));
    const roots = getRoots();
    expect(roots.config).toBe(path.join(root, "v2-config"));
    expect(getDatabasePath(roots)).toBe(path.join(root, "v2-custom.db"));
    expect(
      getDatabasePath({ ...roots, database: undefined, data: path.join(root, "copy-data") }),
    ).toBe(path.join(root, "copy-data/opencode.db"));
  });
  it("does not report stale V1 Desktop state as the V2 active project", () => {
    const appData = path.join(root, "roaming");
    const dir = path.join(appData, "ai.opencode.desktop");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "opencode.global.dat"),
      JSON.stringify({ server: JSON.stringify({ lastProject: { local: "C:/old-v1-project" } }) }),
    );
    expect(
      readDesktopState({ platform: "win32", appData, generation: "v2" }).activeDirectory,
    ).toBeUndefined();
  });
  it("blocks an already tracked service registration before it can be pushed", () => {
    repo(path.join(root, "source"));
    const source = path.join(root, "source");
    fs.writeFileSync(path.join(source, "service.json"), JSON.stringify({ pid: 1234 }));
    git(["add", "service.json"], { cwd: source });
    expect(() => assertSafeTrackedFiles(source, DEFAULT_SETTINGS)).toThrow(/runtime|service/i);
  });
  it("rejects incoming service state before first checkout can overwrite the local registration", () => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    repo(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, "service.json"), "remote registration");
    git(["add", "."], { cwd: source });
    git(["commit", "-m", "fixture"], { cwd: source });
    fs.writeFileSync(path.join(target, "service.json"), "local registration");
    expect(() => initRepo({ root: target, remote: source, branch: "main" })).toThrow(
      /runtime|service/i,
    );
    expect(fs.readFileSync(path.join(target, "service.json"), "utf8")).toBe("local registration");
  });
});
