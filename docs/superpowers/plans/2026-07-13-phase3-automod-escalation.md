# clanker-bot Phase 3 — Automod & Auto-Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Add a bot-owned automod engine (spam/mention-spam + invite/link filtering) that deletes offending messages and logs a warn case, plus an opt-in auto-escalation ladder that acts on a user's active strike score (timeout → kick → ban).

**Architecture:** A `messageCreate` listener runs enabled, config-gated rules against each message; a violation → delete + warn case + mod-log + escalation check. A pure `escalationActionFor(score)` maps score bands to actions; `applyEscalation` runs the action when `auto_escalation` is enabled. Auto-applied escalation cases are excluded from scoring to prevent runaway compounding. Everything defaults **OFF**.

**Tech Stack:** As before (Bun, discord.js v14, Drizzle/`bun:sqlite`, Biome, `bun test`).

## Global Constraints

- All prior constraints apply (repository layer, `bun run lint:fix` before each gate, gate = `bun test && bun run typecheck && bun run lint`, per-task commits).
- **All new features default OFF** (config-gated). `auto_escalation` OFF by default despite including auto-ban.
- Requires the `MessageContent` intent (already enabled).
- Staff (users with `ManageMessages`) are exempt from automod.
- New config keys (all boolean, default false): `automod_spam`, `automod_invites`, `automod_links`, `auto_escalation`.
- Escalation ladder: score ≥3 → timeout 1h · ≥5 → timeout 1d · ≥8 → kick · ≥12 → ban.

---

## File Structure

```
src/services/config.service.ts          # MODIFY: add automod/escalation keys
src/modules/config/index.ts             # MODIFY: /config toggle + show flags in view
src/services/escalation.service.ts      # escalationActionFor + applyEscalation
src/services/infractions.service.ts     # MODIFY: exclude auto cases from score
src/services/heat.service.ts            # HeatTracker (sliding-window spam detector)
src/services/automod.service.ts         # detectViolation (pure rule checks)
src/modules/automod/index.ts            # messageCreate listener
src/modules/moderation/warn.ts          # MODIFY: run escalation after a warn
src/modules/index.ts                    # MODIFY: register automodModule
test/services/escalation.service.test.ts
test/services/infractions.service.test.ts  # MODIFY: add auto-exclusion test
test/services/heat.service.test.ts
test/services/automod.service.test.ts
```

---

## Task 1: Config keys + `/config toggle`

**Files:** Modify `src/services/config.service.ts`, `src/modules/config/index.ts`.

- [ ] **Step 1: Add keys** — in `CONFIG_KEYS`, append:

```typescript
  automodSpam: "automod_spam",
  automodInvites: "automod_invites",
  automodLinks: "automod_links",
  autoEscalation: "auto_escalation",
```

- [ ] **Step 2: Add a `toggle` subcommand** to `/config` in `src/modules/config/index.ts`. Add after the `dm-on-action` subcommand in the builder:

```typescript
  .addSubcommand((s) =>
    s
      .setName("toggle")
      .setDescription("Enable or disable a feature flag.")
      .addStringOption((o) =>
        o
          .setName("feature")
          .setDescription("Feature to toggle")
          .setRequired(true)
          .addChoices(
            { name: "automod-spam", value: "automod_spam" },
            { name: "automod-invites", value: "automod_invites" },
            { name: "automod-links", value: "automod_links" },
            { name: "auto-escalation", value: "auto_escalation" },
          ),
      )
      .addBooleanOption((o) =>
        o.setName("enabled").setDescription("On or off").setRequired(true),
      ),
  )
```

Add a handler branch in `execute` (before the final closing of the sub chain, i.e. after the `dm-on-action` block):

```typescript
    if (sub === "toggle") {
      const feature = interaction.options.getString("feature", true);
      const enabled = interaction.options.getBoolean("enabled", true);
      ctx.config.set(guildId, feature, enabled);
      await interaction.reply({
        content: `\`${feature}\` is now ${enabled ? "enabled" : "disabled"}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
```

