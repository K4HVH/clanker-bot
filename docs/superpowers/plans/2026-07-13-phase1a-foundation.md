# clanker-bot Phase 1A — Foundation & Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a deployable "walking skeleton" of clanker-bot: it boots on Bun, migrates a SQLite database, loads modules, registers a `/ping` slash command, connects to Discord, and ships end-to-end through Docker + GitHub Actions.

**Architecture:** A config-driven modular monolith. A small kernel (env loader, logger, DB client, module system, command router, client bootstrap) plus a trivial `ping` feature module proves every layer. Feature logic lives in modules that receive an injected `AppContext`; the DB is reached only through the repository layer (introduced in Plan 1B). Runs as one Bun process in a Docker container.

**Tech Stack:** TypeScript (ESM), Bun (runtime + package manager + test runner), discord.js v14, Drizzle ORM on `bun:sqlite`, drizzle-kit migrations, Biome (lint/format), Docker + Docker Compose, GitHub Actions → GHCR.

## Global Constraints

- **Runtime:** Bun (dev + prod). `package.json` has `"type": "module"` (ESM everywhere).
- **discord.js:** `^14.26.0` (pin the major; v15 is pre-release). Never enable the Presence intent.
- **Intents:** `Guilds`, `GuildMembers`, `GuildModeration`, `GuildMessages`, `MessageContent`.
- **Database:** SQLite via `bun:sqlite`; Drizzle ORM (`drizzle-orm/bun-sqlite`) + `drizzle-kit` migrations. Startup pragmas: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.
- **Config-driven:** only bootstrap secrets live in env (`DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DATABASE_PATH`, `LOG_LEVEL`). All operational config is DB-backed and guild-scoped (used from Plan 1B).
- **Repository layer:** business logic never imports Drizzle tables directly (enforced from Plan 1B; the DB client here exposes the typed `db` for repositories to use).
- **Testing:** `bun test`; unit tests run against an in-memory SQLite (`:memory:`) with migrations applied. Pure logic is tested without a live Discord connection.
- **Commits:** Conventional Commits, one per task (frequent commits). Work on a branch; open a PR at the end of the plan.
- **Command registration:** per-guild (`Routes.applicationGuildCommands`) for instant iteration.
- **Default branch:** `master`. CI runs on PRs and pushes to `master`.

---

## File Structure

Created in this plan:

```
package.json                     # deps, scripts, "type": "module"
tsconfig.json                    # strict Bun/ESM TypeScript config
biome.json                       # lint + format config
.dockerignore                    # keep node_modules/.env/data/docs out of the image
Dockerfile                       # multi-stage oven/bun image
docker-compose.yml               # bot service: restart policy, env_file, data volume
drizzle.config.ts                # drizzle-kit config (sqlite dialect)
drizzle/                         # GENERATED migration SQL (committed)
.github/workflows/ci.yml         # PR/push gate: typecheck + lint + test
.github/workflows/release.yml    # push master/tag: build + push image to GHCR
src/
  index.ts                       # entrypoint: env -> db+migrate -> register -> login -> shutdown
  config/env.ts                  # loadEnv(source): typed, validated Env
  core/
    logger.ts                    # createLogger(level): leveled JSON logger
    context.ts                   # AppContext type (db, logger, env)
    module.ts                    # SlashCommand / Listener / BotModule types
    command-router.ts            # CommandRouter: dispatch + error boundary
    register-commands.ts         # collectCommandData + registerGuildCommands (REST)
    client.ts                    # createClient: intents, wiring, listeners
  db/
    schema.ts                    # Drizzle schema (guild_config)
    client.ts                    # createDatabase + runMigrations + BotDatabase type
  modules/
    index.ts                     # static module registry: modules: BotModule[]
    ping/index.ts                # /ping feature module
test/
  config/env.test.ts
  core/logger.test.ts
  core/command-router.test.ts
  core/register-commands.test.ts
  db/client.test.ts
  helpers/fakes.ts               # fake interaction, silent logger, test context
```

