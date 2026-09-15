import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessSessionVisibility, readDesktopState } from "../src/core/desktop.js";
import { listSessionLocations } from "../src/core/sessions.js";
import { openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

let root = "";
let sqlite = false;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omds-visibility-"));
  sqlite = await sqliteAvailable();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeDesktopState(active: string): string {
  const dir = path.join(root, "ai.opencode.desktop");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.global.dat");
  const server = {
    projects: { local: [{ worktree: active, expanded: true }] },
    lastProject: { local: active },
  };
  const layout = { home: { selection: { server: "sidecar", directory: active } } };
  fs.writeFileSync(
    file,
    JSON.stringify({ server: JSON.stringify(server), layout: JSON.stringify(layout) }),
  );
  return file;
}
describe("Desktop session visibility", () => {
  it("reads the active OpenCode Desktop project from Windows state", () => {
    const active = "G:\\My Drive\\OpenCode";
    writeDesktopState(active);
    const state = readDesktopState({ platform: "win32", appData: root, home: root });
    expect(state.readable).toBe(true);
    expect(state.activeDirectory).toBe(active);
    expect(state.knownProjects).toEqual([active]);
  });

  it("warns when Desktop is open in a directory with no synced root chats", () => {
    writeDesktopState("C:\\Users\\COMP\\Documents\\Default Project");
    const state = readDesktopState({ platform: "win32", appData: root, home: root });
    const result = assessSessionVisibility(
      [{ directory: "G:/My Drive/OpenCode", rootSessions: 15 }],
      state,
      "win32",
    );
    expect(result.mismatch).toBe(true);
    expect(result.visibleRootSessions).toBe(0);
    expect(result.warning).toContain("other directories");
  });

  it("matches Windows directories case-insensitively across slash styles", () => {
    writeDesktopState("G:\\MY DRIVE\\OpenCode\\");
    const state = readDesktopState({ platform: "win32", appData: root, home: root });
    const result = assessSessionVisibility(
      [{ directory: "g:/my drive/opencode", rootSessions: 15 }],
      state,
      "win32",
    );
    expect(result.mismatch).toBe(false);
    expect(result.visibleRootSessions).toBe(15);
  });
});
describe("session location aggregation", () => {
  it("groups root and child sessions by directory", async () => {
    expect(sqlite, "SQLite support must be available").toBe(true);
    const file = path.join(root, "opencode.db");
    const db = await openDatabase(file);
    db.exec(`CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    )`);
    const insert = db.prepare(
      "INSERT INTO session (id,parent_id,directory,time_updated) VALUES (?,?,?,?)",
    );
    insert.run("root-a", null, "G:/My Drive/OpenCode", 30);
    insert.run("child-a", "root-a", "G:/My Drive/OpenCode", 31);
    insert.run("root-b", null, "D:/Other", 20);
    db.close();

    const locations = await listSessionLocations(file);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toEqual({
      directory: "G:/My Drive/OpenCode",
      totalSessions: 2,
      rootSessions: 1,
      childSessions: 1,
      latestUpdated: 31,
    });
    expect(locations[1]!.rootSessions).toBe(1);
    expect(locations[1]!.childSessions).toBe(0);
  });
});

describe("Desktop state paths", () => {
  it("reads the conventional macOS Electron userData location", () => {
    const active = "/Users/test/OpenCode";
    const file = path.join(
      root,
      "Library",
      "Application Support",
      "ai.opencode.desktop",
      "opencode.global.dat",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ server: JSON.stringify({ lastProject: { local: active } }) }),
    );
    const state = readDesktopState({ platform: "darwin", home: root });
    expect(state.activeDirectory).toBe(active);
  });

  it("reads the conventional Linux Electron userData location", () => {
    const active = "/home/test/OpenCode";
    const file = path.join(root, ".config", "ai.opencode.desktop", "opencode.global.dat");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ server: JSON.stringify({ lastProject: { local: active } }) }),
    );
    const state = readDesktopState({
      platform: "linux",
      home: root,
      xdgConfigHome: path.join(root, ".config"),
    });
    expect(state.activeDirectory).toBe(active);
  });
});
