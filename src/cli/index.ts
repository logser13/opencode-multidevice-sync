#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  createDatabaseBackup,
  latestDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup,
} from "../core/backup.js";
import { assessSessionVisibility, readDesktopState } from "../core/desktop.js";
import { git } from "../core/git.js";
import { assertPrivateRemote } from "../core/guard.js";
import { checkDatabaseHealth, healthProblems } from "../core/health.js";
import { withSyncLock } from "../core/lock.js";
import { getDatabasePath, getRoots } from "../core/paths.js";
import { listSessionLocations, listSessions } from "../core/sessions.js";
import { repoUrl } from "../core/settings.js";
import {
  OVERRIDES_TEMPLATE,
  loadSettings,
  overridesPath,
  saveSettings,
  settingsPath,
} from "../core/settings.js";
import { SetupError, discoverSyncRepos, initSync, linkSync } from "../core/setup.js";
import { sqliteAvailable } from "../core/sqlite.js";
import { SyncError, formatBytes, pull, push, status } from "../core/sync.js";
import {
  Spinner,
  banner,
  changeList,
  createCliReporter,
  detail,
  fail,
  heading,
  info,
  keyValue,
  ok,
  outcome,
  rule,
  summaryLine,
  warn,
  write,
} from "./render.js";
import { glyph, paint, style } from "./theme.js";

const LOCK_WAIT_MS = 5 * 60 * 1000;

interface Args {
  command: string;
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (const arg of argv) {
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const clean = arg.replace(/^--?/, "");
    const eq = clean.indexOf("=");
    if (eq !== -1) values.set(clean.slice(0, eq), clean.slice(eq + 1));
    else flags.add(clean);
  }

  return { command: positional.shift() ?? "help", positional, flags, values };
}

async function confirm(question: string, lines: string[]): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  write();
  write(`  ${paint(" FORCE ", style.bold, style.red)}  ${paint(question, style.bold, style.text)}`);
  for (const line of lines) write(`  ${paint(`${glyph.bullet} ${line}`, style.muted)}`);
  write();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `  ${paint("Type", style.muted)} ${paint("yes", style.bold, style.red)} ${paint("to continue: ", style.muted)}`,
      resolve,
    );
  });
  rl.close();
  write();
  return answer.trim().toLowerCase() === "yes";
}

function renderSessionLocations(locations: Awaited<ReturnType<typeof listSessionLocations>>): void {
  for (const location of locations) {
    const child = location.childSessions ? ` · ${location.childSessions} child` : "";
    detail(`${location.rootSessions} chat(s)${child} · ${location.directory}`);
  }
}

