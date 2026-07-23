# Anti-scam (honeypot + automod gaps + self-seeding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch compromised-account scam sprays via a honeypot trap channel, close the automod content gaps that let the scam through, and self-seed a local scam-signature blocklist from confirmed hits.

**Architecture:** A pure-lib + thin-async-module split matching the existing codebase. One shared `applyModAction` replaces four duplicated act→case→log copies. A honeypot `messageCreate` listener (fail-closed, burst-deduped) actions trap posters. Automod gains blocklist-only bare-domain + embed/attachment hostname extraction and a cross-channel spray detector. A `scam_signature` SQLite table, written only by the honeypot + a manual command, is read on every message.

**Tech Stack:** TypeScript on Bun · discord.js v14 · raw `bun:sqlite` · `Bun.CryptoHasher` (built-in, no deps) · `bun test`.

## Global Constraints

- **No new runtime dependencies** unless unavoidable. Phase 1–3 core add none (SHA-256 is `Bun.CryptoHasher`, built in). The optional feed (deferred, default-off) is the only thing that would add `tldts`, and it is NOT built in this plan.
- **Everything configurable via the `/config` registry** (`src/lib/config.ts`); nothing hardcoded. Every member-removing setting **defaults `off`/false**.
- **Pure logic in `src/lib/*`, Discord/DB I/O in `src/modules/*`.** Pure files get `test/lib/*.test.ts`; module wrappers are not unit-tested (house convention).
- **Test style:** `import { expect, test } from "bun:test"`, no `describe`, no mocking framework, `silentContext()` / fakes from `test/helpers/`.
- **Reuse `GUARD_ACTIONS`** (`"off"|"flag"|"kick"|"ban"`) for the honeypot action — no new enum.
- **Frequent commits**, one per task. `bun test` + `bun run typecheck` green before each commit.
- Config `get<T>()` for unset-sensitive keys (channel/role IDs); `getEffective<T>()` for keys with a meaningful default. A corrupt action row must fail safe to `"off"`.

---

## Task 1: Extract `applyModAction` shared lib

**Files:**
- Create: `src/lib/mod-action.ts`
- Create: `test/lib/mod-action.test.ts`

**Interfaces:**
- Consumes: `createCase` (`src/db/cases.ts`), `logCase` (`src/lib/modlog.ts`), `AppContext`.
- Produces:
  - `interface ModActionInput { guild: Guild; member: GuildMember | null; userId: string; type: "timeout"|"kick"|"ban"; reason: string; moderatorId: string; deleteMessageSeconds?: number; timeoutMs?: number; dm?: string }`
  - `export async function applyModAction(ctx: AppContext, input: ModActionInput): Promise<boolean>` — returns true iff the Discord action landed; never throws.
  - `export function canAct(opts: { me: { rolePos: number; hasPerm: boolean } | null; targetRolePos: number | null; userId: string; ownerId: string }): boolean` — pure gate, extracted for testing.

