import { type BotDatabase, createDatabase } from "../../src/db/index";

export function makeTestDb(): BotDatabase {
  return createDatabase(":memory:");
}
