# clanker-bot Phase 2 — Infraction Ledger, Temp-Bans & Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a durable scheduler, temporary bans that auto-expire, and a decay-aware weighted "active strike score" surfaced in `/history`.

**Architecture:** Builds on Phase 1. A new `scheduled_actions` table + repository drives a polling scheduler that runs due jobs (currently: expire a temp-ban → unban + log). A pure `computeActiveScore` folds a user's cases into a decaying weighted score. Pure logic is unit-tested; the poller + Discord actions are thin integration wired in `index.ts`.

**Tech Stack:** As before — TypeScript, Bun, discord.js v14, Drizzle/`bun:sqlite`, drizzle-kit, Biome, `bun test`.

## Global Constraints

- All prior constraints apply (Bun, discord.js `^14.26`, repository layer, `bun test` on in-memory SQLite, Conventional Commits, per-task commits, `bun run lint:fix` before each gate; gate = `bun test && bun run typecheck && bun run lint`).
- **Auto-escalation is explicitly out of scope** (deferred to Phase 3 with automod).
- New config key: `strike_decay_days` (number, default **90**).
- Strike weights are code constants: `note` 0, `warn` 1, `timeout` 2, `kick` 3, `ban`/`unban` 0.
- Scheduler poll interval: **30s**. Jobs are persisted so restarts don't drop pending expirations.

---

## File Structure

```
src/db/schema.ts                          # MODIFY: add scheduled_actions table
drizzle/                                  # GENERATED migration
src/repositories/scheduled-actions.repository.ts   # CRUD + due query
src/services/infractions.service.ts       # STRIKE_WEIGHTS + computeActiveScore
src/services/scheduler.service.ts         # runDueActions + executors + startScheduler
src/index.ts                              # MODIFY: start/stop the scheduler poller
src/modules/moderation/ban.ts             # MODIFY: optional duration -> schedule unban
src/modules/moderation/history.ts         # MODIFY: show active strike score
test/repositories/scheduled-actions.repository.test.ts
test/services/infractions.service.test.ts
test/services/scheduler.service.test.ts
```

---

## Task 1: `scheduled_actions` table & migration

**Files:** Modify `src/db/schema.ts`; generate migration.

**Interfaces:** Produces the `scheduledActions` table.

- [ ] **Step 1: Add the table** (append to `src/db/schema.ts`)

```typescript
// Durable queue of future actions (e.g. expire a temp-ban).
export const scheduledActions = sqliteTable(
  "scheduled_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    type: text("type").notNull(),
    userId: text("user_id").notNull(),
    reason: text("reason"),
    runAt: integer("run_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("scheduled_actions_run_at_idx").on(t.runAt)],
);
```

Add `index` to the `drizzle-orm/sqlite-core` import (it becomes `import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";`).

- [ ] **Step 2: Generate & verify**

Run: `bun run db:generate && bun test test/db/client.test.ts`
Expected: new `drizzle/0002_*.sql`; client test passes.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts drizzle
git commit -m "feat: add scheduled_actions table and migration"
```

---

## Task 2: Scheduled-actions repository

**Files:** Create `src/repositories/scheduled-actions.repository.ts`; test.

**Interfaces:**
- `type ScheduledActionType = "unban"`
- `interface ScheduledAction { id; guildId; type: string; userId; reason: string|null; runAt; createdAt }`
- `scheduleAction(db, { guildId, type, userId, reason?, runAt }): ScheduledAction`
- `dueActions(db, now): ScheduledAction[]`
- `deleteScheduledAction(db, id): void`

- [ ] **Step 1: Write the repository**

```typescript
// src/repositories/scheduled-actions.repository.ts
import { asc, eq, lte } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { scheduledActions } from "../db/schema";

export type ScheduledActionType = "unban";

export interface ScheduledAction {
  id: number;
  guildId: string;
  type: string;
  userId: string;
  reason: string | null;
  runAt: number;
  createdAt: number;
}

export function scheduleAction(
  db: BotDatabase,
  input: { guildId: string; type: ScheduledActionType; userId: string; reason?: string; runAt: number },
): ScheduledAction {
  return db
    .insert(scheduledActions)
    .values({
      guildId: input.guildId,
      type: input.type,
      userId: input.userId,
      reason: input.reason ?? null,
      runAt: input.runAt,
      createdAt: Date.now(),
    })
    .returning()
    .get() as ScheduledAction;
}

export function dueActions(db: BotDatabase, now: number): ScheduledAction[] {
  return db
    .select()
    .from(scheduledActions)
    .where(lte(scheduledActions.runAt, now))
    .orderBy(asc(scheduledActions.runAt))
    .all() as ScheduledAction[];
}