Each `src/**` file has one responsibility; kernel and feature code are separated so later phases add modules without touching the kernel.

---

## Task 1: Project bootstrap & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.dockerignore`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: the `bun test`, `bun run typecheck`, and `bun run lint` scripts every later task relies on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "clanker-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun run --watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "bun test",
    "db:generate": "drizzle-kit generate",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "discord.js": "^14.26.0",
    "drizzle-orm": "^0.44.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.1.0",
    "@types/bun": "latest",
    "drizzle-kit": "^0.31.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.1.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!drizzle/**"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

- [ ] **Step 4: Write `.dockerignore`**

```
node_modules
.git
.github
.env
.env.*
!.env.example
data
docs
*.log
.DS_Store
```

- [ ] **Step 5: Install dependencies**

Run: `bun install`
Expected: creates `bun.lock` and `node_modules/`. No errors.

- [ ] **Step 6: Write the smoke test**

```typescript
// test/smoke.test.ts
import { test, expect } from "bun:test";

test("test runner works", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: Run test, typecheck, and lint to verify tooling**

Run: `bun test && bun run typecheck && bun run lint`
Expected: test PASSES; typecheck exits 0; lint exits 0 (Biome may report formatting — run `bun run lint:fix` once and re-run if so).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json biome.json .dockerignore bun.lock test/smoke.test.ts
git commit -m "chore: bootstrap Bun + TypeScript project tooling"
```

---

## Task 2: Environment config loader

**Files:**
- Create: `src/config/env.ts`
- Test: `test/config/env.test.ts`

**Interfaces:**
- Produces: `interface Env { token: string; applicationId: string; guildId: string; databasePath: string; logLevel: "debug"|"info"|"warn"|"error" }` and `loadEnv(source: Record<string, string | undefined>): Env`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/config/env.test.ts
import { test, expect } from "bun:test";
import { loadEnv } from "../../src/config/env";

const base = {
  DISCORD_TOKEN: "t",
  DISCORD_APPLICATION_ID: "a",
  DISCORD_GUILD_ID: "g",
};

test("loads required values and applies defaults", () => {
  const env = loadEnv(base);
  expect(env.token).toBe("t");
  expect(env.applicationId).toBe("a");
  expect(env.guildId).toBe("g");
  expect(env.databasePath).toBe("./data/clanker.sqlite");
  expect(env.logLevel).toBe("info");
});

