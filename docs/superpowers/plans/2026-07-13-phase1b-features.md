# clanker-bot Phase 1B — Config, Logging & Manual Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1A walking skeleton into a useful moderation bot: DB-backed guild config with a `/config` command, an audit-logging module (edits/deletes/joins/leaves + a mod-action log), and reason-required manual moderation commands backed by a persistent case ledger.

**Architecture:** Builds on the 1A kernel. New data reached only through the repository layer. A stateful `ConfigService` (with cache) is added to `AppContext`; case storage and mod-log rendering are stateless function modules. Discord-specific glue stays thin; pure logic (config (de)serialization, case numbering, duration parsing, hierarchy checks, embed building) is unit-tested against an in-memory DB and plain inputs.

**Tech Stack:** As Phase 1A — TypeScript, Bun, discord.js v14, Drizzle ORM on `bun:sqlite`, drizzle-kit, Biome, `bun test`.

## Global Constraints

- All Phase 1A constraints still apply (Bun runtime, discord.js `^14.26`, repository layer, `bun test` with in-memory SQLite, Conventional Commits, per-task commits, Biome formatting via `bun run lint:fix`).
- **Config lives in `guild_config`** (guild-scoped, JSON-encoded values). Config keys: `mod_log_channel_id`, `member_log_channel_id`, `dm_on_action`.
- **Moderation authorization:** commands gate on Discord permissions via `setDefaultMemberPermissions(...)` PLUS a runtime role-hierarchy check (`checkActionable`). No configured mod-role list in this phase.
- **Every moderation action** persists a `cases` row (per-guild sequential `case_number`) and posts an embed to the configured mod-log channel; DMs the target only when `dm_on_action` is true (best-effort).
- **Timeouts** are capped at Discord's 28-day maximum.
- Run `bun run lint:fix` before each task's gate; the gate is `bun test && bun run typecheck && bun run lint`.

---

## File Structure

Created/modified in this plan:

```
src/core/context.ts              # MODIFY: add `config: ConfigService`
src/db/schema.ts                 # MODIFY: add `cases` table
drizzle/                         # GENERATED: new migration for `cases`
src/repositories/
  config.repository.ts           # guild_config CRUD (functions over db)
  cases.repository.ts            # cases CRUD + sequential numbering
src/services/
  config.service.ts              # ConfigService (typed, cached) + CONFIG_KEYS
  moderation.service.ts          # checkActionable() pure hierarchy checks
  modlog.service.ts              # pure embed builders + send helpers
src/util/duration.ts             # parseDuration / formatDuration / MAX_TIMEOUT_MS
src/modules/
  index.ts                       # MODIFY: register config, logging, moderation
  config/index.ts                # /config view | log-channel | dm-on-action
  logging/index.ts               # message + member event listeners
  moderation/
    shared.ts                    # recordAndAnnounce + assertActionable helpers
    index.ts                     # moderationModule: the 8 commands
    warn.ts note.ts case.ts history.ts
    timeout.ts kick.ts ban.ts unban.ts
src/index.ts                     # MODIFY: construct ConfigService into AppContext
test/helpers/fakes.ts            # MODIFY: silentContext includes a ConfigService
test/repositories/config.repository.test.ts
test/services/config.service.test.ts
test/repositories/cases.repository.test.ts
test/util/duration.test.ts
test/services/moderation.service.test.ts
test/services/modlog.service.test.ts
test/helpers/db.ts               # test DB helper (in-memory + migrations)
```

---

## Task 1: Config repository & service

**Files:**
- Create: `src/repositories/config.repository.ts`, `src/services/config.service.ts`, `test/helpers/db.ts`
- Test: `test/repositories/config.repository.test.ts`, `test/services/config.service.test.ts`

**Interfaces:**
- Consumes: `BotDatabase` (`src/db/client.ts`), `guildConfig` (`src/db/schema.ts`).
- Produces:
  - config repo functions: `getConfigRow(db, guildId, key): string | undefined`, `setConfigRow(db, guildId, key, value, updatedAt): void`, `listConfigRows(db, guildId): {key,value}[]`, `deleteConfigRow(db, guildId, key): void`.
  - `CONFIG_KEYS` constant; `class ConfigService { get<T>(guildId,key): T|undefined; set(guildId,key,value): void; unset(guildId,key): void; all(guildId): Record<string,unknown> }`.
  - test helper: `makeTestDb(): BotDatabase` (in-memory + migrations).

- [ ] **Step 1: Write the test DB helper**

```typescript
// test/helpers/db.ts
import { createDatabase, runMigrations } from "../../src/db/client";
import type { BotDatabase } from "../../src/db/client";

export function makeTestDb(): BotDatabase {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}
```

- [ ] **Step 2: Write the config repository**

```typescript
// src/repositories/config.repository.ts
import { and, eq } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { guildConfig } from "../db/schema";

export function getConfigRow(db: BotDatabase, guildId: string, key: string): string | undefined {
  const row = db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.guildId, guildId), eq(guildConfig.key, key)))
    .get();
  return row?.value;
}

export function setConfigRow(
  db: BotDatabase,
  guildId: string,
  key: string,
  value: string,
  updatedAt: number,
): void {
  db.insert(guildConfig)
    .values({ guildId, key, value, updatedAt })
    .onConflictDoUpdate({
      target: [guildConfig.guildId, guildConfig.key],
      set: { value, updatedAt },
    })
    .run();
}

export function listConfigRows(
  db: BotDatabase,
  guildId: string,
): { key: string; value: string }[] {
  return db
    .select({ key: guildConfig.key, value: guildConfig.value })
    .from(guildConfig)
    .where(eq(guildConfig.guildId, guildId))
    .all();
}

export function deleteConfigRow(db: BotDatabase, guildId: string, key: string): void {
  db.delete(guildConfig)
    .where(and(eq(guildConfig.guildId, guildId), eq(guildConfig.key, key)))
    .run();
}
```

