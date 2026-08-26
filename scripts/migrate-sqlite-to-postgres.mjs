import { promises as fs } from "node:fs";
import path from "node:path";

import { createDatabaseClient } from "../src/databaseClient.mjs";
import { legacyPlatformTableNames, migrateLegacyPlatformRows } from "../src/legacyPlatformMigration.mjs";
import { createProjectPersistence } from "../src/projectPersistence.mjs";

const root = process.cwd();
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const legacyFile = path.resolve(root, process.env.VIBEBOARD_LEGACY_SQLITE_FILE || "vibeboard.db");

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required. Refusing to migrate without an explicit PostgreSQL target.");
}

const snapshot = await fs.readFile(legacyFile).catch(() => null);
if (!snapshot?.length) {
  throw new Error(`Legacy SQLite file was not found or empty: ${legacyFile}`);
}

const pg = createDatabaseClient(databaseUrl, process.env);
try {
  const persistence = createProjectPersistence({
    pg,
    env: { ...process.env, VIBEBOARD_PUBLIC_DEPLOYMENT: "1" },
  });
  await persistence.initSchema();
  await persistence.migrateLegacySqliteSnapshot(snapshot);
  const platformRows = await readLegacyPlatformRows(snapshot);
  const platformStats = await migrateLegacyPlatformRows(pg, platformRows);
  console.log(`VibeBoard records migrated from ${path.basename(legacyFile)} into PostgreSQL: ${JSON.stringify(platformStats)}.`);
} finally {
  await pg?.end({ timeout: 5 }).catch(() => {});
}

async function readLegacyPlatformRows(snapshot) {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(snapshot);
  try {
    return Object.fromEntries(legacyPlatformTableNames().map(table => [table, readRows(db, table)]));
  } finally {
    db.close();
  }
}

function readRows(db, table) {
  const statement = db.prepare(`SELECT * FROM ${table}`);
  const rows = [];
  try {
    while (statement.step()) rows.push(statement.getAsObject());
  } catch {
    return [];
  } finally {
    statement.free();
  }
  return rows;
}