- [ ] **Step 1:** Write `test/lib/mod-action.test.ts` covering `canAct`: (a) null me → false; (b) null target role pos → false; (c) userId === ownerId → false; (d) target role ≥ me role → false; (e) `hasPerm` false → false; (f) all good → true.
- [ ] **Step 2:** Run `bun test test/lib/mod-action.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `src/lib/mod-action.ts`. `canAct` is the pure gate (outranks + owner + perm). `applyModAction` resolves `me = guild.members.me`, computes the permission flag from `type` (ban→BanMembers, kick→KickMembers, timeout→ModerateMembers), calls `canAct`; on fail returns false. Then: ban → `notify()` (DM before) → `guild.members.ban(userId, { reason: reason.slice(0,500), deleteMessageSeconds })`; kick → `notify()` → `member.kick(reason)`; timeout → `member.timeout(timeoutMs ?? 0, reason)` → `notify()` (DM after). Wrap the action in try/catch → return false on throw. Then try `logCase(ctx, guild, createCase(...))` in its own try/catch that logs-but-doesn't-throw. Return true.
- [ ] **Step 4:** Run `bun test test/lib/mod-action.test.ts` → PASS.
- [ ] **Step 5:** `bun run typecheck` → clean. Commit `feat(mod): extract applyModAction shared helper`.

## Task 2: Refactor automod + guards onto `applyModAction`

**Files:**
- Modify: `src/modules/automod/index.ts` (`escalate()` — replace the inline ban/kick/timeout + case + log block with `applyModAction`, keeping `deleteMessageSeconds` on ban now)
- Modify: `src/modules/guards/index.ts` (`enforce()` — same)

**Interfaces:**
- Consumes: `applyModAction` from Task 1.

- [ ] **Step 1:** Run the full existing suite `bun test` → capture green baseline.
- [ ] **Step 2:** Refactor `escalate()` to build a `ModActionInput` and call `applyModAction`. Ban now passes `deleteMessageSeconds` from a new `automod_ban_delete_hours`-free default — **use 0 (no change to existing ban-wipe behaviour is a bug we are fixing);** pass `deleteMessageSeconds: 24*3600` ONLY if we add a config key. Decision: keep automod ban wipe at **1 day** by threading a constant for now — but to stay configurable, add `automodBanDeleteHours` (int 0–168, default 24, category "automod-actions"). Preserve DM copy + suppressWarnDm return semantics: `escalate` returns `decision.suppressWarnDm` on skip and `true` after acting.
- [ ] **Step 3:** Refactor guards `enforce()` similarly (kick/ban; no timeout in guards). Preserve the guard-DM-on-removal behaviour by passing `dm`.
- [ ] **Step 4:** `bun test` → all still PASS (behaviour preserved). `bun run typecheck` clean.
- [ ] **Step 5:** Commit `refactor(mod): route automod + guards through applyModAction (+ automod ban wipe)`.

## Task 3: Config registry — honeypot + anti-scam settings

**Files:**
- Modify: `src/lib/config.ts` (CONFIG_KEYS, CATEGORIES, REGISTRY)
- Modify: `README.md` (settings count + caps description doc fix)
- Test: `test/lib/config.test.ts` (extend)

**Interfaces:**
- Produces: new `CONFIG_KEYS.honeypot*` and `CONFIG_KEYS.antiscam*` keys (exact list in spec §8), two new categories `honeypot` + `antiscam`.

- [ ] **Step 1:** Add a test asserting every new key is in the registry, each category renders within the 40-component panel budget, and `honeypot_action` default is `"off"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add keys to `CONFIG_KEYS`; add `honeypot` + `antiscam` to `CATEGORIES`; add REGISTRY entries per spec §8 (honeypot: channel/action/delete_hours/panel_text/exempt_roles/dm_user/alert_role; antiscam spray: action/channels/seconds/similarity/min_chars/match_attachments/timeout_minutes/exempt_staff/purge; antiscam blocklist+seed: blocklist_action/bare_domains/scan_embeds/scan_attachment_names/seed_from_honeypot/seed_domains/seed_images/seed_max_bytes/seed_ttl_days/seed_max_entries). Also add `automodBanDeleteHours` from Task 2. Fix the `automod_caps` description "10+ letters"→"24+ letters". Update README count.
- [ ] **Step 4:** Run `bun test test/lib/config.test.ts` → PASS.
- [ ] **Step 5:** `bun run typecheck` clean. Commit `feat(config): honeypot + anti-scam settings`.

## Task 4: `src/lib/honeypot.ts` (pure)

**Files:**
- Create: `src/lib/honeypot.ts`
- Create: `test/lib/honeypot.test.ts`

**Interfaces:**
- Produces: `channelIsHoneypot(ctx, guildId, channel)`, `inHoneypotChannel(ctx, message)` — signatures mirror `src/lib/verify-channel.ts`.

- [ ] **Step 1:** Write test: unset channel → false; exact match → true; thread under it → true; sibling channel + thread under sibling → false (mirrors verify-channel tests).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per spec §4.1.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** typecheck; commit `feat(honeypot): channel-membership lib`.

## Task 5: Honeypot module + automod early-return + registration

**Files:**
- Create: `src/modules/honeypot/index.ts`
- Modify: `src/modules/automod/index.ts` (split the `scan()` guard; add `inHoneypotChannel` early-return above the `!message.content` guard)
- Modify: `src/modules/index.ts` (import + insert `honeypotModule` before `automodModule`)

**Interfaces:**
- Consumes: `inHoneypotChannel` (Task 4), `applyModAction` (Task 1), `logModAlert`/`buildCaseEmbed` (`src/lib/modlog.ts`), `GUARD_ACTIONS`/`GuardAction`, `suppressDeletion` (`src/lib/log-suppress.ts`), `featureCommand` (`src/core/command.ts`).
- Produces: `honeypotModule: BotModule` with a `messageCreate` listener, a `/honeypot panel` command, and an exported `pendingSeeds` hook point (a callback array or emitter) that Task 9 subscribes to — **define the seam here as `onHoneypotHit(handler)` even though Task 9 fills it.**

