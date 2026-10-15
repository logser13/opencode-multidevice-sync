import fs from "node:fs";
import type { Plugin } from "@opencode/plugin";
import { withSyncLock } from "../core/lock.js";
import { getRoots } from "../core/paths.js";
import { CollectingReporter } from "../core/reporter.js";
import { loadSettings, repoUrl, settingsPath } from "../core/settings.js";
import { push, status } from "../core/sync.js";

// The background host can load the global plugin once for each project.
const owners = new Map<string, () => void>();
const candidates = new Map<string, Set<() => void>>();
export async function setupV2(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const roots = getRoots();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<unknown> | undefined;
  let stream: Promise<void> | undefined;
  let disposed = false;
  let rerun = false;
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "opencode_sync",
      description:
        "Report synchronization status or push completed V2 sessions. Pull requires stopping OpenCode and running omds pull --offline outside the agent.",
      input: {
        type: "object",
        properties: { action: { type: "string", enum: ["status", "push", "pull"] } },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(input, toolContext) {
        const action = (input as { action: string }).action;
        if (action === "pull")
          return {
            content:
              "V2 pull is offline only. Stop OpenCode completely, then run omds pull --offline.",
          };
        if (action !== "push" && action !== "status") throw new Error("Unknown sync action");
        if (action === "push") {
          await ctx.permission.assert({
            sessionID: toolContext.sessionID,
            action: "shell",
            resources: ["git push"],
            save: undefined,
            metadata: undefined,
            source: undefined,
          });
        }
        const result = await withSyncLock(roots.config, { waitMs: 0 }, async () => {
          if (action === "push") return push({ roots });
          return status({ roots });
        });
        return { content: JSON.stringify(result) };
      },
    });
  });
  const configured =
    fs.existsSync(settingsPath(roots.config)) && repoUrl(loadSettings(roots.config));
  const schedulePush = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      if (pending) {
        rerun = true;
        return;
      }
      rerun = false;
      const reporter = new CollectingReporter();
      pending = withSyncLock(roots.config, { waitMs: 0 }, () => push({ roots, reporter }))
        .catch((error) => console.error(`OMDS V2 auto-push failed: ${(error as Error).message}`))
        .finally(() => {
          pending = undefined;
          if (rerun) schedulePush();
        });
    }, 1000);
  };
  const start = () => {
    if (disposed) return;
    owners.set(roots.config, start);
    if (loadSettings(roots.config).autoPullOnStartup)
      console.info("OMDS: V2 startup pull is disabled; stop OpenCode and use omds pull --offline.");
    stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // 2.0.29 emits durable execution completion. Idle/status are legacy compatibility events.
          const settled =
            event.type === "session.execution.succeeded" ||
            event.type === "session.idle" ||
            (event.type === "session.status" && event.data.status.type === "idle");
          if (disposed || !settled || !loadSettings(roots.config).autoPushOnIdle) continue;
          schedulePush();
        }
      } catch (error) {
        if (!controller.signal.aborted)
          console.error(`OMDS V2 event subscription failed: ${(error as Error).message}`);
      }
    })();
  };
  if (configured) {
    const waiting = candidates.get(roots.config) ?? new Set<() => void>();
    waiting.add(start);
    candidates.set(roots.config, waiting);
    if (!owners.has(roots.config)) start();
  }
  return async () => {
    disposed = true;
    controller.abort();
    if (timer) clearTimeout(timer);
    await stream;
    await pending;
    const waiting = candidates.get(roots.config);
    waiting?.delete(start);
    if (owners.get(roots.config) === start) {
      owners.delete(roots.config);
      waiting?.values().next().value?.();
    }
    if (!waiting?.size) candidates.delete(roots.config);
  };
}
