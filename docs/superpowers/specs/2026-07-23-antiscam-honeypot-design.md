# Anti-scam: honeypot + automod gap-closing + self-seeding

**Date:** 2026-07-23
**Status:** Design — awaiting approval
**Author:** K4HVH (with Claude)

## 1. Problem

Real members' Discord accounts are being compromised (credential/token theft). The
hijacked accounts run a toolkit that enumerates every readable channel and sprays a
"MrBeast crypto giveaway" scam — usually an image attachment plus a link to a scam
domain, sometimes ≤5 characters of text. The owner is asleep when it happens and deals
with it manually on waking.

Join-guards, the account-age gate, and the captcha are all structurally blind to this:
the account joined legitimately months ago and is already verified. The threat is a
*trusted* account behaving badly, not an untrusted account trying to get in.

### 1.1 Why the bot doesn't catch it today (verified against the live DB + code)

The live `data/clanker.sqlite` config was inspected. The three rules that would catch a
scam link are **off**:

| Setting | Live value | Effect |
|---|---|---|
| `automod_links` | unset → off | The scam URL is never inspected |
| `automod_invites` | unset → off | — |
| `automod_word_blocklist` | empty | "mrbeast"/"airdrop"/"free nitro" not matched |

The rules that *are* on all miss this payload:

- **`automod_caps`** requires ≥24 letters at ≥70 % uppercase (`src/lib/automod.ts:54`). A
  mixed-case scam never trips it. (The `/config` description says "10+ letters" — a doc bug.)
- **`automod_mass_mention`** reads `message.mentions.everyone`, the gateway *ping* flag
  (`src/modules/automod/index.ts:219`). A compromised regular member has no Mention
  Everyone permission, so their literal `@everyone` text sets the flag `false`. It doesn't fire.
- **flood (5/7 s) + duplicates** are the only live defences and both key to a 7-second
  window. A spray paced slower than that, or with per-channel text variation, trips nothing.
- **Attachment/embed-only posts are skipped entirely** — `scan()` bails at
  `if (!message.content) return` (`src/modules/automod/index.ts:182`). The current wave is
  image-first, so this is the exact blind spot.
- **`RepeatTracker`** (`src/lib/heat.ts:31`) returns early on empty text
  (`if (!norm) return false`) and never records `channelId`, so "same thing in N channels"
  is inexpressible *and* image-only spam is invisible to it.

### 1.2 Additional existing bugs found (fixed as part of this work)

- Automod's escalation ban (`src/modules/automod/index.ts:152`) calls
  `guild.members.ban(userId, { reason })` with **no `deleteMessageSeconds`** — so even a
  full escalation to ban leaves the scam messages up.
- README claims "48 settings"; the registry has 52 (Memes category undocumented in that count).

### 1.3 Is there a known-scam-image database we can use?

**No — not free, not paid, at no access level reachable by a self-hosted bot.** Verified
across two independent research passes:

- **PhotoDNA** is CSAM-only (NCMEC/IWF hashes, org-vetting required); it holds nothing
  scam-related. Same *technique* as us, not the same *data*.
- **APWG eCrime Exchange** carries image data but is members-only (formal org membership).
- **PhishTank / OpenPhish / URLhaus** are URL feeds; URLhaus's hashes are of malware
  binaries. PhishTank registration is currently disabled.
- The HuggingFace dataset literally named `discord-phishing-scam` is 2,000 rows of **text**,
  zero images.
- **Meta PDQ** is an algorithm; Meta ships no corpus. Every open-source project on this exact
  threat ships an **empty** DB and tells the operator to add their own samples.

The only image-matching layer available is one seeded from **our own confirmed-bad
samples** — which is what §5 (self-seeding) delivers. A scam-image corpus mutates ~2×/month
and is worthless in 60 days, so a shared corpus wouldn't help even if one existed.

## 2. Goals / non-goals

**Goals**

1. A honeypot trap channel: any non-bot post there triggers a configurable action
   (off/flag/kick/ban) with configurable message-wipe, plus an owner ping — catches the
   "spray every channel" behaviour with near-zero false positives.