- [ ] **Step 1:** Add the automod early-return (`if (inHoneypotChannel(ctx, message)) return;` between the bot-check and the `!message.content` check). Run `bun test` → still green.
- [ ] **Step 2:** Implement the honeypot module per spec §4.2: synchronous `claim()` map (30s TTL, prune >500); resolve member, **fail closed** (null → log warn, return); exempt owner / `ManageMessages` / `honeypot_exempt_roles`; action from `getEffective` mapped safely to `GuardAction` (`off` short-circuits); capture bait text + attachment metadata BEFORE acting; `applyModAction` with `deleteMessageSeconds = honeypot_delete_hours*3600` on ban; `logModAlert` with an embed (user, channel, bait, action, ping `honeypot_alert_role_id`). On kick/flag delete the bait message with `suppressDeletion` first. Fire `onHoneypotHit({ guild, userId, content, attachments, caseType })` for Task 9.
- [ ] **Step 3:** Implement `/honeypot panel` (permission `ManageGuild`) → posts `honeypot_panel_text` embed in-channel. Register `honeypotModule` before `automodModule`.
- [ ] **Step 4:** `bun test` + `bun run typecheck` clean. Manual reasoning check: image-only bait post is not caught by automod (early-return above content guard).
- [ ] **Step 5:** Commit `feat(honeypot): trap channel module + panel + automod exemption`.

## Task 6: Hostname extraction lib (content + embeds + filenames + bare-domain)

**Files:**
- Modify: `src/lib/automod.ts` (add `extractHostnames(sources)` + keep `hasUnallowedLink` untouched)
- Test: `test/lib/automod.test.ts` (extend)

**Interfaces:**
- Produces: `export function extractHostnames(opts: { content: string; embedTexts?: string[]; filenames?: string[]; includeBare: boolean }): string[]` — normalized lowercase hostnames. Bare `domain.tld` included only when `includeBare`. Reuses `domainOf`.

