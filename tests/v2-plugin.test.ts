import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalRuntimePath } from "../src/core/repo.js";
import { prunePluginCache } from "../src/core/stage.js";
import * as sync from "../src/core/sync.js";
import plugin from "../src/plugin/index.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "omds-v2-plugin-"));
  vi.stubEnv("SYNC_CONFIG_ROOT", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function context() {
  const tools: any[] = [];
  let signal: AbortSignal | undefined;
  const ctx: any = {
    app: { version: "2.0.29" },
    location: { directory: root },
    tool: { transform: async (fn: any) => fn({ add: (tool: any) => tools.push(tool) }) },
    event: {
      subscribe: ({ signal: s }: { signal: AbortSignal }) => {
        signal = s;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) =>
              s.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        };
      },
    },
  };
  return { ctx, tools, signal: () => signal };
}
describe("V2 plugin", () => {
  it("sends another completed reply after an in-flight push finishes", async () => {
    vi.useFakeTimers();
    fs.writeFileSync(
      path.join(root, "opencode-sync.jsonc"),
      JSON.stringify({
        repo: { url: path.join(root, "local.git") },
        autoPullOnStartup: false,
        autoPushOnIdle: true,
      }),
    );
    const result: sync.SyncResult = {
      action: "push",
      changed: false,
      summary: {} as any,
      files: [],
      message: "test",
      restartRequired: false,
    };
    let finish!: (value: sync.SyncResult) => void;
    const inFlight = new Promise<sync.SyncResult>((resolve) => {
      finish = resolve;
    });
    const pushed = vi.spyOn(sync, "push").mockResolvedValue(result).mockReturnValueOnce(inFlight);
    let emitSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      emitSecond = resolve;
    });
    const { ctx } = context();
    ctx.event.subscribe = ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.execution.succeeded", data: { sessionID: "ses_test" } };
        await second;
        yield { type: "session.execution.succeeded", data: { sessionID: "ses_test" } };
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const cleanup = await plugin.setup(ctx);
    try {
      await vi.advanceTimersByTimeAsync(1100);
      expect(pushed).toHaveBeenCalledTimes(1);
      emitSecond();
      await vi.advanceTimersByTimeAsync(1100);
      finish(result);
      await vi.advanceTimersByTimeAsync(1100);
      expect(pushed).toHaveBeenCalledTimes(2);
    } finally {
      finish(result);
      await cleanup();
    }
  });
  it.each([
    { type: "session.execution.succeeded", data: { sessionID: "ses_test" } },
    { type: "session.status", data: { sessionID: "ses_test", status: { type: "idle" } } },
    { type: "session.idle", data: { sessionID: "ses_test" } },
  ])("pushes on a settled V2 event $type", async (event) => {
    vi.useFakeTimers();
    fs.writeFileSync(
      path.join(root, "opencode-sync.jsonc"),
      JSON.stringify({
        repo: { url: path.join(root, "local.git") },
        autoPullOnStartup: false,
        autoPushOnIdle: true,
      }),
    );
    const pushed = vi.spyOn(sync, "push").mockResolvedValue({
      action: "push",
      changed: false,
      summary: {} as any,
      files: [],
      message: "test",
      restartRequired: false,
    });
    const { ctx } = context();
    ctx.event.subscribe = ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield event;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const cleanup = await plugin.setup(ctx);
    try {
      await vi.advanceTimersByTimeAsync(1100);
      expect(pushed).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });
  it("hands the event subscription to another open project when the owner unloads", async () => {
    fs.writeFileSync(
      path.join(root, "opencode-sync.jsonc"),
      JSON.stringify({ repo: { url: path.join(root, "missing.git") }, autoPullOnStartup: false }),
    );
    const first = context();
    const second = context();
    const cleanup1 = await plugin.setup(first.ctx);
    const cleanup2 = await plugin.setup(second.ctx);
    expect(first.signal()?.aborted).toBe(false);
    expect(second.signal()).toBeUndefined();
    await cleanup1();
    expect(second.signal()?.aborted).toBe(false);
    await cleanup2();
  });
  it("resolves as a directory plugin through the released V2 host", async () => {
    const { Host } = await import("@opencode/plugin/host");
    expect(Host.resolve({ directory: path.resolve(".") }).server).toBeDefined();
  });
  it("registers a usable tool through the V2 entrypoint and keeps a V1 server entrypoint", async () => {
    const { ctx, tools } = context();
    expect(typeof (plugin as any).server).toBe("function");
    await (plugin as any).setup(ctx);
    expect(tools).toHaveLength(1);
    const status = await tools[0].execute({ action: "status" }, {});
    expect(JSON.parse(status.content).configured).toBe(false);
    const result = await tools[0].execute({ action: "pull" }, {});
    expect(result.content).toMatch(/offline/i);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  });
  it("never runs startup pull in the live V2 host and aborts subscription on cleanup", async () => {
    fs.writeFileSync(
      path.join(root, "opencode-sync.jsonc"),
      JSON.stringify({
        repo: { url: path.join(root, "missing.git") },
        autoPullOnStartup: true,
        autoPushOnIdle: true,
      }),
    );
    const { ctx, signal } = context();
    const cleanup = await (plugin as any).setup(ctx);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(signal()?.aborted).toBe(false);
    await cleanup();
    expect(signal()?.aborted).toBe(true);
  });
  it("keeps native V2 plugin objects enabled during cache pruning", () => {
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    fs.writeFileSync(
      path.join(root, "opencode.json"),
      JSON.stringify({ plugins: [{ package: "kept-plugin@2.0.0", options: {} }] }),
    );
    fs.writeFileSync(
      path.join(cache, "package.json"),
      JSON.stringify({ dependencies: { "kept-plugin": "2.0.0" } }),
    );
    expect(prunePluginCache(root, cache)).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(path.join(cache, "package.json"), "utf8")).dependencies[
        "kept-plugin"
      ],
    ).toBe("2.0.0");
  });
  it("excludes V2 service secrets and local baselines from all Git staging", () => {
    expect(isLocalRuntimePath("service.json")).toBe(true);
    expect(isLocalRuntimePath("_state/service.json")).toBe(true);
    expect(isLocalRuntimePath("_data/opencode.db.omds-v2-bases.json")).toBe(true);
  });
});