2. Close the automod content gaps that let this scam through: bare-domain detection (against
   a blocklist only), embed + attachment-name scanning, and a cross-channel spray detector
   with its own window that sees image-only posts.
3. Self-seeding: when the honeypot fires, extract the scam's domains + a SHA-256 of the
   attachment bytes into a local blocklist, so the *next* compromised account posting the
   same scam anywhere is caught instantly — the practical substitute for a scam-image DB.
4. Everything configurable in the `/config` registry; everything that removes a member
   defaults **off**.

**Non-goals (explicitly out of scope — see §9)**

Perceptual image hashing (PDQ/pHash), OCR, a behavioural profile store, a Discord AutoMod
rule provisioner, and third-party domain-feed syncing as a *hard* dependency (an optional,
default-off feed sync is noted in §5.5 but is not required for the feature to work).

## 3. Architecture overview

Three phases, shippable independently, in this order:

- **Phase 1 — Honeypot.** New pure lib `src/lib/honeypot.ts`, new module
  `src/modules/honeypot/index.ts` (a `messageCreate` listener + `/honeypot panel` command),
  one load-bearing edit to automod's `scan()`, config block, mod-log alert.
- **Phase 2 — Automod gaps.** Shared hostname extractor (content + embeds + filenames +
  bare domains against a blocklist), cross-channel spray detector (extend `src/lib/heat.ts`),
  in-place bug fixes.
- **Phase 3 — Self-seeding.** New `scam_signature` table + `src/db/scam-signature.ts`, an
  extraction step wired to honeypot hits and a manual `/antiscam seed`, and the message-side
  check that reads the blocklist. Optional default-off external feed sync.

**Cross-cutting refactor:** extract `src/lib/mod-action.ts` — one implementation of
"act → write case → log" — and move automod's `escalate()` and guards' `enforce()` onto it.
The honeypot and spray detector use it too, so there is one code path instead of five.

## 4. Phase 1 — Honeypot

### 4.1 `src/lib/honeypot.ts` (pure, unit-tested)

Modeled line-for-line on `src/lib/verify-channel.ts`. Single trap channel (the config
picker is native single-select), matched including threads under it:

```ts
import type { Message, PartialMessage } from "discord.js";
import type { AppContext } from "../core/context";
import { CONFIG_KEYS } from "./config";

export function channelIsHoneypot(
  ctx: AppContext, guildId: string,
  channel: { id: string; isThread(): boolean; parentId?: string | null },
): boolean {
  const id = ctx.config.get<string>(guildId, CONFIG_KEYS.honeypotChannelId);
  if (!id) return false;
  if (channel.id === id) return true;
  return channel.isThread() && channel.parentId === id;
}

export function inHoneypotChannel(ctx: AppContext, message: Message | PartialMessage): boolean {
  const guildId = message.guildId;
  if (!guildId) return false;
  return channelIsHoneypot(ctx, guildId, message.channel);
}
```

### 4.2 `src/modules/honeypot/index.ts`

A `messageCreate` listener. Three correctness requirements (each verified against the code):

1. **Act first, clean up second.** Take the ban/kick before deleting anything — cleanup
   before sanction gives a hijacked account extra seconds of spray.
2. **Fail closed on member resolution.** Automod's staff check
   (`src/modules/automod/index.ts:195`) is `member?.permissions.has(...)`, which evaluates
   falsy when the member is unresolved → *not exempt* → acts. That fail-*open* is fine for
   delete-and-warn but unacceptable for an instant ban. The honeypot resolves the member and,
   if resolution fails, **takes no action and logs a warning**.
3. **Claim the user synchronously, before the first `await`.** A spray dispatches concurrent
   `messageCreate` handlers; without a synchronous claim you get N bans + N cases + N embeds.
   `runExclusive()` in automod is module-private, so the honeypot keeps its own in-memory
   `Map<string, number>` claim with a 30 s TTL, self-pruning past 500 entries.