test("throws when a required variable is missing", () => {
  expect(() => loadEnv({ DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a" })).toThrow(
    /DISCORD_GUILD_ID/,
  );
});

test("rejects an invalid log level", () => {
  expect(() => loadEnv({ ...base, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config/env.test.ts`
Expected: FAIL — cannot find module `src/config/env`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/config/env.ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Env {
  token: string;
  applicationId: string;
  guildId: string;
  databasePath: string;
  logLevel: LogLevel;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function loadEnv(source: Record<string, string | undefined>): Env {
  const required = (name: string): string => {
    const value = source[name];
    if (!value || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  const level = source.LOG_LEVEL ?? "info";
  if (!LEVELS.includes(level as LogLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${level} (expected one of ${LEVELS.join(", ")})`);
  }

  return {
    token: required("DISCORD_TOKEN"),
    applicationId: required("DISCORD_APPLICATION_ID"),
    guildId: required("DISCORD_GUILD_ID"),
    databasePath: source.DATABASE_PATH ?? "./data/clanker.sqlite",
    logLevel: level as LogLevel,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config/env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts test/config/env.test.ts
git commit -m "feat: add validated environment config loader"
```

---

## Task 3: Structured logger

**Files:**
- Create: `src/core/logger.ts`
- Test: `test/core/logger.test.ts`

**Interfaces:**
- Consumes: `LogLevel` from `src/config/env.ts`.
- Produces: `interface Logger { debug/info/warn/error(msg: string, meta?: Record<string, unknown>): void }` and `createLogger(level: LogLevel, sink?: (line: string) => void): Logger`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/logger.test.ts
import { test, expect } from "bun:test";
import { createLogger } from "../../src/core/logger";

test("suppresses messages below the configured level", () => {
  const lines: string[] = [];
  const log = createLogger("warn", (l) => lines.push(l));
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  const levels = lines.map((l) => JSON.parse(l).level);
  expect(levels).toEqual(["warn", "error"]);
});

test("includes the message and metadata", () => {
  const lines: string[] = [];
  const log = createLogger("info", (l) => lines.push(l));
  log.info("hello", { guildId: "g1" });
  const parsed = JSON.parse(lines[0] as string);
  expect(parsed.msg).toBe("hello");
  expect(parsed.guildId).toBe("g1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/core/logger.test.ts`
Expected: FAIL — cannot find module `src/core/logger`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/logger.ts
import type { LogLevel } from "../config/env";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel,
  sink: (line: string) => void = console.log,
): Logger {
  const min = ORDER[level];
  const emit = (l: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (ORDER[l] < min) return;
    sink(JSON.stringify({ level: l, msg, ...meta, time: new Date().toISOString() }));
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/core/logger.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/logger.ts test/core/logger.test.ts
git commit -m "feat: add leveled JSON logger"
```

---

## Task 4: Database client, schema & migrations

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`
- Generated: `drizzle/` (migration SQL — committed)
- Test: `test/db/client.test.ts`

**Interfaces:**
- Produces: `guildConfig` table export; `type BotDatabase = BunSQLiteDatabase<typeof schema>`; `createDatabase(path: string): BotDatabase`; `runMigrations(db: BotDatabase): void`.

- [ ] **Step 1: Write the schema**

```typescript
// src/db/schema.ts
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Guild-scoped key/value config. `value` holds JSON-encoded data.
export const guildConfig = sqliteTable(
  "guild_config",
  {
    guildId: text("guild_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.key] })],
);
```

- [ ] **Step 2: Write `drizzle.config.ts`**

```typescript
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_PATH ?? "./data/clanker.sqlite" },
});
```

- [ ] **Step 3: Write the DB client**

```typescript
// src/db/client.ts
import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type BotDatabase = BunSQLiteDatabase<typeof schema>;

const MIGRATIONS_DIR = "./drizzle";

export function createDatabase(path: string): BotDatabase {
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
```

- [ ] **Step 4: Write the failing test**

```typescript
// test/db/client.test.ts
import { test, expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDatabase, runMigrations } from "../../src/db/client";
import { guildConfig } from "../../src/db/schema";

test("migrations create guild_config and rows round-trip", () => {
  const db = createDatabase(":memory:");
  runMigrations(db);

  db.insert(guildConfig)
    .values({ guildId: "g1", key: "mod_log_channel_id", value: '"123"', updatedAt: 1 })
    .run();

  const rows = db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.guildId, "g1"), eq(guildConfig.key, "mod_log_channel_id")))
    .all();

  expect(rows.length).toBe(1);
  expect(rows[0]?.value).toBe('"123"');
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test test/db/client.test.ts`
Expected: FAIL — `migrate()` throws because `./drizzle` has no migrations yet.

- [ ] **Step 6: Generate the migration**

Run: `bun run db:generate`
Expected: creates `drizzle/0000_*.sql` and `drizzle/meta/` describing the `guild_config` table.

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test test/db/client.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/client.ts drizzle.config.ts drizzle test/db/client.test.ts
git commit -m "feat: add Drizzle bun:sqlite client, schema, and migrations"
```

---

## Task 5: Module system types & command router

**Files:**
- Create: `src/core/context.ts`, `src/core/module.ts`, `src/core/command-router.ts`, `test/helpers/fakes.ts`
- Test: `test/core/command-router.test.ts`

**Interfaces:**
- Consumes: `BotDatabase` (`src/db/client.ts`), `Logger` (`src/core/logger.ts`), `Env` (`src/config/env.ts`).
- Produces:
  - `interface AppContext { db: BotDatabase; logger: Logger; env: Env }`
  - `type CommandData = Pick<SlashCommandBuilder, "name" | "toJSON">`
  - `interface SlashCommand { data: CommandData; execute(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> }`
  - `interface Listener<K> { event: K; once?: boolean; handle(ctx: AppContext, ...args: ClientEvents[K]): Promise<void> | void }`
  - `interface BotModule { name: string; commands?: SlashCommand[]; listeners?: Listener[] }`
  - `class CommandRouter { constructor(commands: SlashCommand[], ctx: AppContext); handle(interaction: ChatInputCommandInteraction): Promise<void> }`

- [ ] **Step 1: Write the context type**

```typescript
// src/core/context.ts
import type { Env } from "../config/env";
import type { BotDatabase } from "../db/client";
import type { Logger } from "./logger";

export interface AppContext {
  db: BotDatabase;
  logger: Logger;
  env: Env;
}
```

- [ ] **Step 2: Write the module types**

```typescript
// src/core/module.ts
import type {
  ChatInputCommandInteraction,
  ClientEvents,
  SlashCommandBuilder,
} from "discord.js";
import type { AppContext } from "./context";

// Structural type satisfied by SlashCommandBuilder and its subcommand/option variants.
export type CommandData = Pick<SlashCommandBuilder, "name" | "toJSON">;

export interface SlashCommand {
  data: CommandData;
  execute(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
}

export interface Listener<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  handle(ctx: AppContext, ...args: ClientEvents[K]): Promise<void> | void;
}

export interface BotModule {
  name: string;
  commands?: SlashCommand[];
  listeners?: Listener[];
}
```

- [ ] **Step 3: Write the test helpers**

```typescript
// test/helpers/fakes.ts
import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../src/core/context";
import { createLogger } from "../../src/core/logger";

export function silentContext(): AppContext {
  return {
    db: undefined as unknown as AppContext["db"],
    logger: createLogger("error", () => {}),
    env: {} as AppContext["env"],
  };
}

export interface FakeInteraction {
  commandName: string;
  replied: boolean;
  deferred: boolean;
  replies: unknown[];
  reply(opts: unknown): Promise<void>;
  followUp(opts: unknown): Promise<void>;
}

export function fakeInteraction(commandName: string): FakeInteraction & ChatInputCommandInteraction {
  const state: FakeInteraction = {
    commandName,
    replied: false,
    deferred: false,
    replies: [],
    async reply(opts: unknown) {
      state.replied = true;
      state.replies.push(opts);
    },
    async followUp(opts: unknown) {
      state.replies.push(opts);
    },
  };
  return state as FakeInteraction & ChatInputCommandInteraction;
}
```

- [ ] **Step 4: Write the failing test**

```typescript
// test/core/command-router.test.ts
import { test, expect } from "bun:test";
import { CommandRouter } from "../../src/core/command-router";
import type { SlashCommand } from "../../src/core/module";
import { fakeInteraction, silentContext } from "../helpers/fakes";

function cmd(name: string, execute: SlashCommand["execute"]): SlashCommand {
  return { data: { name, toJSON: () => ({}) } as SlashCommand["data"], execute };
}

test("dispatches to the matching command", async () => {
  let called = false;
  const router = new CommandRouter([cmd("ping", async () => { called = true; })], silentContext());
  await router.handle(fakeInteraction("ping"));
  expect(called).toBe(true);
});

test("ignores unknown commands without throwing", async () => {
  const router = new CommandRouter([], silentContext());
  await router.handle(fakeInteraction("nope"));
  // no throw = pass
});

test("catches command errors and replies ephemerally", async () => {
  const router = new CommandRouter(
    [cmd("boom", async () => { throw new Error("kaboom"); })],
    silentContext(),
  );
  const interaction = fakeInteraction("boom");
  await router.handle(interaction);
  expect(interaction.replied).toBe(true);
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test test/core/command-router.test.ts`
Expected: FAIL — cannot find module `src/core/command-router`.

- [ ] **Step 6: Write the implementation**

```typescript
// src/core/command-router.ts
import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { AppContext } from "./context";
import type { SlashCommand } from "./module";

export class CommandRouter {
  private readonly commands = new Map<string, SlashCommand>();

  constructor(commands: SlashCommand[], private readonly ctx: AppContext) {
    for (const command of commands) this.commands.set(command.data.name, command);
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.commands.get(interaction.commandName);
    if (!command) {
      this.ctx.logger.warn("unknown command", { commandName: interaction.commandName });
      return;
    }
    try {
      await command.execute(interaction, this.ctx);
    } catch (error) {
      this.ctx.logger.error("command failed", {
        commandName: interaction.commandName,
        error: error instanceof Error ? error.message : String(error),
      });
      const payload = { content: "Something went wrong running that command.", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test test/core/command-router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add src/core/context.ts src/core/module.ts src/core/command-router.ts test/helpers/fakes.ts test/core/command-router.test.ts
git commit -m "feat: add module types, app context, and command router"
```

---

## Task 6: The `/ping` module & static registry

**Files:**
- Create: `src/modules/ping/index.ts`, `src/modules/index.ts`

**Interfaces:**
- Consumes: `SlashCommand`, `BotModule` (`src/core/module.ts`).
- Produces: `pingModule: BotModule`; `modules: BotModule[]` (the registry the loader and registrar read).

- [ ] **Step 1: Write the ping module**

```typescript
// src/modules/ping/index.ts
import { MessageFlags, SlashCommandBuilder } from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";

const ping: SlashCommand = {
  data: new SlashCommandBuilder().setName("ping").setDescription("Check that the bot is alive."),
  async execute(interaction) {
    const latency = Math.round(interaction.client.ws.ping);
    await interaction.reply({
      content: `🏓 Pong! Gateway latency: ${latency}ms`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const pingModule: BotModule = { name: "ping", commands: [ping] };
```

- [ ] **Step 2: Write the static registry**

```typescript
// src/modules/index.ts
import type { BotModule } from "../core/module";
import { pingModule } from "./ping";

// Modules are registered explicitly (no filesystem scanning) so Bun never has to
// glob at runtime, and the set of features is type-checked.
export const modules: BotModule[] = [pingModule];
```

- [ ] **Step 3: Verify it type-checks**

Run: `bun run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/modules/ping/index.ts src/modules/index.ts
git commit -m "feat: add /ping module and static module registry"
```

---

## Task 7: Command registration & client bootstrap

**Files:**
- Create: `src/core/register-commands.ts`, `src/core/client.ts`
- Test: `test/core/register-commands.test.ts`

**Interfaces:**
- Consumes: `BotModule` (`src/core/module.ts`), `AppContext` (`src/core/context.ts`), `Env` (`src/config/env.ts`).
- Produces:
  - `collectCommandData(modules: BotModule[]): unknown[]`
  - `registerGuildCommands(env: Env, modules: BotModule[]): Promise<number>`
  - `createClient(modules: BotModule[], ctx: AppContext): Client`

- [ ] **Step 1: Write the failing test**

```typescript
// test/core/register-commands.test.ts
import { test, expect } from "bun:test";
import { collectCommandData } from "../../src/core/register-commands";
import { modules } from "../../src/modules";

test("collects one JSON command payload per registered command", () => {
  const data = collectCommandData(modules);
  expect(data.length).toBeGreaterThanOrEqual(1);
  const names = data.map((d) => (d as { name: string }).name);
  expect(names).toContain("ping");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/core/register-commands.test.ts`
Expected: FAIL — cannot find module `src/core/register-commands`.

- [ ] **Step 3: Write the command registrar**

```typescript
// src/core/register-commands.ts
import { REST, Routes } from "discord.js";
import type { Env } from "../config/env";
import type { BotModule } from "./module";

export function collectCommandData(modules: BotModule[]): unknown[] {
  return modules.flatMap((m) => m.commands ?? []).map((c) => c.data.toJSON());
}

export async function registerGuildCommands(env: Env, modules: BotModule[]): Promise<number> {
  const body = collectCommandData(modules);
  const rest = new REST().setToken(env.token);
  await rest.put(Routes.applicationGuildCommands(env.applicationId, env.guildId), { body });
  return body.length;
}
```

- [ ] **Step 4: Write the client bootstrap**

```typescript
// src/core/client.ts
import { Client, Events, GatewayIntentBits } from "discord.js";
import { CommandRouter } from "./command-router";
import type { AppContext } from "./context";
import type { BotModule } from "./module";

export function createClient(modules: BotModule[], ctx: AppContext): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const commands = modules.flatMap((m) => m.commands ?? []);
  const router = new CommandRouter(commands, ctx);

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) void router.handle(interaction);
  });

  for (const module of modules) {
    for (const listener of module.listeners ?? []) {
      const invoke = (...args: unknown[]) =>
        (listener.handle as (ctx: AppContext, ...a: unknown[]) => void)(ctx, ...args);
      if (listener.once) client.once(listener.event, invoke);
      else client.on(listener.event, invoke);
    }
  }

  client.once(Events.ClientReady, (c) => {
    ctx.logger.info("logged in", { tag: c.user.tag });
  });

  return client;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/core/register-commands.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the whole suite and types**

Run: `bun test && bun run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/register-commands.ts src/core/client.ts test/core/register-commands.test.ts
git commit -m "feat: add guild command registration and client bootstrap"
```

---

## Task 8: Entrypoint & graceful shutdown

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: everything above — `loadEnv`, `createLogger`, `createDatabase`, `runMigrations`, `registerGuildCommands`, `createClient`, `modules`.

- [ ] **Step 1: Write the entrypoint**

```typescript
// src/index.ts
import { loadEnv } from "./config/env";
import { createClient } from "./core/client";
import type { AppContext } from "./core/context";
import { createLogger } from "./core/logger";
import { registerGuildCommands } from "./core/register-commands";
import { createDatabase, runMigrations } from "./db/client";
import { modules } from "./modules";

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const logger = createLogger(env.logLevel);

  const db = createDatabase(env.databasePath);
  runMigrations(db);
  logger.info("migrations applied", { databasePath: env.databasePath });

  const ctx: AppContext = { db, logger, env };

  const registered = await registerGuildCommands(env, modules);
  logger.info("registered guild commands", { count: registered, guildId: env.guildId });

  const client = createClient(modules, ctx);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    await client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(env.token);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "fatal startup error", error: String(error) }));
  process.exit(1);
});
```

- [ ] **Step 2: Verify it type-checks**

Run: `bun run typecheck`
Expected: exits 0.

- [ ] **Step 3: Verify it starts and fails cleanly without credentials**

Run: `DISCORD_TOKEN= DISCORD_APPLICATION_ID= DISCORD_GUILD_ID= bun run src/index.ts`
Expected: exits non-zero with `Missing required environment variable: DISCORD_TOKEN` (proves the entrypoint wiring runs).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add entrypoint with migrations, registration, and graceful shutdown"
```

---

## Task 9: Containerization

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`

**Interfaces:**
- Consumes: the full app + `drizzle/` migrations + `package.json`/`bun.lock`.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY drizzle ./drizzle
COPY src ./src
# Migrations run on startup inside src/index.ts before the gateway connects.
CMD ["bun", "run", "src/index.ts"]
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  bot:
    build: .
    image: ghcr.io/k4hvh/clanker-bot:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
```

- [ ] **Step 3: Build the image**

Run: `docker build -t clanker-bot:test .`
Expected: build succeeds through all stages; final image created. (Requires Docker available locally; if not, this is validated by CI in Task 10.)

- [ ] **Step 4: Validate the compose file**

Run: `docker compose config`
Expected: prints the resolved config with no errors.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: containerize the bot with Docker + Compose"
```

---

## Task 10: CI/CD workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the `typecheck`, `lint`, `test` scripts and the Dockerfile.

- [ ] **Step 1: Write the CI (merge gate) workflow**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [master]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun test
```

- [ ] **Step 2: Write the release (build + push) workflow**

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    branches: [master]
    tags: ["v*"]

jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=sha
            type=raw,value=latest,enable={{is_default_branch}}
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 3: Verify workflow YAML is well-formed**

Run: `bunx --bun js-yaml .github/workflows/ci.yml > /dev/null && bunx --bun js-yaml .github/workflows/release.yml > /dev/null`
Expected: no output, exit 0 (valid YAML). If `js-yaml` is unavailable offline, visually confirm indentation instead.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: add PR gate and GHCR release workflows"
```

---

## Task 11: Open the PR & verify the pipeline

**Files:** none (integration/verification).

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Phase 1A: foundation & deploy pipeline" --body "Walking skeleton: boots on Bun, migrates SQLite, registers /ping, connects, and ships via Docker + CI. Implements docs/superpowers/plans/2026-07-13-phase1a-foundation.md."
```

- [ ] **Step 2: Confirm CI passes**

Run: `gh pr checks --watch`
Expected: the `CI / check` job passes (typecheck + lint + test).

- [ ] **Step 3: Live smoke test (requires `.env` populated + bot invited)**

Run: `bun run start`
Expected: logs `migrations applied`, `registered guild commands`, and `logged in`. In Discord, `/ping` replies with the gateway latency. If credentials aren't ready yet, note this step as pending and proceed to merge on green CI.

- [ ] **Step 4: Merge**

```bash
gh pr merge --squash --delete-branch
```

Expected: merge to `master` triggers the Release workflow, which pushes `ghcr.io/k4hvh/clanker-bot:latest` (+ SHA tag) to GHCR.

---

## Self-Review

**1. Spec coverage** (against the Phase 1 spec §8 and architecture §4):
- Kernel: env loader (T2), logger (T3), module loader/router (T5, T7), client bootstrap + graceful shutdown (T7, T8) ✓
- Data layer: Drizzle + `bun:sqlite` + pragmas + migrations (T4); repository layer is introduced in Plan 1B (the DB client here exposes the typed `db` for it) ✓
- Config service, logging module, and manual moderation commands: **intentionally deferred to Plan 1B** — this plan is the foundation/skeleton only. Noted in the plan intro and handoff.
- Per-guild command registration (T7); intents set correctly, no Presence (T7) ✓
- Containerization (T9) + CI→GHCR (T10) + restart policy (T9) ✓
- Acceptance criteria mapping: "boots, migrates, registers, connects" → T8/T11; "container persists data on volume" → T9; "CI runs on PR, image on merge" → T10 ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command step shows expected output. ✓

**3. Type consistency:** `AppContext` (T5) is consumed unchanged by the router (T5), client (T7), and entrypoint (T8). `SlashCommand.data: CommandData = Pick<SlashCommandBuilder,"name"|"toJSON">` is satisfied by the `SlashCommandBuilder` used in the ping module (T6) and read by `collectCommandData` (T7). `BotDatabase` (T4) flows into `AppContext` (T5) and the entrypoint (T8). `createDatabase`/`runMigrations` signatures are consistent across T4, T8, and the tests. ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-phase1a-foundation.md`.
