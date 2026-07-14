import { type BotDatabase, createDatabase } from "../../src/db/client";

export function makeTestDb(): BotDatabase {
  return createDatabase(":memory:");
}