Flow:

```
guild present, author not a bot?           → else return
inHoneypotChannel(ctx, message)?           → else return
action = configured action; action==off?   → else return
resolve member (message.member ?? fetch)
member null?                               → log warn, return   (FAIL CLOSED)
member has ManageMessages, or role in exempt list, or is owner? → return (staff testing trap)
claim(`${guildId}:${userId}`)?             → else return        (burst dedupe)
capture bait text + attachment metadata (BEFORE acting)
applyModAction(ctx, { ... })  // §6 — ban/kick with deleteMessageSeconds from config
logModAlert(ctx, guild, honeypotEmbed)     // who, which channel, what they posted, action taken, ping alert role
if Phase 3 seeding on: enqueue the captured evidence for signature extraction (§5)
```

**Message wipe.** On `ban`, pass `deleteMessageSeconds = honeypot_delete_hours * 3600`
(Discord hard cap 604800 = 7 days) — server-side prune wipes their recent messages
guild-wide in one call, closing the delete race with automod and needing no
`suppressDeletion`. On `kick`/`flag` there's no server-side prune; the honeypot deletes only
the bait message it saw, calling `suppressDeletion(message.id)` (from
`src/lib/log-suppress.ts`) first so the member-log doesn't echo the removed content.

**Double-logging.** A bot-token ban is auto-deduped by the audit-log listener
(`executorId === botId` short-circuits `planAuditEntry` and calls `markModRemoved`), so no
manual-ban echo and no "Member left" line. The inverse is the real risk: a bot ban that
forgets to log produces *silent* removals — so we always `logCase` + `logModAlert`.

### 4.3 `/honeypot panel` command

`featureCommand({ name: "honeypot", ... })` with one subcommand `panel`
(permission: `ManageGuild`) that posts the configured warning embed into the current channel
— same shape as `/verify panel` and `/ticket panel`. Text comes from `honeypot_panel_text`.

### 4.4 Load-bearing edit to automod

`src/modules/automod/index.ts:181-182`, split the guard so automod never touches the trap:

```ts
const guild = message.guild;
if (!guild || message.author.bot) return;
if (inHoneypotChannel(ctx, message)) return;   // honeypot owns this channel
if (!message.content) return;
```

Placed **above** the `!message.content` guard so an image-only bait post is still the
honeypot's alone. `honeypotModule` is registered before `automodModule` in
`src/modules/index.ts`, but this early-return is what actually prevents a contradictory
mod-log + delete race (ordering alone is insufficient because automod runs synchronously to
its first `await`). Automod's `onEdit` path is covered by the same early-return.

## 5. Phase 3 — Self-seeding (the answer to "known scam image DB")

*(Presented before Phase 2 because it defines the `scam_signature` table Phase 2's blocklist
checks read from. Build order remains 1 → 2 → 3.)*

**Core principle — provenance:** **only the honeypot and a manual `/antiscam seed` command
write to the blocklist. Every other detector only reads.** If a behavioural rule could
promote signatures, one false positive becomes a permanent rule that then auto-fires and
looks like fresh confirmation — a self-poisoning loop. The honeypot is the only
near-zero-false-positive oracle we have; a human eyeballing a message is the other.

### 5.1 What gets seeded

From a confirmed-bad message: **domains** (deterministic, reuses `domainOf()`) and a
**SHA-256 of the attachment bytes**. Never phrases (they mutate and cause substring false
positives like "claim your board").

### 5.2 SHA-256, not perceptual hashing

- `attachment.url` (cdn.discordapp.com) serves the **original uploaded bytes**;
  `attachment.proxyURL` (media.discordapp.net) re-encodes. **Always hash `attachment.url`.**
- Since bytes are preserved, PDQ's whole selling point (surviving re-encode) insures against
  a risk we don't carry. Under adversarial re-benchmarking PDQ also *failed* on hue shift,
  overlay, rotation and crop at any safe threshold, and carries a decompression-bomb DoS
  (a 745 KB PNG → ~1 GB pixel buffer, +3 GB RSS in ~1.3 s — a sprayed handful OOM-kills the
  bot). `Bun.CryptoHasher("sha256")` is built in, needs no decode, no pixel buffer, and has a
  false-positive rate of exactly zero.

