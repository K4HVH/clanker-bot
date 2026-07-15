# clanker-bot

A self-hosted Discord bot for an ESP32 firmware community: moderation, verification, ticketing, and support helpers. Built as a config-driven modular monolith — everything is toggleable per-guild at runtime, nothing is hardcoded.

## Features

- **Moderation** — `/warn /note /timeout /kick /ban /unban /case /history`; reason-required, role-hierarchy-safe, 28-day timeout cap. Every action is a persisted, per-guild-numbered **case**.
- **Infraction ledger** — decay-aware weighted strike score shown in `/history` (configurable window).
- **Temp-bans** — `/ban … duration:7d` auto-expires via a durable scheduler (survives restarts).
- **Automod** — spam/mention-spam (heat-based) + invite/link filtering → delete + warn (staff exempt).
- **Auto-escalation** — opt-in ladder (timeout → kick → ban) driven by the strike score.
- **Audit logging** — message edits/deletes + member joins/leaves to a member-log; all mod actions to a mod-log.
- **Verification** — OCR-resistant image captcha entered by typing the code (DM on join, `/verify me` self-serve, or a `/verify panel` button) → grants a configured role. A bot-owned verify channel is auto-scrubbed; per-verify alt-detection flags (young account, implausibly fast solve, DM bounce). Mods can `/verify user` someone manually.
- **Join guards** — account-age gate: flag and/or auto-kick accounts newer than a configurable threshold.
- **Tickets** — `/ticket panel` → private channel per ticket → transcript saved on close.
- **Support helpers** — `/tag` canned answers for common questions.

All automod / escalation / verification features **default OFF** and are enabled via `/config`.

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

**Categories** (37 settings): General · Automod · Escalation · Strike Weights · Guards · Verification · Tickets — covering log channels, automod thresholds, the full escalation ladder, strike weights, the account-age gate, the verify channel + captcha tuning, and ticket setup.

The footer has **Export** (download your config as JSON), **Import** (upload a JSON to restore/migrate — validated against the registry), and **Reset** (revert everything to defaults, behind a confirm). Everything risky defaults OFF. The panel expires ~15 min after your last interaction — just re-run `/config`.

## Commands

Commands follow one pattern — `/<feature> <action>` (see `src/core/command.ts`):

`/config` (settings panel) · `/mod warn|note|timeout|kick|ban|unban|case|history` · `/verify me|panel|user` · `/ticket panel` · `/tag get|list|set|delete`

## Development

```bash
bun test              # unit tests (in-memory SQLite)
bun run typecheck     # tsc --noEmit
```

Layout: `src/core/` (framework), `src/db/` (connection + one query file per table), `src/lib/` (shared logic), `src/modules/` (features). The database schema is `schema.sql` at the repo root — edit it directly (tables use `CREATE TABLE IF NOT EXISTS`; in dev, delete the SQLite file to pick up changes).

## Roadmap

Done: moderation, automod, verification, tickets, tags. Next: self-assign role menus, then commerce (Stripe → license keys + gated firmware downloads). Each feature gets a deep-pass refinement of its behaviours and controls.
