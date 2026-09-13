import fs from "node:fs";
import { type SqliteDatabase, existingTables, openDatabase, tableColumns } from "./sqlite.js";
export interface DatabaseHealth {
  exists: boolean;
  ok: boolean;
  missingTables: string[];
  missingColumns: string[];
  quickCheck: string;
  foreignKeyViolations: number;
  orphanMessages: number;
  orphanParts: number;
  sessions: number;
  messages: number;
  parts: number;
}
const REQUIRED: Record<string, string[]> = {
  project: ["id"],
  session: ["id", "project_id", "directory", "title", "time_updated"],
  message: ["id", "session_id"],
  part: ["id", "session_id", "message_id"],
};
export function inspectDatabase(db: SqliteDatabase): DatabaseHealth {
  const tables = new Set(existingTables(db, Object.keys(REQUIRED)));
  const missingTables = Object.keys(REQUIRED).filter((t) => !tables.has(t));
  const missingColumns = Object.entries(REQUIRED).flatMap(([t, cols]) =>
    tables.has(t)
      ? cols.filter((c) => !tableColumns(db, t).includes(c)).map((c) => `${t}.${c}`)
      : [],
  );
  const quick = db
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(Object.values(row)[0]));
  const quickCheck = quick.join("; ");
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const n = (sql: string) => Number(db.prepare(sql).all()[0]?.n ?? 0);
  const valid = missingTables.length === 0 && missingColumns.length === 0;
  const orphanMessages = valid
    ? n(
        "SELECT COUNT(*) AS n FROM message m LEFT JOIN session s ON s.id=m.session_id WHERE s.id IS NULL",
      )
    : 0;
  const orphanParts = valid
    ? n(`SELECT COUNT(*) AS n FROM part p LEFT JOIN session s ON s.id=p.session_id
    LEFT JOIN message m ON m.id=p.message_id WHERE s.id IS NULL OR m.id IS NULL OR m.session_id<>p.session_id`)
    : 0;
  const sessions = tables.has("session") ? n("SELECT COUNT(*) AS n FROM session") : 0;
  const messages = tables.has("message") ? n("SELECT COUNT(*) AS n FROM message") : 0;
  const parts = tables.has("part") ? n("SELECT COUNT(*) AS n FROM part") : 0;
  return {
    exists: true,
    ok: valid && quickCheck === "ok" && !foreignKeyViolations && !orphanMessages && !orphanParts,
    missingTables,
    missingColumns,
    quickCheck,
    foreignKeyViolations,
    orphanMessages,
    orphanParts,
    sessions,
    messages,
    parts,
  };
}
export async function checkDatabaseHealth(file: string): Promise<DatabaseHealth> {
  if (!fs.existsSync(file))
    return {
      exists: false,
      ok: false,
      missingTables: Object.keys(REQUIRED),
      missingColumns: [],
      quickCheck: "missing",
      foreignKeyViolations: 0,
      orphanMessages: 0,
      orphanParts: 0,
      sessions: 0,
      messages: 0,
      parts: 0,
    };
  const db = await openDatabase(file, { readOnly: true });
  try {
    return inspectDatabase(db);
  } finally {
    db.close();
  }
}
export function healthProblems(h: DatabaseHealth): string[] {
  const out: string[] = [];
  if (!h.exists) out.push("OpenCode database does not exist");
  if (h.quickCheck !== "ok") out.push(`SQLite quick_check: ${h.quickCheck}`);
  if (h.missingTables.length) out.push(`missing tables: ${h.missingTables.join(", ")}`);
  if (h.missingColumns.length) out.push(`missing columns: ${h.missingColumns.join(", ")}`);
  if (h.foreignKeyViolations) out.push(`${h.foreignKeyViolations} foreign-key violations`);
  if (h.orphanMessages) out.push(`${h.orphanMessages} orphan messages`);
  if (h.orphanParts) out.push(`${h.orphanParts} orphan/mislinked parts`);
  return out;
}