### 5.3 Gating (near-free steady state)

`(size, width, height)` arrive inline on every `MESSAGE_CREATE` — no download. Only on a
triple match against a known-bad triple do we fetch `attachment.url` (guarded:
reject > `antiscam_seed_max_bytes`, fetch timeout) and SHA-256 it. Steady state is zero
downloads, zero CPU.

### 5.4 Storage — `scam_signature`

```sql
CREATE TABLE IF NOT EXISTS scam_signature (
  guild_id   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,  -- 'domain' | 'sha256' | 'triple'
  value      TEXT    NOT NULL,  -- hostname | hex digest | "size:w:h"
  source     TEXT    NOT NULL,  -- 'honeypot' | 'manual' | 'feed'
  case_id    INTEGER,
  hits       INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER,           -- NULL = never; self-seeded rows get a TTL
  PRIMARY KEY (guild_id, kind, value)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS scam_signature_expiry_idx ON scam_signature (expires_at);
```

New `src/db/scam-signature.ts` (COLUMNS + prepared `INSERT … ON CONFLICT`, lookup, prune,
count/evict). Loaded into an in-memory `Map<kind, Set<value>>` at boot and refreshed on
write; SQLite is persistence only (exact lookups, no similarity index). Self-seeded rows get
`antiscam_seed_ttl_days` expiry and an `antiscam_seed_max_entries` cap (oldest-`last_seen`
evicted). The scheduler tick (`src/lib/scheduler.ts`) gains a prune-expired sweep alongside
`pruneExpiredChallenges`.

**Promotion guards (never seed):** anything in `automod_link_allowlist`; a hardcoded floor
of Discord/GitHub/Espressif/etc. safe domains; any public suffix or shared-hosting apex
(store the full hostname for shared hosting, never the registrable domain). Wrong entries are
reversible via a one-click "not a scam — remove" button on the mod-log alert.

### 5.5 Optional external feed (default OFF, not required)

The same table accepts `source='feed'` rows. A default-off toggle can bootstrap FishFish
(`api.fishfish.gg/v1/domains`, ~43k domains, unauth) once at boot + Sinking Yachts deltas,
using `tldts` with `allowPrivateDomains: true` for suffix-walking. **Off by day one** — it's
purely additive coverage and adds HTTP/polling surface. Included in the config block so it
can be switched on later without a redeploy, but not part of the core deliverable.

### 5.6 Where self-seeding fails (stated plainly)

It's a *memory*, not a detector. It cannot catch a campaign that rotates both domain and
image, a wave whose first account skips the bait channel, or the first account of any
campaign. That's why the cross-channel spray detector (§7.3) is not optional — it catches
novel campaigns with no signature; self-seeding makes accounts #2 and #3 free.

## 6. Cross-cutting — `src/lib/mod-action.ts`

Extract the "act → record case → log" idiom duplicated across automod's `escalate()`,
guards' `enforce()`, and (would-be) the honeypot + spray detector.

```ts
export interface ModActionInput {
  guild: Guild;
  member: GuildMember | null;
  userId: string;
  type: "timeout" | "kick" | "ban";
  reason: string;             // clipped to 500 for the audit reason
  moderatorId: string;        // botId for automated actions
  deleteMessageSeconds?: number; // ban only, cap 604800
  timeoutMs?: number;         // timeout only
  dm?: string;                // DM before removal (ban/kick) / after (timeout)
}
export async function applyModAction(ctx: AppContext, input: ModActionInput): Promise<boolean>;
```

