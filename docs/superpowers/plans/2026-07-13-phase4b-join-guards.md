# clanker-bot Phase 4B — Account-Age Gate & Raid Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Two config-gated join guards: (1) an **account-age gate** that flags to the mod-log AND auto-kicks accounts younger than a configured age; (2) **join-velocity raid detection** that alerts the mod-log (only) when a join spike is detected.

**Architecture:** A `guards` module adds a `guildMemberAdd` listener. Account age comes from the user-ID snowflake (`createdTimestamp`). Raid detection reuses the `HeatTracker` (keyed per-guild) wrapped in a `RaidDetector` with an alert cooldown. Both write to the mod-log via a new `logModAlert` helper. Both default OFF.

**Tech Stack:** As before.

## Global Constraints

- All prior constraints (repository layer, `bun run lint:fix` before gate, gate = `bun test && bun run typecheck && bun run lint`, per-task commits).
- Defaults OFF: `min_account_age_days` (number, 0 = off) and `raid_detection` (bool, default false).
- Account-age action is fixed: **flag to mod-log + auto-kick**. Raid response is **alert-only**.
- Raid thresholds are code constants (window 10s, 8 joins, 60s alert cooldown).

---

## File Structure

```
src/services/config.service.ts     # MODIFY: minAccountAgeDays, raidDetection keys
src/modules/config/index.ts        # MODIFY: /config min-account-age + raid-detection toggle choice
src/services/modlog.service.ts     # MODIFY: export logModAlert
src/services/raid.service.ts       # NEW: RaidDetector
src/modules/guards/index.ts        # NEW: guildMemberAdd guards
src/modules/index.ts               # MODIFY: register guardsModule
test/services/raid.service.test.ts
```

---

## Task 1: Config keys + commands

**Files:** Modify `src/services/config.service.ts`, `src/modules/config/index.ts`.

- [ ] **Step 1: Add keys** — in `CONFIG_KEYS`: `minAccountAgeDays: "min_account_age_days",` and `raidDetection: "raid_detection",`.

- [ ] **Step 2: Add `raid-detection` to the `/config toggle` choices** — in the `toggle` subcommand's `addChoices(...)`, add `{ name: "raid-detection", value: "raid_detection" }`.

- [ ] **Step 3: Add a `min-account-age` subcommand** to the `/config` builder:

```typescript
  .addSubcommand((s) =>
    s
      .setName("min-account-age")
      .setDescription("Kick+flag accounts younger than this many days (0 = off).")
      .addIntegerOption((o) =>
        o.setName("days").setDescription("Minimum age in days (0 disables)").setMinValue(0).setRequired(true),
      ),
  )
```

Handler branch in `execute`:

```typescript
    if (sub === "min-account-age") {
      const days = interaction.options.getInteger("days", true);
      ctx.config.set(guildId, CONFIG_KEYS.minAccountAgeDays, days);
      await interaction.reply({
        content: days > 0 ? `Account-age gate set to ${days}d.` : "Account-age gate disabled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
```

Add to `/config view` (in `addFields`):

```typescript
        {
          name: "Min account age",
          value: (() => {
            const d = ctx.config.get<number>(guildId, CONFIG_KEYS.minAccountAgeDays) ?? 0;
            return d > 0 ? `${d}d` : "off";
          })(),
        },
        {
          name: "Raid detection",
          value: ctx.config.get<boolean>(guildId, CONFIG_KEYS.raidDetection) ? "on" : "off",
        },
```

- [ ] **Step 4: Gate & commit**

```bash
git add src/services/config.service.ts src/modules/config/index.ts
git commit -m "feat: add account-age and raid-detection config"
```

---

## Task 2: mod-log alert helper + RaidDetector

**Files:** Modify `src/services/modlog.service.ts`; create `src/services/raid.service.ts`; test.

- [ ] **Step 1: Export `logModAlert`** — append to `src/services/modlog.service.ts`:

```typescript
export async function logModAlert(ctx: AppContext, guild: Guild, embed: EmbedBuilder): Promise<void> {
  await sendToConfigured(ctx, guild, CONFIG_KEYS.modLogChannelId, embed);
}
```

- [ ] **Step 2: Write `RaidDetector`**

