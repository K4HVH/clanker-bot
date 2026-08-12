# clanker-bot

A self-hosted Discord bot for an ESP32 firmware community: moderation, verification, ticketing, and support helpers. Built as a config-driven modular monolith: everything is toggleable per-guild at runtime, nothing is hardcoded.

## Features

- **Moderation**: `/mod warn|note|timeout|untimeout|kick|ban|unban|purge|history|clearhistory`; reason-required, role-hierarchy-safe, 28-day timeout cap. Every action is recorded in the user's **history** (`/mod history @user`). `/mod purge` bulk-deletes recent messages (by user / bots / links / attachments). `/mod ban` can wipe up to 7 days of the target's messages.
- **Temp-bans**: `/mod ban … duration:7d` auto-expires via a durable scheduler (survives restarts).
- **Automod**: a rule engine checked on new **and edited** messages (staff + verify-channel exempt; ticket channels exempt by default, toggleable): flood, duplicate spam, mention limit + `@everyone`/`@here`, invites (all hosts), links (with a domain allowlist), a word/phrase blocklist, and caps. Each hit deletes + records a **violation**; accumulated violations within a memory window **escalate**: timeout / kick / ban at configurable thresholds.
- **Audit logging**. To a member-log: message edits/deletes/bulk-deletes, joins/leaves, nickname & role changes, and (optionally) channel/role create/delete/edit. To a mod-log: bot actions plus **manual** bans/unbans/kicks/timeouts done outside the bot, attributed with *who + why* from the audit-log stream (deduped against the bot's own actions; kicks are distinguished from plain leaves). Per-group toggles in `/config` → Logging. Needs **View Audit Log** for attribution.
- **Verification**: OCR-resistant image captcha entered by typing the code (DM on join, `/verify me` self-serve, or a `/verify panel` button) → grants a configured role. A bot-owned verify channel is auto-scrubbed; per-verify alt-detection flags (young account, implausibly fast solve, DM bounce). Mods can `/verify user` someone manually.
- **Join guards**: assess every joiner and take one configured action (off/flag/kick/ban): account-age gate, a username/nickname **blocklist** (substring or `/regex/`, re-checked on nickname change), and a no-avatar flag. Optionally DMs a removed user why. Won't act above its own role, the owner, or without permission (downgrades to a flag).
- **Honeypot**: a trap channel (`/honeypot panel` posts the warning): anyone who posts there gets one configured action (off/flag/kick/ban), a configurable message wipe, and a mod-log ping. Aimed at compromised accounts that spray every channel, including the image-only posts automod skips. Fails closed on member resolution, exempts the owner/staff/configured roles, and collapses a burst into one action.
- **Scam defence (inside automod)**: for compromised accounts the join gates (already-verified members) don't cover. Automod runs two **confirmed-bad** rules that act at once (not on the accumulating ladder): a **known scam signature match** (domains + image SHA-256/`size:w:h` fingerprints, checked in content, embeds, filenames and bare-domain form) and a **cross-channel spray** detector (near-identical content across N channels, sees image-only posts). Each takes one configured action (off/flag/delete/timeout/kick/ban). The signature list **self-seeds** from confirmed honeypot hits (its only automated writer), and staff can add samples with `/mod scamseed` (a message link/ID, a domain, or an uploaded image) or the right-click **Seed scam signature** menu; entries carry a TTL and a one-click "not a scam" correction. Punishment magnitudes (timeout length, message wipe) come from the shared Moderation settings, so an auto-kick wipes recent messages just like an auto-ban.
- **Tickets**: `/ticket panel` → button opens a private channel per ticket, or `/ticket open` skips the button (staff can open one *for* a member, who then owns it); the subject is optional either way. Add/remove members, safe close (confirm + reason), per-user open limit, optional inactivity auto-close that `/ticket hold` exempts a single ticket from. Opens and closes are logged to the mod-log; on close a **.zip** (transcript + posted images) is saved there and DM'd to the opener, and `/ticket transcript <n>` fetches any past ticket's saved transcript.
- **Support helpers**: `/tag` canned answers for common questions.

All automod (including scam) / verification / guard / honeypot features **default OFF** and are enabled via `/config`.

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

Run **`/config`** (requires Manage Server) to open an interactive settings panel, a Components-V2 message you drive with dropdowns and buttons. Pick a category from the top dropdown, then flip toggles, choose channels/roles from native pickers, or edit numbers/text in a popup. Changes apply instantly, and every setting is defined once in a registry (`src/lib/config.ts`), so adding one is a single entry.

**Categories** (73 settings): Moderation · Logging · Automod · Automod Actions · Automod Scam · Automod Scam Seeding · Guards · Verification · Tickets · Memes · Honeypot: covering the shared punishment magnitudes (DM-on-action, one auto-timeout length, one auto-wipe window used by kicks and bans alike), log channels + per-group logging toggles, the automod content filters + flood/escalation ladder, the two confirmed-bad scam rules and the signature-seeding subsystem, the join guards (age gate + name blocklist + no-avatar, each with an off/flag/kick/ban action), the verify channel + captcha tuning, ticket setup, the @-mention meme commands, and the honeypot trap channel. Every setting shows an inline description in the panel.

The footer has **Export** (download your config as JSON), **Import** (upload a JSON to restore/migrate, validated against the registry), and **Reset** (revert everything to defaults, behind a confirm). Everything risky defaults OFF. The panel expires ~15 min after your last interaction, just re-run `/config`.

## Commands

Commands follow one pattern: `/<feature> <action>` (see `src/core/command.ts`):

`/config` (settings panel) · `/mod warn|note|timeout|untimeout|kick|ban|unban|purge|history|clearhistory|scamseed|scamforget` · `/verify me|panel|user` · `/ticket panel|open|close|hold|add|remove|transcript` · `/tag get|list|set|delete` · `/honeypot panel` · `/say` (+ right-click → **Reply as bot** / **Seed scam signature**)

## Development

```bash
bun test              # unit tests (in-memory SQLite)
bun run typecheck     # tsc --noEmit
```

Layout: `src/core/` (framework), `src/db/` (connection + one query file per table), `src/lib/` (shared logic), `src/modules/` (features). The database schema is `schema.sql` at the repo root, edit it directly (tables use `CREATE TABLE IF NOT EXISTS`; in dev, delete the SQLite file to pick up changes).

## Roadmap

Done: moderation, automod (incl. scam defence + seeding), verification, tickets, tags, memes, honeypot. Next: self-assign role menus, then commerce (Stripe → license keys + gated firmware downloads). Each feature gets a deep-pass refinement of its behaviours and controls.
