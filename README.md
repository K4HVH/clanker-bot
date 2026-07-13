# clanker-bot

A self-hosted Discord bot for an ESP32 firmware community: moderation, verification, ticketing, and support helpers. Built as a config-driven modular monolith — everything is toggleable per-guild at runtime, nothing is hardcoded.

## Features

- **Moderation** — `/warn /note /timeout /kick /ban /unban /case /history`; reason-required, role-hierarchy-safe, 28-day timeout cap. Every action is a persisted, per-guild-numbered **case**.
- **Infraction ledger** — decay-aware weighted strike score shown in `/history` (configurable window).
- **Temp-bans** — `/ban … duration:7d` auto-expires via a durable scheduler (survives restarts).
- **Automod** — spam/mention-spam (heat-based) + invite/link filtering → delete + warn (staff exempt).
- **Auto-escalation** — opt-in ladder (timeout → kick → ban) driven by the strike score.
- **Audit logging** — message edits/deletes + member joins/leaves to a member-log; all mod actions to a mod-log.
- **Verification** — distorted-image captcha (DM on join + `/verify-panel` fallback) → grants a configured role.
- **Join guards** — account-age gate (flag + auto-kick) and join-velocity raid detection (mod-log alert).
- **Tickets** — `/ticket-panel` → private channel per ticket → transcript saved on close.
- **Support helpers** — `/tag` canned answers + configurable welcome messages.

All automod / escalation / verification / raid features **default OFF** and are enabled via `/config`.

## Stack

TypeScript on **Bun** · **discord.js v14** · **Drizzle ORM** on `bun:sqlite` (repository layer) · Docker + Compose · GitHub Actions → GHCR. Captcha rendering via `@resvg/resvg-wasm` + a bundled font (no native modules).

## Quick start

```bash
bun install
cp .env.example .env      # fill in DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID
bun run start             # migrations run automatically on startup
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

## Configuration (`/config`, requires Manage Server)

| Subcommand | Purpose |
|---|---|
| `view` | Show all current settings |
| `log-channel <mod\|member> <#channel>` | Set the mod-log / member-log channels |
| `dm-on-action <bool>` | DM users when actioned |
| `toggle <feature> <bool>` | Enable/disable `automod-spam`, `automod-invites`, `automod-links`, `auto-escalation`, `raid-detection` |
| `min-account-age <days>` | Flag + kick accounts younger than N days (0 = off) |
| `verified-role <@role>` | Role granted on passing verification |
| `ticket-category <category>` / `ticket-staff <@role>` | Where ticket channels go + who staffs them |
| `welcome-channel <#channel>` / `welcome-message <text>` | Welcome on join (`{user}` = mention) |

## Commands

`/ping` · `/config` · `/warn` `/note` `/timeout` `/kick` `/ban` `/unban` `/case` `/history` · `/verify-panel` · `/ticket-panel` · `/tag`

## Development

```bash
bun test              # unit tests (in-memory SQLite)
bun run typecheck     # tsc --noEmit
bun run lint          # biome check  (lint:fix to auto-format)
bun run db:generate   # generate a Drizzle migration after editing src/db/schema.ts
```

Architecture, decision log, and per-phase implementation plans live in `docs/superpowers/`.

## Roadmap

Done: moderation, automod, verification, tickets, tags/welcome. Next: self-assign role menus, then commerce (Stripe → license keys + gated firmware downloads). Each feature gets a deep-pass refinement of its behaviours and controls.