- [ ] **Step 1:** Tests: `https://mrbeast-drop.xyz/claim` → `["mrbeast-drop.xyz"]`; bare `mrbeast-drop.xyz` with `includeBare:true` → hostname; bare `readme.md` with `includeBare:true` → **excluded** (`.md` is not a real public suffix — verify via a small known-TLD guard or PSL-free heuristic: require a dot + a 2+ alpha TLD that isn't a common file-ext set `{md,sh,txt,js,ts,png,jpg,…}`); embed description hostname extracted; filename `evil.gg-nitro.png` handled sanely.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `extractHostnames`. Bare-domain matcher excludes a hardcoded file-extension denylist so `readme.md`/`script.sh` never become hostnames. This function only *produces candidates*; the blocklist decision (Task 9) is the only consumer that acts on bare domains.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** typecheck; commit `feat(automod): unified hostname extraction (embeds/filenames/bare)`.

## Task 7: Cross-channel spray detector (extend heat.ts)

**Files:**
- Modify: `src/lib/heat.ts` (new `SprayTracker` class; leave `HeatTracker`/`RepeatTracker` intact)
- Test: `test/lib/heat.test.ts` (extend)

**Interfaces:**
- Produces: `export class SprayTracker { record(key: string, entry: { channelId: string; text: string; fp: string | null; now: number }, opts: { windowMs: number; minChars: number; similarity: number; channels: number }): boolean }` — true when ≥`channels` distinct channels carry a near-identical (normalized-Levenshtein ≥ similarity, text capped 300 chars) OR identical-`fp` message within the window. **Records image-only entries** (no `if (!text) return`).

- [ ] **Step 1:** Tests: same text in 3 distinct channels within window → true; same text in same channel 3× → false (distinct-channel requirement); image-only (empty text, identical fp) across 3 channels → true; below `minChars` text ignored; near-duplicate (1 char diff) counts; window expiry drops old entries.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `SprayTracker` + a small normalized-Levenshtein similarity helper (cap inputs at 300 chars). Self-prune >1000 keys like the others.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** typecheck; commit `feat(automod): cross-channel spray detector`.

## Task 8: `scam_signature` table + query module

**Files:**
- Modify: `schema.sql` (add `scam_signature` table + expiry index)
- Create: `src/db/scam-signature.ts`
- Create: `test/db/scam-signature.test.ts`
- Modify: `test/db/index.test.ts` (add table to the manifest)

**Interfaces:**
- Produces: `upsertSignature(db, { guildId, kind, value, source, caseId?, ttlMs? })`, `hasSignature(db, guildId, kind, value): boolean` (bumps `hits`+`last_seen`), `loadSignatures(db, guildId): { domain: Set<string>; sha256: Set<string>; triple: Set<string> }`, `pruneExpiredSignatures(db, now)`, `evictOldest(db, guildId, kind, max)`, `removeSignature(db, guildId, kind, value)`.

- [ ] **Step 1:** Tests: upsert + hasSignature roundtrip per kind; upsert conflict bumps hits/last_seen; TTL prune removes expired only; evictOldest keeps newest `last_seen`; removeSignature deletes.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add table to `schema.sql` (spec §5.4); implement query module (prepared statements, `COLUMNS` constant style like `cases.ts`); add `"scam_signature"` to the `test/db/index.test.ts` manifest.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** typecheck; commit `feat(db): scam_signature table + queries`.

## Task 9: Anti-scam module — blocklist check + self-seeding + manual seed + prune

**Files:**
- Create: `src/modules/antiscam/index.ts` (messageCreate listener: hostname/triple/sha256 check → configurable action; SprayTracker wiring; `onHoneypotHit` subscriber that extracts + seeds; `/antiscam seed|forget` command; mod-log "not a scam" button)
- Modify: `src/modules/index.ts` (register `antiscamModule`)
- Modify: `src/lib/scheduler.ts` (call `pruneExpiredSignatures` on the tick)
- Modify: `src/modules/honeypot/index.ts` (ensure `onHoneypotHit` seam is exported/callable)

**Interfaces:**
- Consumes: `extractHostnames` (T6), `SprayTracker` (T7), signature queries (T8), `applyModAction` (T1), `onHoneypotHit` (T5), `Bun.CryptoHasher`.
- Produces: `antiscamModule: BotModule`.

- [ ] **Step 1 (blocklist check):** messageCreate → if `antiscam_blocklist_action !== off`: `extractHostnames({..., includeBare: antiscam_bare_domains})`, check against `loadSignatures().domain`; if `antiscam_seed_images`/triple gating on, check `(size:w:h)` triple then (on hit) fetch `attachment.url` (guard `seed_max_bytes` + timeout), SHA-256, check `sha256` set. On match → action (`flag`/`delete`/`ban`); `delete` records a `warn` case so the existing ladder escalates.
- [ ] **Step 2 (spray):** wire `SprayTracker` with the `antiscam_spray_*` config; on trip → `applyModAction` (timeout default) + optional purge of tracked messages; staff-exempt per `antiscam_spray_exempt_staff` (default false).
- [ ] **Step 3 (seeding):** subscribe to `onHoneypotHit`; if `antiscam_seed_from_honeypot`: extract domains (skip allowlist + hardcoded-safe + public-suffix/shared-host apex) and, if `seed_images`, download+hash the attachment(s) (guarded), `upsertSignature(source:'honeypot', ttlMs: seed_ttl_days)`, then `evictOldest` to `seed_max_entries`. Also `/antiscam seed <message-link>` (manual, `ManageGuild`) and a mod-log "not a scam — remove" button calling `removeSignature`.
- [ ] **Step 4:** register module; add `pruneExpiredSignatures` to the scheduler tick (guarded like `pruneExpiredChallenges`). `bun test` + `bun run typecheck` clean.
- [ ] **Step 5:** Commit `feat(antiscam): blocklist check + honeypot self-seeding + manual seed`.

## Task 10: Docs + full verification sweep

**Files:**
- Modify: `README.md` (Features: honeypot + anti-scam; Categories count; Commands: `/honeypot`, `/antiscam`)

- [ ] **Step 1:** Update README Features/Commands/Categories.
- [ ] **Step 2:** `bun test` (whole suite) → all PASS.
- [ ] **Step 3:** `bun run typecheck` → clean.
- [ ] **Step 4:** Self-review diff against spec §12 file list; run `/code-review`-style pass (requesting-code-review skill).
- [ ] **Step 5:** Commit `docs(antiscam): README for honeypot + anti-scam`.

## Self-Review notes

- **Spec coverage:** honeypot (T4/T5), automod gaps — bare-domain (T6), embed/attachment (T6), spray (T7), bug fixes: automod ban wipe (T2), caps desc + README (T3/T10) — self-seeding (T8/T9), mod-action extraction (T1/T2), config (T3). All spec §12 files mapped.
- **Not built, no stub:** external FishFish/SY feed sync + `tldts`. No config toggle ships for it (a dead `antiscam_domain_feed` key was removed) — it would get its own plan + keys if ever built.
- **Type consistency:** `applyModAction`/`ModActionInput` (T1) used verbatim in T2/T5/T9; `onHoneypotHit` seam defined T5, consumed T9; signature query names (T8) used in T9.
