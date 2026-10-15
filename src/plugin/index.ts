import fs from "node:fs";
import { tool } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";
import { withSyncLock } from "../core/lock.js";
import { getRoots } from "../core/paths.js";
import { CollectingReporter } from "../core/reporter.js";
import { loadSettings, repoUrl, settingsPath } from "../core/settings.js";
import { pull, push, status } from "../core/sync.js";
import { setupV2 } from "./v2.js";
const startups = new Map<string, Promise<boolean>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
async function notify(client: any, message: string, failed = false) {
  try {
    await client?.app?.log?.({
      body: { service: "opencode-multidevice-sync", level: failed ? "error" : "info", message },
    });
  } catch {}
  try {
    await client?.tui?.showToast?.({
      body: { title: "OpenCode Multidevice Sync", message, variant: failed ? "error" : "success" },
    });
  } catch {}
}
async function OpencodeMultideviceSync(ctx: { client?: any; directory?: string }) {
  const roots = getRoots();
  const client = ctx.client;
  if (!fs.existsSync(settingsPath(roots.config)) || !repoUrl(loadSettings(roots.config))) return {};
  async function perform(action: "push" | "pull", announce: boolean): Promise<boolean> {
    try {
      const reporter = new CollectingReporter();
      const result = await withSyncLock(roots.config, { waitMs: 30000 }, () =>
        action === "push" ? push({ roots, reporter }) : pull({ roots, reporter }),
      );
      const message =
        `${action}: ${result.message}` +
        (result.restartRequired ? ". Restart OpenCode to reload imported data/config." : "");
      if (announce || result.changed) await notify(client, message);
      else
        try {
          await client?.app?.log?.({
            body: { service: "opencode-multidevice-sync", level: "info", message },
          });
        } catch {}
      return true;
    } catch (error) {
      await notify(client, `${action} failed: ${(error as Error).message}`, true);
      return false;
    }
  }
  let startup = startups.get(roots.config);
  if (!startup) {
    startup = loadSettings(roots.config).autoPullOnStartup
      ? perform("pull", false)
      : Promise.resolve(true);
    startups.set(roots.config, startup);
  }
  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type !== "session.idle" || !loadSettings(roots.config).autoPushOnIdle) return;
      const previous = timers.get(roots.config);
      if (previous) clearTimeout(previous);
      timers.set(
        roots.config,
        setTimeout(async () => {
          timers.delete(roots.config);
          if (await startup) await perform("push", true);
          else
            await notify(
              client,
              "Auto-push paused: initial pull failed. Resolve the error and restart OpenCode.",
              true,
            );
        }, 1000),
      );
    },
    tool: {
      opencode_sync: tool({
        description:
          "Sync this OpenCode installation with its configured private repository. Report status, push, or pull. Never resolves conflicts with force.",
        args: { action: tool.schema.enum(["status", "push", "pull"]) },
        async execute(args) {
          if (args.action === "status") return JSON.stringify(status({ roots }), null, 2);
          return (await perform(args.action, true))
            ? "Sync completed; see sync status and notifications."
            : "Sync failed. Review the error notification/log; data was not force-overwritten.";
        },
      }),
    },
  };
}

// Plugin.define is an identity function in 2.0.29. A structural entrypoint
// avoids adding the V2 runtime to V1's dependency graph. V1 >= 1.18.29 calls server.
export default {
  id: "opencode-multidevice-sync",
  setup: setupV2,
  server: OpencodeMultideviceSync,
} satisfies Plugin.Plugin & { server: typeof OpencodeMultideviceSync };