Preserves existing behaviour exactly: the outranks + permission gate matching
`automod/index.ts:129-138`; DM-before-removal for ban/kick, DM-after for timeout; never
throws (returns false on a failed action); logs-but-doesn't-throw on a failed case insert. A
null member ⇒ can't establish `outranks` ⇒ returns false (same as automod today). Callers
that need fail-*closed* semantics (the honeypot) do their own member-null check *before*
calling. Automod's `escalate()` and guards' `enforce()` are refactored onto it; the
interaction-command path (`src/modules/moderation/shared.ts`, which replies to an
interaction) is **not** touched — different shape, out of scope.

**Behaviour preservation is verified by the existing test suite plus new tests for the
extracted gate.**

## 7. Phase 2 — Automod gap-closing

### 7.1 Shared hostname extraction + bare-domain (blocklist-only)

New pure function that pulls candidate hostnames from: message content, embed
`url`/`title`/`description`/`fields`/`author.url`/`footer.text`, and attachment filenames.
Bare `domain.tld` (no scheme) is extracted **but only ever tested against the known-bad
blocklist (§5), never against the allowlist mode.** The existing `URL_REGEX` comment
(`src/lib/automod.ts:9`) about `readme.md`/`script.sh` false positives is correct and
preserved — `hardware.md` is not on any blocklist; `mrbeast-drop.xyz` is. Zero added
false-positive surface.

**Embed timing:** link-preview embeds attach *after* the message via `MessageUpdate`, and
`onEdit` (`src/modules/automod/index.ts:282`) correctly returns early when content is
unchanged. Embed scanning gets its own branch: content unchanged **but** embeds newly
present → run blocklist checks only (not the full rule set), so we don't re-punish on embed
loads.

### 7.2 In-place bug fixes

- Pass `deleteMessageSeconds` on automod's escalation ban (§1.2) — routed through
  `applyModAction`, so it's fixed for free by §6.
- `automod_caps` description: "10+ letters" → "24+ letters" (match `src/lib/automod.ts:54`).
- README settings count refreshed.
- (Considered, deferred:) `mass_mention` gateway-flag-only limitation — documented, not
  changed, since matching literal `@everyone` text risks false positives on quoted examples.
  Called out here so it's a decision, not an oversight.

### 7.3 Cross-channel spray detector

New rule with its **own** window (independent of `automod_flood_seconds`), built by extending
`src/lib/heat.ts`:

- Record per-user ring-buffer entries carrying `channelId`, a normalized-text key (capped at
  300 chars), and an attachment fingerprint `(size:w:h)`. **Fixes the two blind spots:** the
  `if (!norm) return false` early-return (so image-only posts count) and the missing
  `channelId` (so "N distinct channels" is expressible).
- Trip when the same user posts a near-identical message (normalized Levenshtein ≥
  `antiscam_spray_similarity`, or an identical attachment fingerprint) across ≥
  `antiscam_spray_channels` distinct channels within `antiscam_spray_seconds`.
- Action configurable (`off|flag|timeout|kick|ban`); **`timeout` is the recommended
  default** — the account belongs to a victim, and timeout is atomic, reversible, and stops
  posting immediately. Optionally purge the tracked messages across the hit channels.
- **Staff are NOT auto-exempt here (default off), deliberately** — a compromised mod account
  is exactly the case Discord's native AutoMod can't see (it unconditionally exempts
  Manage-Server holders). Configurable via `antiscam_spray_exempt_staff`.

Pure decision logic (thresholds, similarity, distinct-channel count) lives in a testable
function; the module wrapper does Discord I/O.

## 8. Config settings

Two new categories in `src/lib/config.ts`. A new category is cleaner than overloading
existing ones (measured: automod category is already at 36/40 component budget). Every
setting is one registry entry; panel/modal/validate/import/export pick them up with no
further code.

```ts
// CATEGORIES
{ id: "honeypot", label: "Honeypot", accentColor: 0xf1c40f },
{ id: "antiscam", label: "Anti-Scam", accentColor: 0xd35400 },
```

### Honeypot