- [ ] **Step 3: Write the config service**

```typescript
// src/services/config.service.ts
import type { BotDatabase } from "../db/client";
import {
  deleteConfigRow,
  getConfigRow,
  listConfigRows,
  setConfigRow,
} from "../repositories/config.repository";

export const CONFIG_KEYS = {
  modLogChannelId: "mod_log_channel_id",
  memberLogChannelId: "member_log_channel_id",
  dmOnAction: "dm_on_action",
} as const;

export class ConfigService {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly db: BotDatabase) {}

  private cacheKey(guildId: string, key: string): string {
    return `${guildId}:${key}`;
  }

  get<T>(guildId: string, key: string): T | undefined {
    const ck = this.cacheKey(guildId, key);
    if (this.cache.has(ck)) return this.cache.get(ck) as T | undefined;
    const raw = getConfigRow(this.db, guildId, key);
    const value = raw === undefined ? undefined : (JSON.parse(raw) as T);
    this.cache.set(ck, value);
    return value;
  }

  set(guildId: string, key: string, value: unknown): void {
    setConfigRow(this.db, guildId, key, JSON.stringify(value), Date.now());
    this.cache.set(this.cacheKey(guildId, key), value);
  }

  unset(guildId: string, key: string): void {
    deleteConfigRow(this.db, guildId, key);
    this.cache.set(this.cacheKey(guildId, key), undefined);
  }

  all(guildId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of listConfigRows(this.db, guildId)) out[row.key] = JSON.parse(row.value);
    return out;
  }
}
```

- [ ] **Step 4: Write the tests**

```typescript
// test/repositories/config.repository.test.ts
import { expect, test } from "bun:test";
import {
  deleteConfigRow,
  getConfigRow,
  listConfigRows,
  setConfigRow,
} from "../../src/repositories/config.repository";
import { makeTestDb } from "../helpers/db";

test("set then get round-trips a raw value with upsert semantics", () => {
  const db = makeTestDb();
  setConfigRow(db, "g1", "k", '"a"', 1);
  expect(getConfigRow(db, "g1", "k")).toBe('"a"');
  setConfigRow(db, "g1", "k", '"b"', 2);
  expect(getConfigRow(db, "g1", "k")).toBe('"b"');
});

test("list and delete", () => {
  const db = makeTestDb();
  setConfigRow(db, "g1", "a", "1", 1);
  setConfigRow(db, "g1", "b", "2", 1);
  expect(listConfigRows(db, "g1").length).toBe(2);
  deleteConfigRow(db, "g1", "a");
  expect(getConfigRow(db, "g1", "a")).toBeUndefined();
});
```

```typescript
// test/services/config.service.test.ts
import { expect, test } from "bun:test";
import { ConfigService } from "../../src/services/config.service";
import { makeTestDb } from "../helpers/db";

test("typed get/set round-trips and caches", () => {
  const cfg = new ConfigService(makeTestDb());
  expect(cfg.get<string>("g1", "chan")).toBeUndefined();
  cfg.set("g1", "chan", "123");
  expect(cfg.get<string>("g1", "chan")).toBe("123");
  cfg.set("g1", "flag", true);
  expect(cfg.get<boolean>("g1", "flag")).toBe(true);
});

test("unset clears the value", () => {
  const cfg = new ConfigService(makeTestDb());
  cfg.set("g1", "chan", "123");
  cfg.unset("g1", "chan");
  expect(cfg.get<string>("g1", "chan")).toBeUndefined();
});

test("all returns parsed values", () => {
  const cfg = new ConfigService(makeTestDb());
  cfg.set("g1", "a", "x");
  cfg.set("g1", "b", 2);
  expect(cfg.all("g1")).toEqual({ a: "x", b: 2 });
});
```

- [ ] **Step 5: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass.

```bash
git add src/repositories/config.repository.ts src/services/config.service.ts test/helpers/db.ts test/repositories/config.repository.test.ts test/services/config.service.test.ts
git commit -m "feat: add config repository and cached config service"
```

---

## Task 2: Wire ConfigService into AppContext

**Files:**
- Modify: `src/core/context.ts`, `src/index.ts`, `test/helpers/fakes.ts`

**Interfaces:**
- Produces: `AppContext` now includes `config: ConfigService`.

- [ ] **Step 1: Add `config` to `AppContext`**

```typescript
// src/core/context.ts
import type { Env } from "../config/env";
import type { BotDatabase } from "../db/client";
import type { ConfigService } from "../services/config.service";
import type { Logger } from "./logger";

export interface AppContext {
  db: BotDatabase;
  logger: Logger;
  env: Env;
  config: ConfigService;
}
```

- [ ] **Step 2: Construct it in the entrypoint**

In `src/index.ts`, add the import and build the service into `ctx`:

```typescript
import { ConfigService } from "./services/config.service";
```

Change the `ctx` construction from:

```typescript
  const ctx: AppContext = { db, logger, env };
```

to:

```typescript
  const config = new ConfigService(db);
  const ctx: AppContext = { db, logger, env, config };
```

- [ ] **Step 3: Update the test helper**

```typescript
// test/helpers/fakes.ts  (replace the silentContext function only)
import { ConfigService } from "../../src/services/config.service";
import { createDatabase, runMigrations } from "../../src/db/client";

export function silentContext(): AppContext {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return {
    db,
    logger: createLogger("error", () => {}),
    env: {} as AppContext["env"],
    config: new ConfigService(db),
  };
}
```

- [ ] **Step 4: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass (existing router tests still green with the richer context).