async function reportVisibility(roots: ReturnType<typeof getRoots>): Promise<void> {
  if (!(await sqliteAvailable())) return;
  const locations = await listSessionLocations(getDatabasePath(roots));
  if (!locations.length) return;
  heading("Session locations");
  renderSessionLocations(locations);
  const desktop = readDesktopState();
  const visibility = assessSessionVisibility(locations, desktop);
  if (desktop.activeDirectory) keyValue("desktop project", desktop.activeDirectory);
  if (visibility.warning) {
    warn(visibility.warning);
    detail("Open one of the session directories in OpenCode Desktop to make those chats visible.");
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function runSync(action: "push" | "pull", args: Args): Promise<void> {
  const force = args.flags.has("force") || args.flags.has("f");
  const dryRun = args.flags.has("dry-run") || args.flags.has("n");
  const roots = getRoots();

  banner(action === "push" ? "push to GitHub" : "pull from GitHub", force ? "FORCE" : undefined);

  if (force && !dryRun) {
    const consequences =
      action === "push"
        ? ["Any change made on another machine and not pulled here will be overwritten."]
        : [
            "Uncommitted local changes will be discarded.",
            "Skills and state directories will be rewritten from the repository.",
          ];
    if (!(await confirm(`Force ${action}?`, consequences))) {
      info("Cancelled.");
      return;
    }
  }

  const spinner = new Spinner(action === "push" ? "Preparing push" : "Preparing pull");
  spinner.start();
  const reporter = createCliReporter(spinner);

  try {
    const result = await withSyncLock(roots.config, { waitMs: LOCK_WAIT_MS }, () =>
      action === "push"
        ? push({ force, dryRun, reporter, roots })
        : pull({ force, dryRun, reporter, roots }),
    );
    spinner.stop();

    if (result.sessions) {
      const bits: string[] = [];
      if (result.sessions.exported !== undefined) bits.push(`${result.sessions.exported} exported`);
      if (result.sessions.imported !== undefined) bits.push(`${result.sessions.imported} imported`);
      if (result.sessions.skipped) bits.push(`${result.sessions.skipped} skipped`);
      if (bits.length > 0) detail(`Sessions: ${bits.join(", ")}`);
    }

    if (action === "pull" && result.sessions?.imported !== undefined) await reportVisibility(roots);

    outcome(dryRun ? `${result.message} (dry run)` : result.message, result.changed);
    if (result.restartRequired && result.changed) {
      info("Restart OpenCode for the new configuration to take effect.");
      write();
    }
  } finally {
    spinner.stop();
  }
}

function runStatus(): void {
  banner("status");
  const roots = getRoots();
  const state = status({ roots });

  if (!state.configured) {
    fail("No sync repository configured.");
    write();
    info("Run `omds init` to create one.");
    const found = discoverSyncRepos();
    if (found.length > 0) {
      write();
      detail(
        `Existing private repositories that look like a match: ${found.slice(0, 5).join(", ")}`,
      );
      detail("Link one with: omds link <owner/repo>");
    }
    write();
    return;
  }

  keyValue("repository", paint(state.remote ?? "-", style.text));
  keyValue("branch", paint(state.branch, style.text));
  keyValue("machine", paint(state.machineAlias, style.text));

  if (!state.initialized) {
    write();
    warn("The local repository is not initialised yet. Run `omds pull`.");
    write();
    return;
  }

  const sync =
    state.ahead === 0 && state.behind === 0
      ? paint("in sync", style.green)
      : [
          state.ahead > 0 ? paint(`${state.ahead} to push`, style.yellow) : "",
          state.behind > 0 ? paint(`${state.behind} to pull`, style.cyan) : "",
        ]
          .filter(Boolean)
          .join(paint("  ", style.faint));
  keyValue("state", sync);
  keyValue(
    "uncommitted",
    state.dirty === 0 ? paint("clean", style.green) : paint(`${state.dirty} file(s)`, style.yellow),
  );
  keyValue(
    "overrides",
    state.overridesActive ? paint("active", style.accent) : paint("none", style.muted),
  );
  keyValue(
    "sessions",
    state.sessionsEnabled
      ? paint(`enabled · ${state.sessionShards} shard(s)`, style.text)
      : paint("disabled", style.muted),
  );

  if (state.lastCommit) {
    heading("Last commit");
    detail(state.lastCommit);
    if (state.lastCommitDate) detail(state.lastCommitDate);
  }
  write();
}

function runInit(args: Args, mode: "init" | "link"): void {
  banner(mode === "init" ? "create a sync repository" : "link an existing repository");
  const reporter = createCliReporter();
  const options = {
    repo: args.positional[0],
    reporter,
    includeCredentials: args.flags.has("credentials"),
    includeSessions: args.flags.has("sessions"),
  };

  const result = mode === "init" ? initSync(options) : linkSync(options);

  ok(
    result.created
      ? `Created ${paint(`${result.target.owner}/${result.target.name}`, style.bold, style.text)}`
      : `Linked ${paint(`${result.target.owner}/${result.target.name}`, style.bold, style.text)}`,
  );
  detail(`settings  ${result.settingsFile}`);
  detail(`overrides ${result.overridesFile}`);

  heading("Next");
  write(`  ${paint("1.", style.faint)} ${mode === "init" ? "omds push" : "omds pull"}`);
  write(`  ${paint("2.", style.faint)} Restart OpenCode`);
  write();
}

async function runSessions(args: Args): Promise<void> {
  const sub = args.positional[0] ?? "list";
  const roots = getRoots();
  const settings = loadSettings(roots.config);

  if (sub === "locations") {
    banner("session locations");
    if (!(await sqliteAvailable())) {
      fail("No SQLite driver available. Use Node 22.13+ or run under Bun.");
      write();
      return;
    }
    const locations = await listSessionLocations(getDatabasePath(roots));
    if (!locations.length) info("No sessions found.");
    else renderSessionLocations(locations);
    const desktop = readDesktopState();
    const visibility = assessSessionVisibility(locations, desktop);
    if (desktop.activeDirectory) keyValue("desktop project", desktop.activeDirectory);
    if (visibility.warning) warn(visibility.warning);
    write();
    return;
  }

  if (sub === "list") {
    banner("sessions");
    if (!(await sqliteAvailable())) {
      fail("No SQLite driver available. Use Node 22.5+ or run under Bun.");
      write();
      return;
    }
    const limit = Number(args.values.get("limit") ?? 20);
    const sessions = await listSessions(getDatabasePath(roots), limit);
    if (sessions.length === 0) {
      info("No sessions found.");
      write();
      return;
    }
    for (const session of sessions) {
      const when = new Date(session.timeUpdated).toISOString().slice(0, 16).replace("T", " ");
      const title = session.title || paint("(untitled)", style.faint);
      write(`  ${paint(when, style.faint)}  ${title}`);
      write(`  ${paint(" ".repeat(16), style.faint)}  ${paint(session.id, style.faint)}`);
    }
    write();
    detail(`Pin a session with: omds sessions include <id>`);
    write();
    return;
  }

  if (sub === "include" || sub === "exclude") {
    const id = args.positional[1];
    if (!id) throw new SyncError(`Usage: omds sessions ${sub} <session-id>`);
    const list = sub === "include" ? settings.sessions.include : settings.sessions.exclude;
    if (!list.includes(id)) list.push(id);
    saveSettings(settings, roots.config);
    banner("sessions");
    ok(`${sub === "include" ? "Pinned" : "Excluded"} ${paint(id, style.text)}`);
    write();
    return;
  }

  if (sub === "enable" || sub === "disable") {
    settings.sessions.enabled = sub === "enable";
    saveSettings(settings, roots.config);
    banner("sessions");
    ok(`Session sync ${sub}d`);
    if (sub === "enable") {
      detail(
        `Window: ${settings.sessions.days} day(s), up to ${settings.sessions.maxSessions} sessions`,
      );
      detail(`Per-session cap: ${formatBytes(settings.sessions.maxSessionBytes)}`);
      warn("Only enable this for a private repository — conversations are private data.");
    }
    write();
    return;
  }

  throw new SyncError(`Unknown sessions subcommand: ${sub}`);
}

async function runDoctor(args: Args): Promise<void> {
  const roots = getRoots();
  const settings = loadSettings(roots.config);
  const remote = repoUrl(settings);
  const issues: string[] = [];
  const warnings: string[] = [];
  const database = getDatabasePath(roots);
  let health: Awaited<ReturnType<typeof checkDatabaseHealth>> | undefined;
  let locations: Awaited<ReturnType<typeof listSessionLocations>> = [];
  try {
    health = await checkDatabaseHealth(database);
    if (settings.sessions.enabled && !health.ok) issues.push(...healthProblems(health));
    if (health.exists) locations = await listSessionLocations(database);
  } catch (error) {
    issues.push((error as Error).message);
  }
  const desktop = readDesktopState();
  const visibility = assessSessionVisibility(locations, desktop);
  if (visibility.warning) warnings.push(visibility.warning);
  if (desktop.error) warnings.push(`Cannot read OpenCode Desktop state: ${desktop.error}`);
  if (!remote) issues.push("Sync repository is not configured");
  else {
    const reachable = git(["ls-remote", remote, "HEAD"], { cwd: roots.config });
    if (!reachable.ok) issues.push("Remote is unreachable or authentication failed");
    try {
      assertPrivateRemote(remote, settings);
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  const report = {
    package: "opencode-multidevice-sync",
    version: "0.1.1",
    machine: settings.machineAlias ?? "auto",
    database: health,
    sessionSync: settings.sessions.enabled,
    sessionLocations: locations,
    desktop,
    visibility,
    warnings,
    backupBeforeImport: settings.sessions.backupBeforeImport,
    credentialsSync: settings.includeCredentials,
    backups: listDatabaseBackups().length,
    issues,
    ok: issues.length === 0,
    note: "Preflight checks only; not a guarantee of conflict-free concurrent editing. Keep one active device.",
  };
  if (args.flags.has("json")) console.log(JSON.stringify(report, null, 2));
  else {
    banner("doctor");
    keyValue("version", report.version);
    keyValue("machine", report.machine);
    keyValue("sessions", String(health?.sessions ?? 0));
    keyValue("messages", String(health?.messages ?? 0));
    keyValue("parts", String(health?.parts ?? 0));
    keyValue("database integrity", health?.ok ? "OK" : "NOT OK");
    keyValue("backups", String(report.backups));
    if (locations.length) {
      heading("Session locations");
      renderSessionLocations(locations);
    }
    if (desktop.activeDirectory) keyValue("desktop project", desktop.activeDirectory);
    for (const message of warnings) warn(message);
    if (visibility.mismatch)
      detail("Open one of the session directories in OpenCode Desktop to see the synced chats.");
    if (report.ok) ok("Preflight checks passed");
    else for (const issue of issues) fail(issue);
    info(report.note);
    write();
  }
  if (!report.ok) process.exitCode = 1;
}
async function runBackup(): Promise<void> {
  const roots = getRoots();
  const settings = loadSettings(roots.config);
  const result = await withSyncLock(roots.config, { waitMs: LOCK_WAIT_MS }, () =>
    createDatabaseBackup(getDatabasePath(roots), undefined, settings.sessions.backupRetention),
  );
  banner("backup");
  ok("Verified SQLite snapshot created");
  detail(result.path);
  detail(formatBytes(result.bytes));
}
function assertOpenCodeClosed(): void {
  const windows = process.platform === "win32";
  const check = spawnSync(
    windows ? "tasklist.exe" : "ps",
    windows ? ["/FO", "CSV", "/NH"] : ["-A", "-o", "comm="],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  );
  if (check.status !== 0) throw new SyncError("Cannot check running applications; restore refused");
  if (
    windows
      ? /^"(?:opencode|opencode-cli)\.exe"/im.test(check.stdout)
      : /(?:^|\/)(?:opencode|OpenCode)(?:\n|$)/m.test(check.stdout)
  )
    throw new SyncError("OpenCode is running. Close it cleanly before restoring.");
}
async function runRestore(args: Args): Promise<void> {
  if (!args.flags.has("offline"))
    throw new SyncError(
      "Restore requires --offline and all OpenCode processes closed. --force cannot bypass this check.",
    );
  assertOpenCodeClosed();
  const roots = getRoots();
  const backup = args.positional[0]
    ? { path: path.resolve(args.positional[0]) }
    : latestDatabaseBackup();
  if (!backup) throw new SyncError("No database backup found");
  if (
    !args.flags.has("yes") &&
    !(await confirm("Restore verified backup?", [
      backup.path,
      "Existing database will be backed up first. No WAL files will be deleted.",
    ]))
  )
    return;
  const safety = await withSyncLock(roots.config, { waitMs: LOCK_WAIT_MS }, () =>
    restoreDatabaseBackup(getDatabasePath(roots), backup.path, { offlineConfirmed: true }),
  );
  ok("Database restored");
  if (safety) detail(`Previous database: ${safety}`);
}

function runOverrides(): void {
  banner("per-machine overrides");
  const roots = getRoots();
  const file = overridesPath(roots.config);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, OVERRIDES_TEMPLATE);
    ok("Created the overrides file");
  }
  detail(file);
  write();
  info("Anything in this file stays on this machine and is re-applied after every pull.");
  write();
}

function runConfig(): void {
  banner("settings");
  const roots = getRoots();
  const file = settingsPath(roots.config);
  if (!fs.existsSync(file)) {
    fail("No settings file yet. Run `omds init`.");
    write();
    return;
  }
  detail(file);
  write();
  write(fs.readFileSync(file, "utf8").trimEnd());
  write();
}

function runHelp(): void {
  banner("sync OpenCode across machines");

  heading("Setup");
  command("init [name|owner/repo]", "Create a private sync repository");
  command("link <owner/repo>", "Use an existing sync repository");

  heading("Sync");
  command("push", "Send this machine's configuration");
  command("pull", "Apply the shared configuration");
  command("status", "Show what is in sync and what is not");

  heading("Sessions");
  command("sessions list", "Show recent sessions and their ids");
  command("sessions locations", "Show which project directories contain synced chats");
  command("sessions enable | disable", "Turn selective session sync on or off");
  command("sessions include <id>", "Always sync a session, ignoring the time window");
  command("sessions exclude <id>", "Never sync a session");

  heading("Safety and recovery");
  command("doctor [--json]", "Check repository and database integrity");
  command("backup", "Create a consistent verified SQLite backup");
  command("restore [file] --offline", "Restore after OpenCode is fully closed");
  heading("Machine-local");
  command("overrides", "Open the per-machine configuration patch");
  command("config", "Show the current settings");

  heading("Flags");
  command("--force", "Overwrite the other side on conflict");
  command("--dry-run", "Report what would change without doing it");

  write();
  rule();
  write(
    `  ${paint("docs", style.faint)}  ${paint("https://github.com/logser13/opencode-multidevice-sync", style.muted)}`,
  );
  write();
}

function command(name: string, description: string): void {
  const padded = name.padEnd(30);
  write(`  ${paint(padded, style.cyan)}${paint(description, style.muted)}`);
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has("version")) {
    console.log("0.1.1");
    return;
  }
  switch (args.command) {
    case "doctor":
      await runDoctor(args);
      return;
    case "backup":
      await runBackup();
      return;
    case "restore":
      await runRestore(args);
      return;
    case "push":
    case "pull":
      await runSync(args.command, args);
      return;
    case "status":
      runStatus();
      return;
    case "init":
      runInit(args, "init");
      return;
    case "link":
      runInit(args, "link");
      return;
    case "sessions":
      await runSessions(args);
      return;
    case "overrides":
      runOverrides();
      return;
    case "config":
      runConfig();
      return;
    case "help":
    case "--help":
    case "-h":
      runHelp();
      return;
    default:
      banner();
      fail(`Unknown command: ${args.command}`);
      write();
      info("Run `omds help` to see everything.");
      write();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const err = error as Error;
  write();
  if (err instanceof SyncError || err instanceof SetupError || err.name === "GitAuthError") {
    fail(err.message);
  } else {
    fail(err.message || String(error));
    if (process.env.OPENCODE_SYNC_VERBOSE === "1" && err.stack) {
      write();
      detail(err.stack);
    }
  }
  write();
  process.exit(1);
});