export function deleteScheduledAction(db: BotDatabase, id: number): void {
  db.delete(scheduledActions).where(eq(scheduledActions.id, id)).run();
}
```

- [ ] **Step 2: Write the tests**

```typescript
// test/repositories/scheduled-actions.repository.test.ts
import { expect, test } from "bun:test";
import {
  deleteScheduledAction,
  dueActions,
  scheduleAction,
} from "../../src/repositories/scheduled-actions.repository";
import { makeTestDb } from "../helpers/db";

test("dueActions returns only actions at or before now, oldest first", () => {
  const db = makeTestDb();
  scheduleAction(db, { guildId: "g", type: "unban", userId: "u1", runAt: 100 });
  scheduleAction(db, { guildId: "g", type: "unban", userId: "u2", runAt: 300 });
  const due = dueActions(db, 200);
  expect(due.map((a) => a.userId)).toEqual(["u1"]);
});

test("delete removes an action", () => {
  const db = makeTestDb();
  const a = scheduleAction(db, { guildId: "g", type: "unban", userId: "u", runAt: 1 });
  deleteScheduledAction(db, a.id);
  expect(dueActions(db, 10).length).toBe(0);
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/repositories/scheduled-actions.repository.ts test/repositories/scheduled-actions.repository.test.ts
git commit -m "feat: add scheduled-actions repository"
```

---

## Task 3: Infraction ledger service

**Files:** Create `src/services/infractions.service.ts`; test.

**Interfaces:**
- `STRIKE_WEIGHTS: Record<string, number>`
- `computeActiveScore(cases: {type: string; createdAt: number}[], now: number, decayDays: number): number`

- [ ] **Step 1: Write the service**

```typescript
// src/services/infractions.service.ts
export const STRIKE_WEIGHTS: Record<string, number> = {
  note: 0,
  warn: 1,
  timeout: 2,
  kick: 3,
  ban: 0,
  unban: 0,
};

// Sum of weights for cases still within the decay window.
export function computeActiveScore(
  cases: { type: string; createdAt: number }[],
  now: number,
  decayDays: number,
): number {
  const cutoff = now - decayDays * 86_400_000;
  let score = 0;
  for (const c of cases) {
    if (c.createdAt >= cutoff) score += STRIKE_WEIGHTS[c.type] ?? 0;
  }
  return score;
}
```

- [ ] **Step 2: Write the tests**

```typescript
// test/services/infractions.service.test.ts
import { expect, test } from "bun:test";
import { computeActiveScore } from "../../src/services/infractions.service";

const NOW = 1_000 * 86_400_000; // day 1000 in ms

test("sums weights within the decay window", () => {
  const cases = [
    { type: "warn", createdAt: NOW - 1_000 }, // recent, +1
    { type: "timeout", createdAt: NOW - 1_000 }, // recent, +2
    { type: "note", createdAt: NOW - 1_000 }, // +0
  ];
  expect(computeActiveScore(cases, NOW, 90)).toBe(3);
});

test("ignores cases older than the decay window", () => {
  const old = NOW - 100 * 86_400_000; // 100 days ago
  const cases = [
    { type: "warn", createdAt: old },
    { type: "kick", createdAt: NOW - 1_000 },
  ];
  expect(computeActiveScore(cases, NOW, 90)).toBe(3); // only the kick counts
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/infractions.service.ts test/services/infractions.service.test.ts
git commit -m "feat: add decay-aware infraction score service"
```

---

## Task 4: Scheduler service

**Files:** Create `src/services/scheduler.service.ts`; test.

**Interfaces:**
- `type ActionExecutor = (ctx: AppContext, client: Client, action: ScheduledAction) => Promise<void>`
- `defaultExecutors: Record<ScheduledActionType, ActionExecutor>`
- `runDueActions(ctx, client, now, executors?): Promise<number>` — runs + deletes each due action, returns the count processed.
- `startScheduler(ctx, client, intervalMs?): () => void` — starts the poll loop, returns a stop function.

- [ ] **Step 1: Write the service**

```typescript
// src/services/scheduler.service.ts
import type { Client } from "discord.js";
import type { AppContext } from "../core/context";
import { createCase } from "../repositories/cases.repository";
import {
  type ScheduledAction,
  type ScheduledActionType,
  deleteScheduledAction,
  dueActions,
} from "../repositories/scheduled-actions.repository";
import { logCase } from "./modlog.service";

export type ActionExecutor = (
  ctx: AppContext,
  client: Client,
  action: ScheduledAction,
) => Promise<void>;

export const defaultExecutors: Record<ScheduledActionType, ActionExecutor> = {
  unban: async (ctx, client, action) => {
    const guild = await client.guilds.fetch(action.guildId);
    await guild.bans.remove(action.userId, action.reason ?? "Temp-ban expired").catch(() => {});
    const record = createCase(ctx.db, {
      guildId: action.guildId,
      userId: action.userId,
      moderatorId: client.user?.id ?? "system",
      type: "unban",
      reason: action.reason ?? "Temp-ban expired",
    });
    await logCase(ctx, guild, record);
  },
};

export async function runDueActions(
  ctx: AppContext,
  client: Client,
  now: number,
  executors: Record<string, ActionExecutor> = defaultExecutors,
): Promise<number> {
  const due = dueActions(ctx.db, now);
  for (const action of due) {
    const exec = executors[action.type];
    if (exec) {
      try {
        await exec(ctx, client, action);
      } catch (error) {
        ctx.logger.error("scheduled action failed", {
          id: action.id,
          type: action.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    deleteScheduledAction(ctx.db, action.id);
  }
  return due.length;
}

export function startScheduler(ctx: AppContext, client: Client, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void runDueActions(ctx, client, Date.now());
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 2: Write the tests** (fake executor + fake client)

```typescript
// test/services/scheduler.service.test.ts
import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { scheduleAction } from "../../src/repositories/scheduled-actions.repository";
import { type ActionExecutor, runDueActions } from "../../src/services/scheduler.service";
import { makeTestDb } from "../helpers/db";
import { silentContext } from "../helpers/fakes";

test("runs and deletes only due actions", async () => {
  const ctx = silentContext();
  scheduleAction(ctx.db, { guildId: "g", type: "unban", userId: "u1", runAt: 100 });
  scheduleAction(ctx.db, { guildId: "g", type: "unban", userId: "u2", runAt: 5_000 });

  const ran: string[] = [];
  const executors: Record<string, ActionExecutor> = {
    unban: async (_c, _cl, action) => {
      ran.push(action.userId);
    },
  };

  const count = await runDueActions(ctx, {} as Client, 200, executors);
  expect(count).toBe(1);
  expect(ran).toEqual(["u1"]);

  // The remaining future action is still there and runnable later.
  const later = await runDueActions(ctx, {} as Client, 10_000, executors);
  expect(later).toBe(1);
  expect(ran).toEqual(["u1", "u2"]);
});

test("a failing executor does not block deletion of the action", async () => {
  const ctx = silentContext();
  scheduleAction(ctx.db, { guildId: "g", type: "unban", userId: "u", runAt: 1 });
  const executors: Record<string, ActionExecutor> = {
    unban: async () => {
      throw new Error("boom");
    },
  };
  const count = await runDueActions(ctx, {} as Client, 10, executors);
  expect(count).toBe(1);
  // Second run finds nothing (it was deleted despite the failure).
  expect(await runDueActions(ctx, {} as Client, 10, executors)).toBe(0);
});
```

> Note: `silentContext()` (from `test/helpers/fakes.ts`) already provides an in-memory DB with migrations applied plus a real `ConfigService`, so `ctx.db` is usable here.

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/scheduler.service.ts test/services/scheduler.service.test.ts
git commit -m "feat: add scheduler service for durable delayed actions"
```

---

## Task 5: Start the scheduler in the entrypoint

**Files:** Modify `src/index.ts`.

- [ ] **Step 1: Wire it in**

Add the import:

```typescript
import { startScheduler } from "./services/scheduler.service";
```

After `const client = createClient(modules, ctx);` and before the `shutdown` definition, start the scheduler and capture its stop handle:

```typescript
  const stopScheduler = startScheduler(ctx, client);
```

In the `shutdown` function, stop it before destroying the client:

```typescript
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    stopScheduler();
    await client.destroy();
    process.exit(0);
  };
```

- [ ] **Step 2: Gate**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: start the scheduler poller from the entrypoint"
```

---

## Task 6: Temp-ban (duration option on `/ban`)

**Files:** Modify `src/modules/moderation/ban.ts`.

- [ ] **Step 1: Add the duration option and scheduling**

Add these imports to `ban.ts`:

```typescript
import { scheduleAction } from "../../repositories/scheduled-actions.repository";
import { MAX_TIMEOUT_MS, formatDuration, parseDuration } from "../../util/duration";
```

Add a `duration` string option to the builder (after `delete_days`):

```typescript
    .addStringOption((o) =>
      o.setName("duration").setDescription("Temp-ban length, e.g. 7d, 12h (omit for permanent)"),
    ),
```

In `execute`, after reading `reason`/`deleteDays`, parse an optional duration (reject > 28d to keep temp-bans sane, reuse `MAX_TIMEOUT_MS` as the ceiling):

```typescript
    const durationText = interaction.options.getString("duration");
    let durationMs: number | null = null;
    if (durationText) {
      durationMs = parseDuration(durationText);
      if (durationMs === null || durationMs > MAX_TIMEOUT_MS) {
        await interaction.reply({
          content: "Invalid temp-ban duration. Use e.g. `12h`, `7d` (max 28d).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
```

(Add `MessageFlags` to the `discord.js` import.)

After the successful `guild.members.ban(...)` call and before `recordAndAnnounce`, schedule the unban when a duration was given:

```typescript
    const reasonWithDuration = durationMs
      ? `${reason} (temp-ban ${formatDuration(durationMs)})`
      : reason;
    if (durationMs) {
      scheduleAction(ctx.db, {
        guildId: guild.id,
        type: "unban",
        userId: user.id,
        reason: "Temp-ban expired",
        runAt: Date.now() + durationMs,
      });
    }
    await recordAndAnnounce(interaction, ctx, {
      target: user,
      type: "ban",
      reason: reasonWithDuration,
    });
```

(Replace the previous final `recordAndAnnounce` call with the block above.)

- [ ] **Step 2: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`

```bash
git add src/modules/moderation/ban.ts
git commit -m "feat: support temp-bans via an optional duration on /ban"
```

---

## Task 7: Surface the active strike score in `/history`

**Files:** Modify `src/modules/moderation/history.ts`.

- [ ] **Step 1: Compute and show the score**

Add imports:

```typescript
import { CONFIG_KEYS } from "../../services/config.service";
import { computeActiveScore } from "../../services/infractions.service";
```

In `execute`, after fetching `records` and the empty-check, compute the score and add it to the embed:

```typescript
    const decayDays = ctx.config.get<number>(interaction.guildId, CONFIG_KEYS.strikeDecayDays) ?? 90;
    const score = computeActiveScore(records, Date.now(), decayDays);
    const lines = records.map((r) => `**#${r.caseNumber}** \`${r.type}\` — ${r.reason}`);
    const embed = new EmbedBuilder()
      .setTitle(`History for ${user.tag}`)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Active strike score: ${score} (last ${decayDays}d)` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
```

(Remove the previous `lines`/`embed`/`reply` block it replaces.)

- [ ] **Step 2: Add the config key**

In `src/services/config.service.ts`, add to `CONFIG_KEYS`:

```typescript
  strikeDecayDays: "strike_decay_days",
```

- [ ] **Step 3: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`

```bash
git add src/modules/moderation/history.ts src/services/config.service.ts
git commit -m "feat: show active strike score in /history"
```

---

## Task 8: Integration, live smoke test & PR

- [ ] **Step 1: Full gate**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`
Expected: all pass (≈36 tests).

- [ ] **Step 2: Live smoke test**

Run: `timeout --preserve-status --signal=SIGTERM 12 bun src/index.ts`
Expected: `migrations applied`, `registered guild commands` (still 10 — no new commands, `/ban` just gained an option), `logged in`, clean shutdown (exit 0). No scheduler errors in the logs.

- [ ] **Step 3: Push, PR, verify CI, merge**

```bash
git push -u origin feat/phase-2-infractions
gh pr create --title "Phase 2: infraction ledger, temp-bans & scheduler" --body "Implements docs/superpowers/plans/2026-07-13-phase2-infractions-scheduler.md."
gh pr checks --watch
gh pr merge --squash --delete-branch
```

---

## Self-Review

**1. Spec coverage** (design §5.2 Phase 2, minus auto-escalation which is deferred to Phase 3):
- Scheduler infrastructure (T1–T5) ✓
- Temp-ban / temp-actions (T6; temp-mute already exists as native `/timeout`) ✓
- Weighted, decaying strike score (T3) surfaced in `/history` (T7) ✓
- Persisted jobs survive restarts (T1 table + T2 repo + T5 poller) ✓

**2. Placeholder scan:** No TBD/TODO; complete code throughout. ✓

**3. Type consistency:** `ScheduledAction`/`ScheduledActionType` (T2) consumed by scheduler (T4) and `/ban` (T6). `computeActiveScore` (T3) consumed by `/history` (T7). `startScheduler` (T4) wired in `index.ts` (T5). `CONFIG_KEYS.strikeDecayDays` added (T7) and read in `/history` (T7). ✓

## Execution Handoff

Plan complete and saved. Execute with executing-plans.