```bash
git add src/core/context.ts src/index.ts test/helpers/fakes.ts
git commit -m "feat: provide ConfigService through AppContext"
```

---

## Task 3: `/config` command module

**Files:**
- Create: `src/modules/config/index.ts`
- Modify: `src/modules/index.ts`

**Interfaces:**
- Consumes: `ConfigService`, `CONFIG_KEYS`, `AppContext`.
- Produces: `configModule: BotModule`.

- [ ] **Step 1: Write the module**

```typescript
// src/modules/config/index.ts
import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";

const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("View or change bot configuration.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName("view").setDescription("Show the current configuration."))
  .addSubcommand((s) =>
    s
      .setName("log-channel")
      .setDescription("Set a log channel.")
      .addStringOption((o) =>
        o
          .setName("kind")
          .setDescription("Which log to set")
          .setRequired(true)
          .addChoices({ name: "mod", value: "mod" }, { name: "member", value: "member" }),
      )
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Target text channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("dm-on-action")
      .setDescription("Whether to DM users when they are actioned.")
      .addBooleanOption((o) =>
        o.setName("enabled").setDescription("Enable DMs on action").setRequired(true),
      ),
  );

const config: SlashCommand = {
  data,
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === "view") {
      const modCh = ctx.config.get<string>(guildId, CONFIG_KEYS.modLogChannelId);
      const memCh = ctx.config.get<string>(guildId, CONFIG_KEYS.memberLogChannelId);
      const dm = ctx.config.get<boolean>(guildId, CONFIG_KEYS.dmOnAction) ?? false;
      const embed = new EmbedBuilder().setTitle("Configuration").addFields(
        { name: "Mod log channel", value: modCh ? `<#${modCh}>` : "*(unset)*" },
        { name: "Member log channel", value: memCh ? `<#${memCh}>` : "*(unset)*" },
        { name: "DM on action", value: dm ? "enabled" : "disabled" },
      );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "log-channel") {
      const kind = interaction.options.getString("kind", true);
      const channel = interaction.options.getChannel("channel", true);
      const key = kind === "mod" ? CONFIG_KEYS.modLogChannelId : CONFIG_KEYS.memberLogChannelId;
      ctx.config.set(guildId, key, channel.id);
      await interaction.reply({
        content: `Set the ${kind} log channel to <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "dm-on-action") {
      const enabled = interaction.options.getBoolean("enabled", true);
      ctx.config.set(guildId, CONFIG_KEYS.dmOnAction, enabled);
      await interaction.reply({
        content: `DM on action is now ${enabled ? "enabled" : "disabled"}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

export const configModule: BotModule = { name: "config", commands: [config] };
```

- [ ] **Step 2: Register the module**

```typescript
// src/modules/index.ts
import type { BotModule } from "../core/module";
import { configModule } from "./config";
import { pingModule } from "./ping";

export const modules: BotModule[] = [pingModule, configModule];
```

- [ ] **Step 3: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass; `collectCommandData` test still passes (now 2+ commands, still contains "ping").

```bash
git add src/modules/config/index.ts src/modules/index.ts
git commit -m "feat: add /config command module"
```

---

## Task 4: `cases` table & migration

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `drizzle/` (new migration)

**Interfaces:**
- Produces: `cases` table export.

- [ ] **Step 1: Add the table**

Append to `src/db/schema.ts` (and add `uniqueIndex` to the existing `drizzle-orm/sqlite-core` import):

```typescript
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ... existing guildConfig table ...

export const cases = sqliteTable(
  "cases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    caseNumber: integer("case_number").notNull(),
    userId: text("user_id").notNull(),
    moderatorId: text("moderator_id").notNull(),
    type: text("type").notNull(),
    reason: text("reason").notNull(),
    meta: text("meta"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("cases_guild_case_idx").on(t.guildId, t.caseNumber)],
);
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new `drizzle/0001_*.sql` adding the `cases` table + unique index.

- [ ] **Step 3: Verify migrations still apply cleanly**

Run: `bun test test/db/client.test.ts`
Expected: PASS (migrations apply in order onto `:memory:`).

- [ ] **Step 4: Gate & commit**

```bash
git add src/db/schema.ts drizzle
git commit -m "feat: add cases table and migration"
```

---

## Task 5: Cases repository

**Files:**
- Create: `src/repositories/cases.repository.ts`
- Test: `test/repositories/cases.repository.test.ts`

**Interfaces:**
- Produces:
  - `type CaseType = "warn"|"timeout"|"kick"|"ban"|"unban"|"note"`
  - `interface NewCase { guildId; userId; moderatorId; type: CaseType; reason: string; meta?: unknown }`
  - `interface CaseRecord { id; guildId; caseNumber; userId; moderatorId; type; reason; meta: string|null; createdAt }`
  - `createCase(db, NewCase): CaseRecord`, `getCaseByNumber(db, guildId, n): CaseRecord|undefined`, `listCasesByUser(db, guildId, userId, limit?): CaseRecord[]`

- [ ] **Step 1: Write the repository**

```typescript
// src/repositories/cases.repository.ts
import { and, desc, eq, sql } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { cases } from "../db/schema";

export type CaseType = "warn" | "timeout" | "kick" | "ban" | "unban" | "note";

export interface NewCase {
  guildId: string;
  userId: string;
  moderatorId: string;
  type: CaseType;
  reason: string;
  meta?: unknown;
}

export interface CaseRecord {
  id: number;
  guildId: string;
  caseNumber: number;
  userId: string;
  moderatorId: string;
  type: string;
  reason: string;
  meta: string | null;
  createdAt: number;
}

export function createCase(db: BotDatabase, input: NewCase): CaseRecord {
  return db.transaction((tx) => {
    const row = tx
      .select({ max: sql<number | null>`max(${cases.caseNumber})` })
      .from(cases)
      .where(eq(cases.guildId, input.guildId))
      .get();
    const nextNumber = (row?.max ?? 0) + 1;
    const inserted = tx
      .insert(cases)
      .values({
        guildId: input.guildId,
        caseNumber: nextNumber,
        userId: input.userId,
        moderatorId: input.moderatorId,
        type: input.type,
        reason: input.reason,
        meta: input.meta === undefined ? null : JSON.stringify(input.meta),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return inserted as CaseRecord;
  });
}

export function getCaseByNumber(
  db: BotDatabase,
  guildId: string,
  caseNumber: number,
): CaseRecord | undefined {
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.guildId, guildId), eq(cases.caseNumber, caseNumber)))
    .get() as CaseRecord | undefined;
}

export function listCasesByUser(
  db: BotDatabase,
  guildId: string,
  userId: string,
  limit = 10,
): CaseRecord[] {
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.guildId, guildId), eq(cases.userId, userId)))
    .orderBy(desc(cases.caseNumber))
    .limit(limit)
    .all() as CaseRecord[];
}
```

- [ ] **Step 2: Write the tests**

```typescript
// test/repositories/cases.repository.test.ts
import { expect, test } from "bun:test";
import {
  createCase,
  getCaseByNumber,
  listCasesByUser,
} from "../../src/repositories/cases.repository";
import { makeTestDb } from "../helpers/db";

test("case numbers increment sequentially per guild", () => {
  const db = makeTestDb();
  const a = createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "r" });
  const b = createCase(db, { guildId: "g1", userId: "u2", moderatorId: "m", type: "warn", reason: "r" });
  expect(a.caseNumber).toBe(1);
  expect(b.caseNumber).toBe(2);
});

test("case numbering is isolated per guild", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "r" });
  const other = createCase(db, { guildId: "g2", userId: "u1", moderatorId: "m", type: "warn", reason: "r" });
  expect(other.caseNumber).toBe(1);
});

test("fetch by number and list by user (newest first)", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "one" });
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "note", reason: "two" });
  expect(getCaseByNumber(db, "g1", 1)?.reason).toBe("one");
  const list = listCasesByUser(db, "g1", "u1");
  expect(list.map((c) => c.caseNumber)).toEqual([2, 1]);
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/repositories/cases.repository.ts test/repositories/cases.repository.test.ts
git commit -m "feat: add cases repository with per-guild sequential numbering"
```

---

## Task 6: Duration parsing utility

**Files:**
- Create: `src/util/duration.ts`
- Test: `test/util/duration.test.ts`

**Interfaces:**
- Produces: `MAX_TIMEOUT_MS`, `parseDuration(input): number | null`, `formatDuration(ms): string`.

- [ ] **Step 1: Write the utility**

```typescript
// src/util/duration.ts
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord's maximum timeout

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number.parseInt(match[1] as string, 10);
  const unit = (match[2] as string).toLowerCase();
  const ms = amount * (UNIT_MS[unit] ?? 0);
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  const units: [string, number][] = [
    ["w", 604_800_000],
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
  ];
  for (const [label, size] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${label}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
```

- [ ] **Step 2: Write the tests**

```typescript
// test/util/duration.test.ts
import { expect, test } from "bun:test";
import { MAX_TIMEOUT_MS, formatDuration, parseDuration } from "../../src/util/duration";

test("parses valid durations", () => {
  expect(parseDuration("10m")).toBe(600_000);
  expect(parseDuration("2h")).toBe(7_200_000);
  expect(parseDuration("7d")).toBe(604_800_000);
  expect(parseDuration("1w")).toBe(604_800_000);
});

test("rejects invalid or zero durations", () => {
  expect(parseDuration("nope")).toBeNull();
  expect(parseDuration("0m")).toBeNull();
  expect(parseDuration("")).toBeNull();
});

test("formats round durations", () => {
  expect(formatDuration(600_000)).toBe("10m");
  expect(formatDuration(7_200_000)).toBe("2h");
});

test("28 days is the timeout ceiling", () => {
  expect(parseDuration("29d")).toBeGreaterThan(MAX_TIMEOUT_MS);
  expect(parseDuration("28d")).toBe(MAX_TIMEOUT_MS);
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/util/duration.ts test/util/duration.test.ts
git commit -m "feat: add duration parsing utility"
```

---

## Task 7: Moderation hierarchy-check service

**Files:**
- Create: `src/services/moderation.service.ts`
- Test: `test/services/moderation.service.test.ts`

**Interfaces:**
- Produces:
  - `interface ActionableInput { actorId; targetId; botId; guildOwnerId; actorHighestRole: number; targetHighestRole: number; botHighestRole: number; targetIsMember: boolean }`
  - `type ActionCheck = { ok: true } | { ok: false; reason: string }`
  - `checkActionable(input): ActionCheck`

- [ ] **Step 1: Write the service**

```typescript
// src/services/moderation.service.ts
export interface ActionableInput {
  actorId: string;
  targetId: string;
  botId: string;
  guildOwnerId: string;
  actorHighestRole: number;
  targetHighestRole: number;
  botHighestRole: number;
  targetIsMember: boolean;
}

export type ActionCheck = { ok: true } | { ok: false; reason: string };

export function checkActionable(input: ActionableInput): ActionCheck {
  if (input.targetId === input.actorId) return { ok: false, reason: "You can't action yourself." };
  if (input.targetId === input.botId) return { ok: false, reason: "I can't action myself." };
  if (input.targetId === input.guildOwnerId) {
    return { ok: false, reason: "You can't action the server owner." };
  }
  if (input.targetIsMember) {
    if (input.targetHighestRole >= input.actorHighestRole) {
      return { ok: false, reason: "You can't action someone with an equal or higher role." };
    }
    if (input.targetHighestRole >= input.botHighestRole) {
      return { ok: false, reason: "My role isn't high enough to action that user." };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 2: Write the tests**

```typescript
// test/services/moderation.service.test.ts
import { expect, test } from "bun:test";
import { type ActionableInput, checkActionable } from "../../src/services/moderation.service";

const base: ActionableInput = {
  actorId: "actor",
  targetId: "target",
  botId: "bot",
  guildOwnerId: "owner",
  actorHighestRole: 5,
  targetHighestRole: 2,
  botHighestRole: 6,
  targetIsMember: true,
};

test("allows a valid action", () => {
  expect(checkActionable(base)).toEqual({ ok: true });
});

test("blocks self, bot, and owner targets", () => {
  expect(checkActionable({ ...base, targetId: "actor" }).ok).toBe(false);
  expect(checkActionable({ ...base, targetId: "bot" }).ok).toBe(false);
  expect(checkActionable({ ...base, targetId: "owner" }).ok).toBe(false);
});

test("blocks targets with equal/higher role than the actor or bot", () => {
  expect(checkActionable({ ...base, targetHighestRole: 5 }).ok).toBe(false);
  expect(checkActionable({ ...base, targetHighestRole: 7, actorHighestRole: 8 }).ok).toBe(false);
});

test("skips role checks for non-members (e.g. ban by ID)", () => {
  expect(checkActionable({ ...base, targetIsMember: false, targetHighestRole: 99 })).toEqual({
    ok: true,
  });
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/moderation.service.ts test/services/moderation.service.test.ts
git commit -m "feat: add moderation hierarchy-check service"
```

---

## Task 8: Mod-log service (embed builders + send helpers)

**Files:**
- Create: `src/services/modlog.service.ts`
- Test: `test/services/modlog.service.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `CONFIG_KEYS`, `CaseRecord`.
- Produces:
  - pure builders: `buildCaseEmbed(c): EmbedBuilder`, `buildMessageDeleteEmbed(a): EmbedBuilder`, `buildMessageUpdateEmbed(a): EmbedBuilder`, `buildMemberJoinEmbed(a): EmbedBuilder`, `buildMemberLeaveEmbed(a): EmbedBuilder`
  - senders: `logCase(ctx, guild, c): Promise<void>`, `logMemberEvent(ctx, guild, embed): Promise<void>`

- [ ] **Step 1: Write the service**

```typescript
// src/services/modlog.service.ts
import { EmbedBuilder, type Guild } from "discord.js";
import type { AppContext } from "../core/context";
import type { CaseRecord } from "../repositories/cases.repository";
import { CONFIG_KEYS } from "./config.service";

const CASE_COLORS: Record<string, number> = {
  warn: 0xf1c40f,
  timeout: 0xe67e22,
  kick: 0xe74c3c,
  ban: 0x992d22,
  unban: 0x2ecc71,
  note: 0x95a5a6,
};

function truncate(text: string, max = 1024): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildCaseEmbed(c: CaseRecord): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(CASE_COLORS[c.type] ?? 0x95a5a6)
    .setTitle(`Case #${c.caseNumber} · ${c.type.toUpperCase()}`)
    .addFields(
      { name: "User", value: `<@${c.userId}> (${c.userId})` },
      { name: "Moderator", value: `<@${c.moderatorId}>` },
      { name: "Reason", value: truncate(c.reason) },
    )
    .setTimestamp(new Date(c.createdAt));
}

export function buildMessageDeleteEmbed(a: {
  authorId?: string;
  channelId: string;
  content: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Message deleted")
    .addFields(
      { name: "Author", value: a.authorId ? `<@${a.authorId}>` : "*(unknown)*" },
      { name: "Channel", value: `<#${a.channelId}>` },
      { name: "Content", value: truncate(a.content) },
    );
}

export function buildMessageUpdateEmbed(a: {
  authorId?: string;
  channelId: string;
  before: string;
  after: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Message edited")
    .addFields(
      { name: "Author", value: a.authorId ? `<@${a.authorId}>` : "*(unknown)*" },
      { name: "Channel", value: `<#${a.channelId}>` },
      { name: "Before", value: truncate(a.before) },
      { name: "After", value: truncate(a.after) },
    );
}

export function buildMemberJoinEmbed(a: { userId: string; createdAt: number }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("Member joined")
    .addFields(
      { name: "User", value: `<@${a.userId}> (${a.userId})` },
      { name: "Account created", value: `<t:${Math.floor(a.createdAt / 1000)}:R>` },
    );
}

export function buildMemberLeaveEmbed(a: { userId: string }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Member left")
    .addFields({ name: "User", value: `<@${a.userId}> (${a.userId})` });
}

async function sendToConfigured(
  ctx: AppContext,
  guild: Guild,
  key: string,
  embed: EmbedBuilder,
): Promise<void> {
  const channelId = ctx.config.get<string>(guild.id, key);
  if (!channelId) return;
  const channel =
    guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch(() => {});
  }
}

export async function logCase(ctx: AppContext, guild: Guild, c: CaseRecord): Promise<void> {
  await sendToConfigured(ctx, guild, CONFIG_KEYS.modLogChannelId, buildCaseEmbed(c));
}

export async function logMemberEvent(
  ctx: AppContext,
  guild: Guild,
  embed: EmbedBuilder,
): Promise<void> {
  await sendToConfigured(ctx, guild, CONFIG_KEYS.memberLogChannelId, embed);
}
```

- [ ] **Step 2: Write the tests (pure builders)**

```typescript
// test/services/modlog.service.test.ts
import { expect, test } from "bun:test";
import type { CaseRecord } from "../../src/repositories/cases.repository";
import { buildCaseEmbed, buildMemberJoinEmbed } from "../../src/services/modlog.service";

const record: CaseRecord = {
  id: 1,
  guildId: "g1",
  caseNumber: 7,
  userId: "u1",
  moderatorId: "m1",
  type: "ban",
  reason: "spam",
  meta: null,
  createdAt: 1_700_000_000_000,
};

test("case embed shows number, type, and fields", () => {
  const data = buildCaseEmbed(record).data;
  expect(data.title).toBe("Case #7 · BAN");
  const fieldNames = (data.fields ?? []).map((f) => f.name);
  expect(fieldNames).toEqual(["User", "Moderator", "Reason"]);
  expect((data.fields ?? [])[2]?.value).toBe("spam");
});

test("member join embed references the user", () => {
  const data = buildMemberJoinEmbed({ userId: "u9", createdAt: 1_700_000_000_000 }).data;
  expect(data.title).toBe("Member joined");
  expect((data.fields ?? [])[0]?.value).toContain("u9");
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/modlog.service.ts test/services/modlog.service.test.ts
git commit -m "feat: add mod-log embed builders and send helpers"
```

---

## Task 9: Logging module (event listeners)

**Files:**
- Create: `src/modules/logging/index.ts`
- Modify: `src/modules/index.ts`

**Interfaces:**
- Consumes: modlog builders + `logMemberEvent`, `Listener`, `BotModule`.
- Produces: `loggingModule: BotModule`.

- [ ] **Step 1: Write the module**

```typescript
// src/modules/logging/index.ts
import { Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import {
  buildMemberJoinEmbed,
  buildMemberLeaveEmbed,
  buildMessageDeleteEmbed,
  buildMessageUpdateEmbed,
  logMemberEvent,
} from "../../services/modlog.service";

const onDelete: Listener<Events.MessageDelete> = {
  event: Events.MessageDelete,
  async handle(ctx, message) {
    if (!message.guild || message.author?.bot) return;
    await logMemberEvent(
      ctx,
      message.guild,
      buildMessageDeleteEmbed({
        authorId: message.author?.id,
        channelId: message.channelId,
        content: message.content?.trim() ? message.content : "*(uncached or empty)*",
      }),
    );
  },
};

const onUpdate: Listener<Events.MessageUpdate> = {
  event: Events.MessageUpdate,
  async handle(ctx, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    const before = oldMessage.content ?? "";
    const after = newMessage.content ?? "";
    if (before === after) return;
    await logMemberEvent(
      ctx,
      newMessage.guild,
      buildMessageUpdateEmbed({
        authorId: newMessage.author?.id,
        channelId: newMessage.channelId,
        before: before.trim() ? before : "*(uncached or empty)*",
        after: after.trim() ? after : "*(empty)*",
      }),
    );
  },
};

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    await logMemberEvent(
      ctx,
      member.guild,
      buildMemberJoinEmbed({ userId: member.id, createdAt: member.user.createdTimestamp }),
    );
  },
};

const onLeave: Listener<Events.GuildMemberRemove> = {
  event: Events.GuildMemberRemove,
  async handle(ctx, member) {
    await logMemberEvent(ctx, member.guild, buildMemberLeaveEmbed({ userId: member.id }));
  },
};

export const loggingModule: BotModule = {
  name: "logging",
  listeners: [onDelete, onUpdate, onJoin, onLeave] as Listener[],
};
```

- [ ] **Step 2: Register the module**

```typescript
// src/modules/index.ts
import type { BotModule } from "../core/module";
import { configModule } from "./config";
import { loggingModule } from "./logging";
import { pingModule } from "./ping";

export const modules: BotModule[] = [pingModule, configModule, loggingModule];
```

- [ ] **Step 3: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass.

```bash
git add src/modules/logging/index.ts src/modules/index.ts
git commit -m "feat: add audit logging module for messages and members"
```

---

## Task 10: Moderation shared helpers + record-only commands

**Files:**
- Create: `src/modules/moderation/shared.ts`, `src/modules/moderation/warn.ts`, `src/modules/moderation/note.ts`, `src/modules/moderation/case.ts`, `src/modules/moderation/history.ts`

**Interfaces:**
- Produces:
  - `recordAndAnnounce(interaction, ctx, { target, type, reason, dmText? }): Promise<void>`
  - `assertActionable(interaction, ctx, targetUserId, { requireMember }): Promise<GuildMember | null | "not-member">` — replies with the error and returns `null` if blocked; returns the target `GuildMember` (or `"not-member"` when `requireMember` is false and the user isn't in the guild).
  - `warnCommand`, `noteCommand`, `caseCommand`, `historyCommand` (each a `SlashCommand`).

- [ ] **Step 1: Write the shared helpers**

```typescript
// src/modules/moderation/shared.ts
import {
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  type User,
} from "discord.js";
import type { AppContext } from "../../core/context";
import { type CaseType, createCase } from "../../repositories/cases.repository";
import { CONFIG_KEYS } from "../../services/config.service";
import { checkActionable } from "../../services/moderation.service";
import { logCase } from "../../services/modlog.service";

export async function recordAndAnnounce(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
  input: { target: User; type: CaseType; reason: string; dmText?: string },
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const record = createCase(ctx.db, {
    guildId: guild.id,
    userId: input.target.id,
    moderatorId: interaction.user.id,
    type: input.type,
    reason: input.reason,
  });

  const dmOn = ctx.config.get<boolean>(guild.id, CONFIG_KEYS.dmOnAction) ?? false;
  if (dmOn && input.dmText) {
    await input.target.send(input.dmText).catch(() => {});
  }
  await logCase(ctx, guild, record);

  await interaction.reply({
    content: `✅ Case #${record.caseNumber}: **${input.type}** applied to ${input.target.tag}.\nReason: ${input.reason}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function assertActionable(
  interaction: ChatInputCommandInteraction,
  targetUserId: string,
  opts: { requireMember: boolean },
): Promise<GuildMember | "not-member" | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  const actor = await guild.members.fetch(interaction.user.id);
  const botMember = await guild.members.fetchMe();
  let targetMember: GuildMember | undefined;
  try {
    targetMember = await guild.members.fetch(targetUserId);
  } catch {
    targetMember = undefined;
  }

  if (opts.requireMember && !targetMember) {
    await interaction.reply({
      content: "That user isn't in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const check = checkActionable({
    actorId: interaction.user.id,
    targetId: targetUserId,
    botId: botMember.id,
    guildOwnerId: guild.ownerId,
    actorHighestRole: actor.roles.highest.position,
    targetHighestRole: targetMember?.roles.highest.position ?? -1,
    botHighestRole: botMember.roles.highest.position,
    targetIsMember: Boolean(targetMember),
  });
  if (!check.ok) {
    await interaction.reply({ content: `❌ ${check.reason}`, flags: MessageFlags.Ephemeral });
    return null;
  }
  return targetMember ?? "not-member";
}
```

- [ ] **Step 2: Write `/warn` and `/note`**

```typescript
// src/modules/moderation/warn.ts
import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { recordAndAnnounce } from "./shared";

export const warnCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Member to warn").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    await recordAndAnnounce(interaction, ctx, {
      target,
      type: "warn",
      reason,
      dmText: `You were warned in **${interaction.guild?.name}**. Reason: ${reason}`,
    });
  },
};
```

```typescript
// src/modules/moderation/note.ts
import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { recordAndAnnounce } from "./shared";

export const noteCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("note")
    .setDescription("Attach a private moderator note to a user.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Subject user").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Note text").setRequired(true)),
  async execute(interaction, ctx) {
    const target = interaction.options.getUser("user", true);
    const note = interaction.options.getString("note", true);
    await recordAndAnnounce(interaction, ctx, { target, type: "note", reason: note });
  },
};
```

- [ ] **Step 3: Write `/case` and `/history`**

```typescript
// src/modules/moderation/case.ts
import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { getCaseByNumber } from "../../repositories/cases.repository";

export const caseCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("case")
    .setDescription("Look up a moderation case by number.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o.setName("number").setDescription("Case number").setRequired(true).setMinValue(1),
    ),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const number = interaction.options.getInteger("number", true);
    const record = getCaseByNumber(ctx.db, interaction.guildId, number);
    if (!record) {
      await interaction.reply({
        content: `No case #${number} found.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(`Case #${record.caseNumber} · ${record.type.toUpperCase()}`)
      .addFields(
        { name: "User", value: `<@${record.userId}> (${record.userId})` },
        { name: "Moderator", value: `<@${record.moderatorId}>` },
        { name: "Reason", value: record.reason },
      )
      .setTimestamp(new Date(record.createdAt));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

```typescript
// src/modules/moderation/history.ts
import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { listCasesByUser } from "../../repositories/cases.repository";

export const historyCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show a user's moderation history.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const user = interaction.options.getUser("user", true);
    const records = listCasesByUser(ctx.db, interaction.guildId, user.id);
    if (records.length === 0) {
      await interaction.reply({
        content: `No cases for ${user.tag}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = records.map((r) => `**#${r.caseNumber}** \`${r.type}\` — ${r.reason}`);
    const embed = new EmbedBuilder()
      .setTitle(`History for ${user.tag}`)
      .setDescription(lines.join("\n"));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
```

- [ ] **Step 4: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass.

```bash
git add src/modules/moderation/shared.ts src/modules/moderation/warn.ts src/modules/moderation/note.ts src/modules/moderation/case.ts src/modules/moderation/history.ts
git commit -m "feat: add warn/note/case/history moderation commands"
```

---

## Task 11: Action commands (`/timeout`, `/kick`, `/ban`, `/unban`) + module registration + live smoke test

**Files:**
- Create: `src/modules/moderation/timeout.ts`, `kick.ts`, `ban.ts`, `unban.ts`, `src/modules/moderation/index.ts`
- Modify: `src/modules/index.ts`

**Interfaces:**
- Consumes: `assertActionable`, `recordAndAnnounce`, `parseDuration`, `MAX_TIMEOUT_MS`, cases repo, modlog.
- Produces: `moderationModule: BotModule`.

- [ ] **Step 1: Write `/timeout`**

```typescript
// src/modules/moderation/timeout.ts
import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { MAX_TIMEOUT_MS, formatDuration, parseDuration } from "../../util/duration";
import { assertActionable, recordAndAnnounce } from "./shared";

export const timeoutCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member for a duration (max 28d).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) =>
      o.setName("duration").setDescription("e.g. 10m, 2h, 7d").setRequired(true),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser("user", true);
    const durationText = interaction.options.getString("duration", true);
    const reason = interaction.options.getString("reason", true);

    const ms = parseDuration(durationText);
    if (ms === null || ms > MAX_TIMEOUT_MS) {
      await interaction.reply({
        content: "Invalid duration. Use e.g. `10m`, `2h`, `7d` (max 28d).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const member = await assertActionable(interaction, user.id, { requireMember: true });
    if (member === null || member === "not-member") return;

    await member.timeout(ms, reason);
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "timeout",
      reason: `${reason} (${formatDuration(ms)})`,
      dmText: `You were timed out in **${interaction.guild?.name}** for ${formatDuration(ms)}. Reason: ${reason}`,
    });
  },
};
```

- [ ] **Step 2: Write `/kick`**

```typescript
// src/modules/moderation/kick.ts
import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { assertActionable, recordAndAnnounce } from "./shared";

export const kickCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const member = await assertActionable(interaction, user.id, { requireMember: true });
    if (member === null || member === "not-member") return;

    await member.kick(reason);
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "kick",
      reason,
      dmText: `You were kicked from **${interaction.guild?.name}**. Reason: ${reason}`,
    });
  },
};
```

- [ ] **Step 3: Write `/ban`**

```typescript
// src/modules/moderation/ban.ts
import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { assertActionable, recordAndAnnounce } from "./shared";

export const banCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user (works even if they aren't in the server).")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName("delete_days")
        .setDescription("Delete this many days of their messages (0-7)")
        .setMinValue(0)
        .setMaxValue(7),
    ),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

    const target = await assertActionable(interaction, user.id, { requireMember: false });
    if (target === null) return;

    // DM before banning (best-effort) while we may still share a guild.
    const dmOn = ctx.config.get<boolean>(interaction.guildId ?? "", "dm_on_action") ?? false;
    if (dmOn) {
      await user
        .send(`You were banned from **${interaction.guild?.name}**. Reason: ${reason}`)
        .catch(() => {});
    }

    await interaction.guild?.members.ban(user.id, {
      reason,
      deleteMessageSeconds: deleteDays * 86_400,
    });
    await recordAndAnnounce(interaction, ctx, { target: user, type: "ban", reason });
  },
};
```

> Note: `recordAndAnnounce` also honors `dm_on_action`, but for a ban we DM *before* removing the user; passing no `dmText` to `recordAndAnnounce` avoids a duplicate DM attempt after the ban.

- [ ] **Step 4: Write `/unban`**

```typescript
// src/modules/moderation/unban.ts
import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { SlashCommand } from "../../core/module";
import { recordAndAnnounce } from "./shared";

export const unbanCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user by ID.")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("User to unban").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);

    const ban = await interaction.guild?.bans.fetch(user.id).catch(() => null);
    if (!ban) {
      await interaction.reply({
        content: "That user isn't banned.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.guild?.bans.remove(user.id, reason);
    await recordAndAnnounce(interaction, ctx, { target: user, type: "unban", reason });
  },
};
```

- [ ] **Step 5: Assemble the moderation module**

```typescript
// src/modules/moderation/index.ts
import type { BotModule } from "../../core/module";
import { banCommand } from "./ban";
import { caseCommand } from "./case";
import { historyCommand } from "./history";
import { kickCommand } from "./kick";
import { noteCommand } from "./note";
import { timeoutCommand } from "./timeout";
import { unbanCommand } from "./unban";
import { warnCommand } from "./warn";

export const moderationModule: BotModule = {
  name: "moderation",
  commands: [
    warnCommand,
    noteCommand,
    timeoutCommand,
    kickCommand,
    banCommand,
    unbanCommand,
    caseCommand,
    historyCommand,
  ],
};
```

- [ ] **Step 6: Register the module**

```typescript
// src/modules/index.ts
import type { BotModule } from "../core/module";
import { configModule } from "./config";
import { loggingModule } from "./logging";
import { moderationModule } from "./moderation";
import { pingModule } from "./ping";

export const modules: BotModule[] = [pingModule, configModule, loggingModule, moderationModule];
```

- [ ] **Step 7: Gate**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 8: Live smoke test**

Run: `timeout --preserve-status --signal=SIGTERM 12 bun src/index.ts`
Expected: logs `registered guild commands` with a count of **12** (ping, config, warn, note, timeout, kick, ban, unban, case, history + the 2 config already there — verify the count matches the command total), `logged in`, then clean shutdown (exit 0). In Discord, `/config log-channel mod #channel`, then `/warn @self`-style checks are rejected by hierarchy rules; `/config view` shows the set channel.

- [ ] **Step 9: Commit**

```bash
git add src/modules/moderation/ src/modules/index.ts
git commit -m "feat: add timeout/kick/ban/unban commands and register moderation module"
```

---

## Self-Review

**1. Spec coverage** (against design §8 and roadmap Phase 1):
- Config service + `/config` (T1–T3) ✓
- Logging: edits/deletes/joins/leaves + mod-action log (T8–T9) ✓
- `cases` ledger with per-guild numbering (T4–T5) ✓
- Manual moderation `/warn /timeout /kick /ban /unban /note /case /history` (T10–T11) ✓
- Reason required on all actions (all commands mark reason `.setRequired(true)`) ✓
- Hierarchy safety (T7 `checkActionable`, applied in T10/T11 via `assertActionable`) ✓
- Timeout ≤ 28d (T6 `MAX_TIMEOUT_MS`, enforced in `/timeout`) ✓
- DM best-effort, gated by `dm_on_action` (T10 `recordAndAnnounce`, T11 `/ban`) ✓
- Per-guild command registration + intents unchanged from 1A ✓

**2. Placeholder scan:** No TBD/TODO; every step has complete code. ✓

**3. Type consistency:** `AppContext.config: ConfigService` (T2) is consumed by `/config` (T3), modlog senders (T8), and `recordAndAnnounce` (T10). `CaseRecord`/`CaseType`/`createCase`/`getCaseByNumber`/`listCasesByUser` (T5) are used consistently in T8/T10/T11. `checkActionable`/`ActionableInput` (T7) are consumed by `assertActionable` (T10). `CONFIG_KEYS` (T1) used in T3/T8/T10. `parseDuration`/`MAX_TIMEOUT_MS`/`formatDuration` (T6) used in `/timeout` (T11). ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-phase1b-features.md`. Execute with subagent-driven-development or executing-plans.