| key | type | default | notes |
|---|---|---|---|
| `honeypot_channel_id` | channel | *(unset)* | Trap channel (native picker). Put it near the **top** of your channel list. Unset = feature inert. |
| `honeypot_action` | choice off/flag/kick/ban | **off** | Reuses `GUARD_ACTIONS`. Start on `flag` for a week, then `ban`. |
| `honeypot_delete_hours` | int 0–168 | 24 | Ban message-wipe → `deleteMessageSeconds` (cap 7 d). 0 = keep. |
| `honeypot_panel_text` | text | *(warning default)* | Rendered by `/honeypot panel`. |
| `honeypot_exempt_roles` | text | `""` | Role IDs never actioned. Owner + Administrator always exempt. |
| `honeypot_dm_user` | bool | true | DM **before** removal (no mutual guild after). |
| `honeypot_alert_role_id` | role | *(unset)* | Pinged in the mod-log on every trip. This is what wakes you. |

### Anti-Scam — cross-channel spray

| key | type | default | notes |
|---|---|---|---|
| `antiscam_spray_action` | choice off/flag/timeout/kick/ban | **off** | `timeout` recommended (victim's account). |
| `antiscam_spray_channels` | int 2–10 | 3 | Distinct channels to trip. |
| `antiscam_spray_seconds` | int 5–300 | 60 | Window. Independent of `automod_flood_seconds`. |
| `antiscam_spray_similarity` | int 50–100 | 85 | % similarity (normalized Levenshtein, 300-char cap). |
| `antiscam_spray_min_chars` | int 0–200 | 15 | Below this, text ignored for similarity ("gm"×3 won't trip). |
| `antiscam_spray_match_attachments` | bool | true | Identical `(size,w,h)` counts as a match even with no text — catches image-only "Bro" spray. Requires a *matching* fingerprint, not merely "has an attachment". |
| `antiscam_spray_timeout_minutes` | int 1–40320 | 60 | |
| `antiscam_spray_exempt_staff` | bool | **false** | Deliberately opposite the rest of automod (compromised-mod case). |
| `antiscam_spray_purge` | bool | true | Delete tracked messages across hit channels on trip. |

### Anti-Scam — known-bad signatures (self-seeded; optional feed)

| key | type | default | notes |
|---|---|---|---|
| `antiscam_blocklist_action` | choice off/flag/delete/ban | **off** | `delete` records a violation and lets the existing `automod_*_at` ladder escalate — reuse, don't duplicate. |
| `antiscam_bare_domains` | bool | true | Match bare `domain.tld` against the **blocklist only**. |
| `antiscam_scan_embeds` | bool | true | Extract hostnames from embeds. |
| `antiscam_scan_attachment_names` | bool | true | Extract hostnames from attachment filenames. |
| `antiscam_seed_from_honeypot` | bool | **false** | Promote signatures from confirmed honeypot hits. Honeypot + `/antiscam seed` are the **only** writers. Enable after a clean week. |
| `antiscam_seed_domains` | bool | true | Sub-toggle. Skips allowlisted / public-suffix / shared-hosting apex. |
| `antiscam_seed_images` | bool | true | Sub-toggle. `(size,w,h)` + SHA-256 of `attachment.url` bytes. Never stores the image. |
| `antiscam_seed_max_bytes` | int 1–25 | 8 | MB. Larger attachments fingerprinted by triple only, never downloaded. |
| `antiscam_seed_ttl_days` | int 1–365 | 30 | Expiry on every self-seeded entry. |
| `antiscam_seed_max_entries` | int 50–5000 | 500 | Cap; oldest-`last_seen` evicted. |
| `antiscam_domain_feed` | bool | **false** | Optional FishFish/SY sync (§5.5). Off by default. |

*(Feed URL/interval keys added only if `antiscam_domain_feed` is built; omitted here to keep
the day-one surface small.)*

## 9. What we explicitly do NOT build

- **Perceptual image hashing (PDQ/pHash/blockhash)** — insures against re-encoding that
  doesn't happen; fails on hue/overlay/rotation/crop at safe thresholds; 3 GB-RSS
  decompression-bomb DoS; depends on a 0-star unofficial package with a broken ESM entry.
- **OCR** — 44 MB dep; the accuracy evidence was circular (same source wrote the test images
  and the regexes grading them). Items 1–3 already catch wave one including its attachment.
- **Behavioural profile store** (first-link-ever, dormancy-break) — no bot ships it; ~3.6 %
  FP floor; needs a schema, backfill, cold-start guard for a score nudge on a rule that
  already fires.
- **Discord AutoMod rule provisioner** — ~300 LOC of DB↔Discord drift + reconciliation for a
  single guild. These are set-once server settings; configure by hand. (Turning on native
  SPAM + MENTION_SPAM in Server Settings tonight is a zero-code win that keeps working while
  the bot is down — recommended, but a manual action, not a build task.)
- **Extra domain feeds** (Phishing.Database lists `pastebin.com` as a bare apex —
  disqualifying for a community that pastes build logs).
- **Storing scam image bytes; seeding scam phrases; typosquat/Levenshtein brand matching;
  SimHash; profile-change detection.**

## 10. Testing

House style: `bun test`, `import { expect, test } from "bun:test"`, no describe/mocking,
`silentContext()` from `test/helpers/fakes.ts`.

- `test/lib/honeypot.test.ts` — `channelIsHoneypot` (unset, exact, thread-under, sibling);
  a pure `decideHoneypot({ action, isStaff, memberResolved, botOutranks, hasPerm })` if
  extracted.
- `test/lib/mod-action.test.ts` — the extracted gate (outranks, owner, missing permission,
  null member → false).
- `test/lib/heat.test.ts` — extend for the spray detector: image-only entries counted,
  distinct-channel counting, near-duplicate similarity, window independence.
- `test/lib/automod.test.ts` — hostname extraction from embeds/filenames; bare-domain
  matched only against a blocklist, not the allowlist.
- `test/db/scam-signature.test.ts` — insert/lookup/prune/evict/TTL; add the table to the
  manifest in `test/db/index.test.ts`.
- `bun run typecheck` clean.

## 11. Build order

1. **Tonight, no code:** turn on native SPAM + MENTION_SPAM in Server Settings; turn on
   `automod_links` with a real allowlist as a stopgap.
2. **Phase 1 — Honeypot** (+ the `applyModAction` extraction it depends on).
3. **Phase 2 — Automod gaps** (hostname extractor, bare-domain-vs-blocklist, spray detector,
   bug fixes).
4. **Phase 3 — Self-seeding** (`scam_signature` table, extraction on honeypot hit + manual
   seed, message-side check, mod-log "not a scam" button). Enable
   `antiscam_seed_from_honeypot` only after the honeypot has run clean for a week.
5. **Stop.** Run a month, then decide from real data whether any Non-goal earned its way in.

## 12. Files touched

| Action | Path |
|---|---|
| NEW | `src/lib/honeypot.ts`, `src/modules/honeypot/index.ts`, `test/lib/honeypot.test.ts` |
| NEW | `src/lib/mod-action.ts`, `test/lib/mod-action.test.ts` |
| NEW | `src/db/scam-signature.ts`, `test/db/scam-signature.test.ts` |
| EDIT | `src/lib/config.ts` (CONFIG_KEYS, CATEGORIES, REGISTRY) |
| EDIT | `src/lib/automod.ts` (hostname extraction, bare-domain-vs-blocklist) |
| EDIT | `src/lib/heat.ts` (spray detector: channelId + attachment fp + image-only) |
| EDIT | `src/modules/index.ts` (register honeypot before automod) |
| EDIT (load-bearing) | `src/modules/automod/index.ts` (honeypot early-return; embed branch; route ban through `applyModAction`) |
| EDIT | `src/modules/guards/index.ts` (route `enforce()` through `applyModAction`) |
| EDIT | `src/lib/scheduler.ts` (prune expired signatures) |
| EDIT | `schema.sql`, `test/db/index.test.ts` (scam_signature + manifest) |
| EDIT | `README.md`, `src/lib/config.ts` caps description (doc fixes) |

Verify with `bun test` and `bun run typecheck`.
