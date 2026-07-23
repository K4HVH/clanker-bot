# clanker-bot

A self-hosted Discord bot for an ESP32 firmware community: moderation, verification, ticketing, and support helpers. Built as a config-driven modular monolith — everything is toggleable per-guild at runtime, nothing is hardcoded.

## Features

- **Moderation** — `/mod warn|note|timeout|untimeout|kick|ban|unban|purge|history|clearhistory`; reason-required, role-hierarchy-safe, 28-day timeout cap. Every action is recorded in the user's **history** (`/mod history @user`). `/mod purge` bulk-deletes recent messages (by user / bots / links / attachments). `/mod ban` can wipe up to 7 days of the target's messages.
- **Temp-bans** — `/mod ban … duration:7d` auto-expires via a durable scheduler (survives restarts).
- **Automod** — a rule engine checked on new **and edited** messages (staff + verify-channel exempt; ticket channels exempt by default, toggleable): flood, duplicate spam, mention limit + `@everyone`/`@here`, invites (all hosts), links (with a domain allowlist), a word/phrase blocklist, and caps. Each hit deletes + records a **violation**; accumulated violations within a memory window **escalate** — timeout / kick / ban at configurable thresholds.
- **Audit logging** — to a member-log: message edits/deletes/bulk-deletes, joins/leaves, nickname & role changes, and (optionally) channel/role create/delete/edit. To a mod-log: bot actions plus **manual** bans/unbans/kicks/timeouts done outside the bot, attributed with *who + why* from the audit-log stream (deduped against the bot's own actions; kicks are distinguished from plain leaves). Per-group toggles in `/config` → Logging. Needs **View Audit Log** for attribution.
- **Verification** — OCR-resistant image captcha entered by typing the code (DM on join, `/verify me` self-serve, or a `/verify panel` button) → grants a configured role. A bot-owned verify channel is auto-scrubbed; per-verify alt-detection flags (young account, implausibly fast solve, DM bounce). Mods can `/verify user` someone manually.
- **Join guards** — assess every joiner and take one configured action (off/flag/kick/ban): account-age gate, a username/nickname **blocklist** (substring or `/regex/`, re-checked on nickname change), and a no-avatar flag. Optionally DMs a removed user why. Won't act above its own role, the owner, or without permission (downgrades to a flag).
- **Honeypot** — a bait channel no real member should post in (put it near the top of your list and post the warning with `/honeypot panel`). Anyone who posts there trips one configured action (off/flag/kick/ban) with a configurable message wipe and an owner ping — catches hijacked/compromised accounts that spray every channel, including image-only posts automod can't see. Fails *closed* on member resolution, exempts the owner/staff/configured roles, and collapses a burst into a single action.
- **Anti-scam** — defence against compromised accounts posting scams that the join gates (already-verified members) can't touch. A **cross-channel spray detector** (own window, sees image-only posts, near-duplicate text via Levenshtein) times out/kicks/bans and can purge the sprayed messages across every channel. A **known-bad signature blocklist** (scam domains + image SHA-256/`size:w:h` fingerprints) is checked on every message — including bare domains (vs the blocklist only, so `readme.md` stays safe) and embed/attachment names. The blocklist **self-seeds** from confirmed honeypot hits (the only automated writer) and a manual `/antiscam seed`, so the *next* account posting the same scam anywhere is caught instantly; entries carry a TTL and a one-click "not a scam" correction.
- **Tickets** — `/ticket panel` → button opens a private channel per ticket; add/remove members, safe close (confirm + reason), per-user open limit, optional inactivity auto-close. Opens and closes are logged to the mod-log; on close a **.zip** (transcript + posted images) is saved there and DM'd to the opener, and `/ticket transcript <n>` fetches any past ticket's saved transcript.
- **Support helpers** — `/tag` canned answers for common questions.

All automod / verification / guard / honeypot / anti-scam features **default OFF** and are enabled via `/config`.

## Stack

TypeScript on **Bun** · **discord.js v14** · raw **`bun:sqlite`** (single `schema.sql`, no ORM) · Docker + Compose · GitHub Actions → GHCR. Captcha rendering via `@resvg/resvg-wasm` + a bundled font (no native modules).

## Quick start

```bash
bun install
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID
bun run start             # schema is applied automatically on startup
```

Dev with hot reload: `bun run dev`.

## Deploy (Docker / Podman)

The image publishes to `ghcr.io/k4hvh/clanker-bot:latest` on every push to `master`.

```bash
# Build + run locally from the repo:
docker compose up -d --build      # or: podman compose up -d --build

# Or pull the published image (needs a GHCR login if the package is private):
docker compose pull && docker compose up -d
```

The SQLite database lives on the `./data` bind-mount and persists across redeploys. `restart: unless-stopped` keeps the bot up.

## Configuration

Run **`/config`** (requires Manage Server) to open an interactive settings panel — a Components-V2 message you drive with dropdowns and buttons. Pick a category from the top dropdown, then flip toggles, choose channels/roles from native pickers, or edit numbers/text in a popup. Changes apply instantly, and every setting is defined once in a registry (`src/lib/config.ts`), so adding one is a single entry.

**Categories** (79 settings): Moderation · Logging · Automod · Automod Actions · Guards · Verification · Tickets · Memes · Honeypot · Anti-Scam (Spray / Filters / Seeding) — covering the DM-on-action toggle, log channels + per-group logging toggles, the automod content filters + flood/escalation ladder, the join guards (age gate + name blocklist + no-avatar, each with an off/flag/kick/ban action), the verify channel + captcha tuning, ticket setup (staff role, category, open limit, inactivity window, DM/zip/confirm/staff-only-close toggles), the @-mention meme commands, the honeypot trap channel, and the anti-scam spray detector + known-bad signature blocklist. Every setting shows an inline description in the panel.

The footer has **Export** (download your config as JSON), **Import** (upload a JSON to restore/migrate — validated against the registry), and **Reset** (revert everything to defaults, behind a confirm). Everything risky defaults OFF. The panel expires ~15 min after your last interaction — just re-run `/config`.

## Commands

Commands follow one pattern — `/<feature> <action>` (see `src/core/command.ts`):

`/config` (settings panel) · `/mod warn|note|timeout|untimeout|kick|ban|unban|purge|history|clearhistory` · `/verify me|panel|user` · `/ticket panel|close|add|remove|transcript` · `/tag get|list|set|delete` · `/honeypot panel` · `/antiscam seed|forget` · `/say` (+ right-click → **Reply as bot**)

## Development

```bash
bun test              # unit tests (in-memory SQLite)
bun run typecheck     # tsc --noEmit
```

Layout: `src/core/` (framework), `src/db/` (connection + one query file per table), `src/lib/` (shared logic), `src/modules/` (features). The database schema is `schema.sql` at the repo root — edit it directly (tables use `CREATE TABLE IF NOT EXISTS`; in dev, delete the SQLite file to pick up changes).

## Roadmap

Done: moderation, automod, verification, tickets, tags, memes, honeypot, anti-scam. Next: self-assign role menus, then commerce (Stripe → license keys + gated firmware downloads). Each feature gets a deep-pass refinement of its behaviours and controls.
