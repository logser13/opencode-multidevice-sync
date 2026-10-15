import fs from "node:fs";
import { type SqliteDatabase, existingTables, openDatabase } from "./sqlite.js";

export function sessionTable(db: SqliteDatabase): "session" | "session_v2" {
  // A migrated database can contain both generations. V2 owns the active history.
  return existingTables(db, ["session_v2"]).length ? "session_v2" : "session";
}

export async function isV2Database(file: string): Promise<boolean> {
  if (!fs.existsSync(file)) return false;
  const immutable = !["-wal", "-shm", "-journal"].some((suffix) => fs.existsSync(file + suffix));
  const db = await openDatabase(file, { readOnly: true, immutable });
  try {
    return sessionTable(db) === "session_v2";
  } finally {
    db.close();
  }
}

export async function assertOfflineV2(file: string, confirmed?: boolean): Promise<void> {
  if (!confirmed)
    throw new Error("V2 import requires --offline; stop every OpenCode server/client first");
  if (
    fs.existsSync(file + "-journal") ||
    (fs.existsSync(file + "-wal") && fs.statSync(file + "-wal").size > 0)
  )
    throw new Error("V2 import refused: nonempty WAL/journal exists; stop OpenCode cleanly");
  if (["-wal", "-shm"].some((suffix) => fs.existsSync(file + suffix))) {
    // Node's read-only SQLite driver can leave an empty WAL after closing.
    // Let SQLite release it, never unlink a journal by hand. A live holder keeps it open.
    const db = await openDatabase(file);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (fs.existsSync(file + suffix))
      throw new Error(
        `V2 import refused: database journal ${suffix} exists; stop OpenCode cleanly`,
      );
  }
}
