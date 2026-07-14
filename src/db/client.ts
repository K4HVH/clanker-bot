import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type BotDatabase = Database;

const SCHEMA_PATH = "./schema.sql";

// Open (or create) the SQLite database, apply pragmas, and ensure the schema
// exists. There are no migrations — schema.sql uses CREATE TABLE IF NOT EXISTS.
export function createDatabase(path: string): BotDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

// Small typed query helpers so callers write plain SQL without repeating generics.
export function one<T>(db: BotDatabase, sql: string, ...params: SQLQueryBindings[]): T | undefined {
  return db.query<T, SQLQueryBindings[]>(sql).get(...params) ?? undefined;
}

export function many<T>(db: BotDatabase, sql: string, ...params: SQLQueryBindings[]): T[] {
  return db.query<T, SQLQueryBindings[]>(sql).all(...params);
}

export function run(db: BotDatabase, sql: string, ...params: SQLQueryBindings[]): void {
  db.query<unknown, SQLQueryBindings[]>(sql).run(...params);
}
