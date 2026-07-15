import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type BotDatabase = Database;

const SCHEMA_PATH = "./schema.sql";

// Additive schema evolution: SQLite has no `ADD COLUMN IF NOT EXISTS`, so add any
// declared column an existing table is missing. This is NOT a migration framework —
// just enough to let a live-data table (e.g. tickets with real records) gain columns
// without dropping it. schema.sql stays the source of truth for fresh installs.
function ensureColumns(db: Database, table: string, columns: Record<string, string>): void {
  const present = new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, decl] of Object.entries(columns)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

// Open (or create) the SQLite database, apply pragmas, and ensure the schema. Tables
// use CREATE TABLE IF NOT EXISTS; ensureColumns bridges pre-existing tables up to the
// current column set (there is still no migration framework).
export function createDatabase(path: string): BotDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  ensureColumns(db, "tickets", {
    claimed_by: "TEXT",
    last_activity_at: "INTEGER",
    closed_by: "TEXT",
    close_reason: "TEXT",
  });
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
