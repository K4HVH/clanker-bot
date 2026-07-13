import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type BotDatabase = BunSQLiteDatabase<typeof schema>;

const MIGRATIONS_DIR = "./drizzle";

export function createDatabase(path: string): BotDatabase {
  // bun:sqlite creates the file but not its parent directory.
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle({ client: sqlite, schema });
}

export function runMigrations(db: BotDatabase): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