Extend the `view` embed to show the flags — add these fields to the `view` `addFields(...)` call:

```typescript
        {
          name: "Automod",
          value: [
            `spam: ${ctx.config.get<boolean>(guildId, CONFIG_KEYS.automodSpam) ? "on" : "off"}`,
            `invites: ${ctx.config.get<boolean>(guildId, CONFIG_KEYS.automodInvites) ? "on" : "off"}`,
            `links: ${ctx.config.get<boolean>(guildId, CONFIG_KEYS.automodLinks) ? "on" : "off"}`,
          ].join(" · "),
        },
        {
          name: "Auto-escalation",
          value: ctx.config.get<boolean>(guildId, CONFIG_KEYS.autoEscalation) ? "on" : "off",
        },
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/config.service.ts src/modules/config/index.ts
git commit -m "feat: add automod/escalation config flags and /config toggle"
```

---

## Task 2: Escalation decision function

**Files:** Create `src/services/escalation.service.ts` (decision half only for now); test.

**Interfaces:** `interface EscalationAction { type: "timeout"|"kick"|"ban"; durationMs?: number }`; `escalationActionFor(score: number): EscalationAction | null`.

- [ ] **Step 1: Write it**

```typescript
// src/services/escalation.service.ts
export interface EscalationAction {
  type: "timeout" | "kick" | "ban";
  durationMs?: number;
}

export function escalationActionFor(score: number): EscalationAction | null {
  if (score >= 12) return { type: "ban" };
  if (score >= 8) return { type: "kick" };
  if (score >= 5) return { type: "timeout", durationMs: 86_400_000 };
  if (score >= 3) return { type: "timeout", durationMs: 3_600_000 };
  return null;
}
```

- [ ] **Step 2: Test**

```typescript
// test/services/escalation.service.test.ts
import { expect, test } from "bun:test";
import { escalationActionFor } from "../../src/services/escalation.service";

test("maps score bands to actions", () => {
  expect(escalationActionFor(0)).toBeNull();
  expect(escalationActionFor(2)).toBeNull();
  expect(escalationActionFor(3)).toEqual({ type: "timeout", durationMs: 3_600_000 });
  expect(escalationActionFor(5)).toEqual({ type: "timeout", durationMs: 86_400_000 });
  expect(escalationActionFor(8)).toEqual({ type: "kick" });
  expect(escalationActionFor(12)).toEqual({ type: "ban" });
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/escalation.service.ts test/services/escalation.service.test.ts
git commit -m "feat: add escalation ladder decision function"
```

---

## Task 3: Exclude auto-applied cases from the strike score

**Files:** Modify `src/services/infractions.service.ts`; extend its test.

- [ ] **Step 1: Update `computeActiveScore`**

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

function isAutoCase(meta?: string | null): boolean {
  if (!meta) return false;
  try {
    return (JSON.parse(meta) as { auto?: boolean }).auto === true;
  } catch {
    return false;
  }
}

