import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkDatabaseHealth, healthProblems } from "./health.js";
import { getDataRoot } from "./paths.js";
import { openDatabase } from "./sqlite.js";
export interface BackupInfo {
  path: string;
  createdAt: number;
  bytes: number;
}
export function backupRoot(dataRoot = getDataRoot()): string {
  return path.join(dataRoot, "backups", "opencode-multidevice-sync");
}
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
export function listDatabaseBackups(root = backupRoot()): BackupInfo[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => /^opencode-.*\.db$/.test(n))
    .filter((n) => fs.statSync(path.join(root, n)).isFile())
    .map((n) => {
      const p = path.join(root, n);
      const s = fs.statSync(p);
      return { path: p, createdAt: s.mtimeMs, bytes: s.size };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function createDatabaseBackup(
  file: string,
  root = backupRoot(path.dirname(file)),
  retention = 10,
): Promise<BackupInfo> {
  if (!Number.isInteger(retention) || retention < 1)
    throw new Error("backupRetention must be a positive integer");
  if (!fs.existsSync(file)) throw new Error(`Database not found: ${file}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, `opencode-${timestamp()}-${randomUUID()}.db`);
  const temp = destination + ".partial";
  const db = await openDatabase(file, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(temp);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  } finally {
    db.close();
  }
  try {
    const health = await checkDatabaseHealth(temp);
    if (!health.ok)
      throw new Error(`Backup validation failed: ${healthProblems(health).join("; ")}`);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, destination);
    const stat = fs.statSync(destination);
    // Retention is applied only after a new backup passed integrity checks.
    for (const old of listDatabaseBackups(root)
      .filter((b) => b.path !== destination)
      .slice(retention - 1))
      fs.rmSync(old.path);
    return { path: destination, createdAt: stat.mtimeMs, bytes: stat.size };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
export function latestDatabaseBackup(root = backupRoot()): BackupInfo | undefined {
  return listDatabaseBackups(root)[0];
}
export async function restoreDatabaseBackup(
  file: string,
  backupFile: string,
  options: { offlineConfirmed?: boolean } = {},
): Promise<string | undefined> {
  if (!options.offlineConfirmed)
    throw new Error(
      "Restore requires explicit offline confirmation; close all OpenCode processes first",
    );
  if (path.resolve(file) === path.resolve(backupFile))
    throw new Error("Backup and destination must differ");
  const assertNoJournals = () => {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (fs.existsSync(file + suffix))
        throw new Error(
          `Restore refused: ${suffix} exists. Close OpenCode cleanly; do not delete journals manually.`,
        );
    }
  };
  assertNoJournals();
  const health = await checkDatabaseHealth(backupFile);
  if (!health.ok) throw new Error(`Invalid backup: ${healthProblems(health).join("; ")}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + `.restore-${randomUUID()}`;
  fs.copyFileSync(backupFile, temp);
  fs.chmodSync(temp, 0o600);
  let safety: string | undefined;
  try {
    if (fs.existsSync(file))
      safety = (
        await createDatabaseBackup(
          file,
          path.join(backupRoot(path.dirname(file)), "before-restore"),
          10,
        )
      ).path;
    assertNoJournals();
    fs.renameSync(temp, file);
    // A restored snapshot must not inherit baselines from a newer database.
    if (fs.existsSync(file + ".omds-bases.json"))
      fs.renameSync(file + ".omds-bases.json", file + `.omds-bases-before-${randomUUID()}.json`);
    return safety;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