```typescript
// src/services/raid.service.ts
import { HeatTracker } from "./heat.service";

export class RaidDetector {
  private readonly tracker: HeatTracker;
  private readonly lastAlert = new Map<string, number>();

  constructor(
    windowMs = 10_000,
    threshold = 8,
    private readonly cooldownMs = 60_000,
  ) {
    this.tracker = new HeatTracker(windowMs, threshold);
  }

  // Returns true when a raid is detected and an alert should fire (cooldown-gated).
  record(guildId: string, now: number): boolean {
    if (!this.tracker.record(guildId, "join", now)) return false;
    const last = this.lastAlert.get(guildId) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.lastAlert.set(guildId, now);
    return true;
  }
}
```

- [ ] **Step 3: Test**

```typescript
// test/services/raid.service.test.ts
import { expect, test } from "bun:test";
import { RaidDetector } from "../../src/services/raid.service";

test("alerts once when joins exceed the threshold, then respects cooldown", () => {
  const d = new RaidDetector(10_000, 3, 60_000);
  const t = 1_000_000;
  expect(d.record("g", t)).toBe(false); // 1
  expect(d.record("g", t + 1)).toBe(false); // 2
  expect(d.record("g", t + 2)).toBe(false); // 3
  expect(d.record("g", t + 3)).toBe(true); // 4 -> over threshold, first alert
  expect(d.record("g", t + 4)).toBe(false); // within cooldown
  expect(d.record("g", t + 70_000)).toBe(true); // cooldown elapsed, alert again
});
```

- [ ] **Step 4: Gate & commit**

```bash
git add src/services/modlog.service.ts src/services/raid.service.ts test/services/raid.service.test.ts
git commit -m "feat: add mod-log alert helper and raid detector"
```

---

## Task 3: Guards module

**Files:** Create `src/modules/guards/index.ts`; modify `src/modules/index.ts`.

- [ ] **Step 1: Write the module**

```typescript
// src/modules/guards/index.ts
import { EmbedBuilder, Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";
import { logModAlert } from "../../services/modlog.service";
import { RaidDetector } from "../../services/raid.service";

const raid = new RaidDetector();

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    const guild = member.guild;

    // Account-age gate: flag + auto-kick accounts younger than the threshold.
    const minDays = ctx.config.get<number>(guild.id, CONFIG_KEYS.minAccountAgeDays) ?? 0;
    if (minDays > 0) {
      const ageMs = Date.now() - member.user.createdTimestamp;
      if (ageMs < minDays * 86_400_000) {
        const ageDays = Math.floor(ageMs / 86_400_000);
        await logModAlert(
          ctx,
          guild,
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("New account kicked (age gate)")
            .addFields(
              { name: "User", value: `<@${member.id}> (${member.id})` },
              { name: "Account age", value: `${ageDays}d (min ${minDays}d)` },
            ),
        );
        await member.kick(`Account younger than ${minDays}d`).catch(() => {});
        return; // kicked; skip raid tracking for this join
      }
    }

    // Raid detection: alert the mod-log on a join spike.
    if (ctx.config.get<boolean>(guild.id, CONFIG_KEYS.raidDetection) ?? false) {
      if (raid.record(guild.id, Date.now())) {
        await logModAlert(
          ctx,
          guild,
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("⚠️ Possible raid detected")
            .setDescription("A burst of joins was detected. Consider locking down the server."),
        );
      }
    }
  },
};

export const guardsModule: BotModule = {
  name: "guards",
  listeners: [onJoin] as Listener[],
};
```

- [ ] **Step 2: Register** — in `src/modules/index.ts`, import and append `guardsModule`.

- [ ] **Step 3: Gate & commit**

```bash
git add src/modules/guards/index.ts src/modules/index.ts
git commit -m "feat: add account-age gate and raid-detection guards"
```

---

## Task 4: Integration, live smoke test & PR

- [ ] **Step 1: Full gate** — `bun run lint:fix && bun test && bun run typecheck && bun run lint`.
- [ ] **Step 2: Live smoke** — `timeout --preserve-status --signal=SIGTERM 12 bun src/index.ts` → 11 commands, connect, exit 0.
- [ ] **Step 3: Push, PR, verify CI, merge** (standard flow).

## Self-Review

**1. Coverage:** account-age gate flag+kick (Task 3) ✓; raid detection alert-only w/ cooldown (Task 2/3) ✓; both config-gated + default off (Task 1) ✓.
**2. Placeholders:** none.
**3. Types:** `CONFIG_KEYS.minAccountAgeDays`/`raidDetection` (Task 1) used in Task 3. `logModAlert` (Task 2) used in Task 3. `RaidDetector` (Task 2) used in Task 3.

## Execution Handoff

Execute with executing-plans.
