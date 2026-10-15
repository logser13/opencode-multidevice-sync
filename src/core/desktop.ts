import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DesktopState {
  stateFile?: string;
  activeDirectory?: string;
  knownProjects: string[];
  readable: boolean;
  error?: string;
}

export interface DesktopStateOptions {
  generation?: "v1" | "v2";
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  xdgConfigHome?: string;
}

function candidateStateFile(options: DesktopStateOptions): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  if (platform === "win32") {
    const appData = options.appData ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "ai.opencode.desktop", "opencode.global.dat");
  }
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "ai.opencode.desktop",
      "opencode.global.dat",
    );
  }
  const config = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.join(config, "ai.opencode.desktop", "opencode.global.dat");
}

function parseEmbedded(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function readDesktopState(options: DesktopStateOptions = {}): DesktopState {
  if (options.generation === "v2") return { knownProjects: [], readable: false };
  const stateFile = candidateStateFile(options);
  if (!fs.existsSync(stateFile)) return { stateFile, knownProjects: [], readable: false };
  try {
    const root = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    const server = parseEmbedded(root.server);
    const layout = parseEmbedded(root.layout);
    const projects = server?.projects as Record<string, unknown> | undefined;
    const localProjects = Array.isArray(projects?.local)
      ? (projects?.local as Array<Record<string, unknown>>)
      : [];
    const knownProjects = localProjects
      .map((item) => item.worktree)
      .filter((item): item is string => typeof item === "string");
    const lastProject = server?.lastProject as Record<string, unknown> | undefined;
    const home = layout?.home as Record<string, unknown> | undefined;
    const selection = home?.selection as Record<string, unknown> | undefined;
    const activeDirectory =
      typeof lastProject?.local === "string"
        ? lastProject.local
        : typeof selection?.directory === "string"
          ? selection.directory
          : undefined;
    return { stateFile, activeDirectory, knownProjects, readable: true };
  } catch (error) {
    return {
      stateFile,
      knownProjects: [],
      readable: false,
      error: (error as Error).message,
    };
  }
}

export function normalizeDirectory(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
export interface SessionLocationLike {
  directory: string;
  rootSessions: number;
}

export interface VisibilityAssessment {
  activeDirectory?: string;
  totalRootSessions: number;
  visibleRootSessions: number;
  mismatch: boolean;
  warning?: string;
}

export function assessSessionVisibility(
  locations: SessionLocationLike[],
  desktop: DesktopState,
  platform: NodeJS.Platform = process.platform,
): VisibilityAssessment {
  const totalRootSessions = locations.reduce((sum, item) => sum + item.rootSessions, 0);
  if (!desktop.activeDirectory || totalRootSessions === 0) {
    return {
      activeDirectory: desktop.activeDirectory,
      totalRootSessions,
      visibleRootSessions: 0,
      mismatch: false,
    };
  }
  const active = normalizeDirectory(desktop.activeDirectory, platform);
  const visibleRootSessions = locations
    .filter((item) => normalizeDirectory(item.directory, platform) === active)
    .reduce((sum, item) => sum + item.rootSessions, 0);
  const mismatch = visibleRootSessions === 0 && totalRootSessions > 0;
  return {
    activeDirectory: desktop.activeDirectory,
    totalRootSessions,
    visibleRootSessions,
    mismatch,
    warning: mismatch
      ? `OpenCode Desktop is open at ${desktop.activeDirectory}, but synced sessions belong to other directories.`
      : undefined,
  };
}