export function computeActiveScore(
  cases: { type: string; createdAt: number; meta?: string | null }[],
  now: number,
  decayDays: number,
): number {
  const cutoff = now - decayDays * 86_400_000;
  let score = 0;
  for (const c of cases) {
    if (c.createdAt < cutoff) continue;
    if (isAutoCase(c.meta)) continue;
    score += STRIKE_WEIGHTS[c.type] ?? 0;
  }
  return score;
}
```

- [ ] **Step 2: Add a test** (append to `test/services/infractions.service.test.ts`)

```typescript
test("auto-applied cases do not count toward the score", () => {
  const cases = [
    { type: "warn", createdAt: NOW - 1_000 },
    { type: "kick", createdAt: NOW - 1_000, meta: '{"auto":true}' },
  ];
  expect(computeActiveScore(cases, NOW, 90)).toBe(1); // only the manual warn
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/infractions.service.ts test/services/infractions.service.test.ts
git commit -m "feat: exclude auto-escalation cases from the strike score"
```

---

## Task 4: Escalation executor + hook into `/warn`

**Files:** Modify `src/services/escalation.service.ts` (add `applyEscalation`); modify `src/modules/moderation/warn.ts`.

**Interfaces:** `applyEscalation(ctx: AppContext, guild: Guild, targetUserId: string): Promise<void>`.

- [ ] **Step 1: Add `applyEscalation`** to `src/services/escalation.service.ts`

```typescript
import type { Guild, GuildMember } from "discord.js";
import type { AppContext } from "../core/context";
import { createCase, listCasesByUser } from "../repositories/cases.repository";
import { CONFIG_KEYS } from "./config.service";
import { computeActiveScore } from "./infractions.service";
import { logCase } from "./modlog.service";

// ... existing EscalationAction + escalationActionFor ...

export async function applyEscalation(
  ctx: AppContext,
  guild: Guild,
  targetUserId: string,
): Promise<void> {
  if (!(ctx.config.get<boolean>(guild.id, CONFIG_KEYS.autoEscalation) ?? false)) return;

  const decayDays = ctx.config.get<number>(guild.id, CONFIG_KEYS.strikeDecayDays) ?? 90;
  const cases = listCasesByUser(ctx.db, guild.id, targetUserId, 100);
  const action = escalationActionFor(computeActiveScore(cases, Date.now(), decayDays));
  if (!action) return;

  const botMember = await guild.members.fetchMe();
  if (targetUserId === guild.ownerId || targetUserId === botMember.id) return;

  let member: GuildMember | undefined;
  try {
    member = await guild.members.fetch(targetUserId);
  } catch {
    member = undefined;
  }
  if (member && member.roles.highest.position >= botMember.roles.highest.position) return;

  const score = computeActiveScore(cases, Date.now(), decayDays);
  const reason = `Auto-escalation at strike score ${score}`;
  try {
    if (action.type === "ban") {
      await guild.members.ban(targetUserId, { reason });
    } else if (member && action.type === "kick") {
      await member.kick(reason);
    } else if (member && action.type === "timeout") {
      await member.timeout(action.durationMs ?? null, reason);
    } else {
      return; // kick/timeout require a present member
    }
  } catch (error) {
    ctx.logger.error("escalation action failed", {
      targetUserId,
      type: action.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const record = createCase(ctx.db, {
    guildId: guild.id,
    userId: targetUserId,
    moderatorId: botMember.id,
    type: action.type,
    reason,
    meta: { auto: true },
  });
  await logCase(ctx, guild, record);
}
```

- [ ] **Step 2: Run escalation after `/warn`** — in `src/modules/moderation/warn.ts`, add the import and call:

```typescript
import { applyEscalation } from "../../services/escalation.service";
```

At the end of `execute`, after `recordAndAnnounce(...)`:

```typescript
    if (interaction.guild) await applyEscalation(ctx, interaction.guild, target.id);
```

- [ ] **Step 3: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`

```bash
git add src/services/escalation.service.ts src/modules/moderation/warn.ts
git commit -m "feat: apply auto-escalation after warnings"
```

---

## Task 5: Heat tracker (sliding-window spam detector)

**Files:** Create `src/services/heat.service.ts`; test.

**Interfaces:** `class HeatTracker { constructor(windowMs?, maxMessages?); record(guildId, userId, now): boolean }` — returns true when the message count in the window exceeds the threshold.

- [ ] **Step 1: Write it**

```typescript
// src/services/heat.service.ts
export class HeatTracker {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 7_000,
    private readonly maxMessages = 5,
  ) {}

  record(guildId: string, userId: string, now: number): boolean {
    const key = `${guildId}:${userId}`;
    const recent = (this.events.get(key) ?? []).filter((t) => t > now - this.windowMs);
    recent.push(now);
    this.events.set(key, recent);
    return recent.length > this.maxMessages;
  }
}
```

- [ ] **Step 2: Test**

```typescript
// test/services/heat.service.test.ts
import { expect, test } from "bun:test";
import { HeatTracker } from "../../src/services/heat.service";

test("flags a burst over the threshold within the window", () => {
  const h = new HeatTracker(1_000, 3);
  let hot = false;
  for (let i = 0; i < 4; i++) hot = h.record("g", "u", 100 + i);
  expect(hot).toBe(true);
});

test("does not flag messages spread beyond the window", () => {
  const h = new HeatTracker(1_000, 3);
  expect(h.record("g", "u", 0)).toBe(false);
  expect(h.record("g", "u", 2_000)).toBe(false);
  expect(h.record("g", "u", 4_000)).toBe(false);
});

test("tracks users independently", () => {
  const h = new HeatTracker(1_000, 1);
  h.record("g", "u1", 100);
  expect(h.record("g", "u2", 100)).toBe(false);
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/heat.service.ts test/services/heat.service.test.ts
git commit -m "feat: add sliding-window heat tracker for spam detection"
```

---

## Task 6: Automod rule checks

**Files:** Create `src/services/automod.service.ts`; test.

**Interfaces:**
- `const INVITE_REGEX`, `const LINK_REGEX`
- `interface AutomodConfig { spam: boolean; invites: boolean; links: boolean; mentionLimit: number }`
- `checkContentRules(content: string, mentionCount: number, cfg: AutomodConfig): string | null` — returns a violation label or null (pure; excludes the heat check, which is stateful and handled in the listener).

- [ ] **Step 1: Write it**

```typescript
// src/services/automod.service.ts
export const INVITE_REGEX = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
export const LINK_REGEX = /https?:\/\/[^\s]+/i;

export interface AutomodConfig {
  spam: boolean;
  invites: boolean;
  links: boolean;
  mentionLimit: number;
}

// Content-based checks (mention-spam + invite/link). Heat-based spam is handled
// statefully in the listener via HeatTracker.
export function checkContentRules(
  content: string,
  mentionCount: number,
  cfg: AutomodConfig,
): string | null {
  if (cfg.spam && mentionCount > cfg.mentionLimit) return "mention spam";
  if (cfg.invites && INVITE_REGEX.test(content)) return "invite link";
  if (cfg.links && LINK_REGEX.test(content)) return "external link";
  return null;
}
```

- [ ] **Step 2: Test**

```typescript
// test/services/automod.service.test.ts
import { expect, test } from "bun:test";
import { type AutomodConfig, checkContentRules } from "../../src/services/automod.service";

const on: AutomodConfig = { spam: true, invites: true, links: true, mentionLimit: 5 };

test("flags invite links when enabled", () => {
  expect(checkContentRules("join discord.gg/abc123", 0, on)).toBe("invite link");
});

test("flags external links and mention spam", () => {
  expect(checkContentRules("see https://evil.example", 0, on)).toBe("external link");
  expect(checkContentRules("hi", 6, on)).toBe("mention spam");
});

test("respects disabled rules", () => {
  const off: AutomodConfig = { spam: false, invites: false, links: false, mentionLimit: 5 };
  expect(checkContentRules("discord.gg/abc https://x.y", 99, off)).toBeNull();
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/automod.service.ts test/services/automod.service.test.ts
git commit -m "feat: add automod content rule checks"
```

---

## Task 7: Automod module (messageCreate listener) + registration

**Files:** Create `src/modules/automod/index.ts`; modify `src/modules/index.ts`.

- [ ] **Step 1: Write the module**

```typescript
// src/modules/automod/index.ts
import { Events, PermissionFlagsBits } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { createCase } from "../../repositories/cases.repository";
import { type AutomodConfig, checkContentRules } from "../../services/automod.service";
import { CONFIG_KEYS } from "../../services/config.service";
import { applyEscalation } from "../../services/escalation.service";
import { HeatTracker } from "../../services/heat.service";
import { logCase } from "../../services/modlog.service";

const heat = new HeatTracker();

const onMessage: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    if (!message.guild || message.author.bot || !message.content) return;

    const cfg: AutomodConfig = {
      spam: ctx.config.get<boolean>(message.guild.id, CONFIG_KEYS.automodSpam) ?? false,
      invites: ctx.config.get<boolean>(message.guild.id, CONFIG_KEYS.automodInvites) ?? false,
      links: ctx.config.get<boolean>(message.guild.id, CONFIG_KEYS.automodLinks) ?? false,
      mentionLimit: 5,
    };
    if (!cfg.spam && !cfg.invites && !cfg.links) return;

    // Exempt staff.
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    let violation = checkContentRules(message.content, mentionCount, cfg);
    if (!violation && cfg.spam && heat.record(message.guild.id, message.author.id, Date.now())) {
      violation = "spam (message flood)";
    }
    if (!violation) return;

    await message.delete().catch(() => {});
    const record = createCase(ctx.db, {
      guildId: message.guild.id,
      userId: message.author.id,
      moderatorId: message.client.user.id,
      type: "warn",
      reason: `Automod: ${violation}`,
    });
    await logCase(ctx, message.guild, record);
    await applyEscalation(ctx, message.guild, message.author.id);
  },
};

export const automodModule: BotModule = {
  name: "automod",
  listeners: [onMessage] as Listener[],
};
```

- [ ] **Step 2: Register** — in `src/modules/index.ts`, import and append `automodModule`:

```typescript
import { automodModule } from "./automod";
// ...
export const modules: BotModule[] = [
  pingModule,
  configModule,
  loggingModule,
  moderationModule,
  automodModule,
];
```

- [ ] **Step 3: Gate & commit**

Run: `bun run lint:fix && bun test && bun run typecheck && bun run lint`

```bash
git add src/modules/automod/index.ts src/modules/index.ts
git commit -m "feat: add automod module (message scanning + escalation)"
```

---

## Task 8: Integration, live smoke test & PR

- [ ] **Step 1: Full gate** — `bun run lint:fix && bun test && bun run typecheck && bun run lint` (≈45 tests).

- [ ] **Step 2: Live smoke test**

Run: `timeout --preserve-status --signal=SIGTERM 12 bun src/index.ts`
Expected: `registered guild commands` (still 10 — automod adds a listener, `/config` gains a subcommand), `logged in`, clean shutdown (exit 0). No automod/escalation errors.

- [ ] **Step 3: Push, PR, verify CI, merge**

```bash
git push -u origin feat/phase-3-automod
gh pr create --title "Phase 3: automod & auto-escalation" --body "Implements docs/superpowers/plans/2026-07-13-phase3-automod-escalation.md. All features default OFF; enable via /config toggle."
gh pr checks --watch
gh pr merge --squash --delete-branch
```

---

## Self-Review

**1. Spec coverage:** Spam + mention-spam (T5 heat + T6 mention check, wired T7) ✓; invite/link filtering (T6, wired T7) ✓; default action delete + warn + log (T7) ✓; auto-escalation full ladder incl. auto-ban (T2/T4), opt-in + OFF by default (T1 flag) ✓; escalation runs from both automod (T7) and `/warn` (T4) ✓; auto cases excluded from score to prevent runaway (T3) ✓; staff exemption (T7) ✓.

**2. Placeholder scan:** No TBD/TODO; complete code throughout. ✓

**3. Type consistency:** `CONFIG_KEYS` additions (T1) used in T4/T7. `escalationActionFor`/`EscalationAction` (T2) + `applyEscalation` (T4) used in T4/T7. `computeActiveScore` new `meta?` field (T3) is backward-compatible (optional) and consumed by `applyEscalation` (T4) and `/history`. `AutomodConfig`/`checkContentRules` (T6) used in T7. `HeatTracker` (T5) used in T7. `createCase` `meta` accepted (Phase 1 repo) and set in T4. ✓

## Execution Handoff

Plan complete and saved. Execute with executing-plans.
