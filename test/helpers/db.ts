import { type BotDatabase, createDatabase, runMigrations } from "../../src/db/client";

export function makeTestDb(): BotDatabase {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}
