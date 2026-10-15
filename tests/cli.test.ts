import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function cli(args: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omds-cli-test-"));
  dirs.push(dir);
  return spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      SYNC_CONFIG_ROOT: dir,
      SYNC_DATA_ROOT: path.join(dir, "data"),
      SYNC_STATE_ROOT: path.join(dir, "state"),
      SYNC_AGENTS_ROOT: path.join(dir, "agents"),
      SYNC_CACHE_ROOT: path.join(dir, "cache"),
      SYNC_REMOTE_URL: "",
    },
  });
}
describe("packaged CLI", () => {
  it("prints actual commands, not damaged interpolation", () => {
    const result = cli(["help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("backup");
    expect(result.stdout).toContain("sessions locations");
    expect(result.stdout).not.toContain("$paint");
  });
  it("has an explicit package version", () => {
    const r = cli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.2.0-v2.0");
  });
  it("doctor exits nonzero when no repository is configured", () => {
    const r = cli(["doctor", "--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });
  it("force does not bypass offline restore guard", () => {
    const r = cli(["restore", "--force"]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("--offline");
  });
});
