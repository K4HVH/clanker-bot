# clanker-bot — Design & Architecture

**Status:** Draft for review
**Date:** 2026-07-13
**Owner:** K4HVH
**Context:** Discord bot for a community server that hosts ESP32 firmware development + support, and intends to start selling hardware/firmware in the future.

---

## 1. Overview & goals

`clanker-bot` is a self-hosted, single-server Discord bot providing moderation, verification, ticketing, and support tooling, architected so that larger future capabilities (web dashboard, IP/fingerprint alt-detection, e-commerce) drop in cleanly rather than forcing a rewrite.

Guiding principles:

- **Config-driven, nothing hardcoded.** All operational settings live in the database, guild-scoped, editable at runtime.
- **Modular monolith.** Each feature is a self-contained module with clear boundaries; add or remove one without disturbing the others.
- **Reversible decisions.** The data layer and runtime are abstracted so we can move SQLite→Postgres or Bun→Node cheaply if we ever need to.
- **Ship incrementally.** One architecture, built in phases, each phase its own spec → plan → implementation cycle.
- **Honest scope.** We build the ToS-clean, in-Discord capabilities now; the legally/technically heavy pieces (IP correlation, commerce) are designed-for but deferred behind explicit triggers.

## 2. Decision log (what we chose and why)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Language | **TypeScript** | Owner has no strong language preference; TS gives the largest ecosystem (fastest to get unstuck as a solo maintainer) and shares one language/types across the bot and every future web-shaped component (dashboard, verification page, Stripe webhooks). |
| D2 | Runtime (dev) | **Bun** | Native TS execution (no build step), fast installs, great DX. Also the package manager and test runner. |
| D3 | Runtime (production) | **Bun** | Owner's explicit preference. The bot is text-only, so Bun's one true dealbreaker (broken voice) does not apply. The one live reliability bug (Bun #19176: network-drop can crash the WS handler) is absorbed by the container restart policy (`restart: unless-stopped`). Residual risk — discord.js officially targets Node ≥22.12 and does not support Bun — is accepted and made cheap to reverse by D5/D6. |
| D4 | Discord library | **discord.js v14** (pinned major) | De-facto standard, largest community/tutorial corpus, full support for slash commands, buttons, modals, selects. v15 is pre-release — not for production yet. |
| D5 | Framework | **Raw discord.js + a thin in-house module framework** | Maximum control, minimal dependencies, no external-framework Bun caveats (e.g. Sapphire's Bun hot-reload bug #21346 and Redis-backed scheduler). Our own lightweight module/loader/router gives the structure we need with clean, testable boundaries. Sapphire remains a fallback if we ever want more batteries. |
| D6 | Database | **SQLite** via **`bun:sqlite`** | Genuinely sufficient for a single guild; zero operational overhead; trivial backups (copy the file). WAL mode supports the future multi-process (dashboard/webhook) world on the same host. |
| D7 | ORM / query layer | **Drizzle ORM** (`drizzle-orm/bun-sqlite`) + **drizzle-kit** migrations | Type-safe schema-as-TypeScript with near-1:1 SQL mapping (easy to reason about), native Bun driver support, real versioned migrations. Not Prisma — on Bun, Prisma can't use the native driver and drags npm back into the toolchain. |
| D8 | DB access pattern | **Repository layer** over Drizzle | Business logic never touches Drizzle tables directly. Keeps a SQLite→Postgres move a swap-the-schema job, keeps a Bun→Node (`bun:sqlite`→`better-sqlite3`) swap an afternoon, and makes services unit-testable against an in-memory DB. |
| D9 | Moderation model | **Custom bot-owned automod**, native AutoMod optional backstop only | Owner finds native AutoMod blunt/unreliable and does not want to depend on it. We own the rules and escalation. Consequence: we read message text, so we need the MESSAGE_CONTENT privileged intent (a free portal toggle for a private single-server bot). |
| D10 | Verification posture | **In-Discord only, now** | No phone verification. No IP/fingerprint collection at this stage. Image-captcha + account-age + join-velocity heuristics. Built behind a strategy interface so an IP/fingerprint web layer can be added later without a rewrite. |
| D11 | Verification captcha | **Bot-generated distorted-image captcha → modal answer** | Owner's "glitchy characters so bots/people can't copy-paste" idea. An *image* (not text) defeats copy-paste and naive OCR. Honest limit: a determined human or good OCR passes it — it's a bot/low-effort-troll filter, not alt-detection. |
| D12 | Alt-detection (aggressive) | **Deferred behind a trigger** | Catching determined individual ban-evaders is only possible via a self-hosted IP+fingerprint web page; it is defeatable (VPN/new browser — and this audience is technical), false-positive-prone (never auto-ban), and makes us a GDPR data controller. Not worth it until evaders are a proven, recurring problem. |
| D13 | Bot scope | **Single guild, but fully config-driven** | Runs for the owner's server only (sidesteps Discord's 10k-user intent review, annual reapproval, and sharding). But nothing is hardcoded — config is guild-scoped in the DB — so this is not a dead end. |
| D14 | Tickets structure | **Private channel per ticket** | Owner preference. Classic model; granular per-ticket permissions. We accept the channel-list/category-limit tradeoff (fine at this server's scale). |
| D15 | Scheduler | **DB-backed poller** (`scheduled_actions` table) | Handles temp-ban/mute expiry and future scheduled work without adding Redis/BullMQ. Keeps the stack lean. |
| D16 | Hosting | **Homelab, self-hosted** | Owner's own hardware. In-Discord-only means outbound-only (no inbound ports) until web features arrive. Cloudflare Tunnel is the planned no-port-forward answer when we add the verification page / Stripe webhooks. |
| D17 | Compliance posture | **Data minimization; no personal data beyond Discord IDs + mod data** | Owner is not pursuing IP/fingerprint at this stage. If D12's trigger ever fires, the GDPR machinery (privacy policy, consent, retention cap, deletion) is built *then*, as part of that module. |
| D18 | Packaging / deployment | **Docker image + Docker Compose**, DB on a mounted volume | Owner needs a real deploy path. A container is the reproducible unit; Compose runs it on the homelab with `restart: unless-stopped` (which also absorbs D3's crash bug). The SQLite file lives on a **bind-mounted volume** so data survives redeploys (and stays on the local host, which WAL requires). |
| D19 | CI/CD | **GitHub Actions → GHCR**, deploy by `docker compose pull` | On PR: typecheck + lint + `bun test`. On merge to `main`: build and push a versioned image to GitHub Container Registry. Homelab deploys by pulling the new image. Simple, free, and gives a genuine test gate before anything ships. |

## 3. Non-goals / explicitly deferred (with triggers)

These are **designed-for but not built now**. Each has a concrete trigger:

- **Web management dashboard** — *Trigger:* in-Discord admin becomes limiting, or a non-technical staffer needs access. *Shape:* separate process, same DB (via the repository layer or a small internal API), Discord OAuth2 login, server-side role authorization.
- **Aggressive alt-detection (IP/fingerprint)** — *Trigger:* determined individual ban-evaders become a real, recurring problem. *Shape:* a new verification *strategy* + self-hosted web page + full GDPR machinery.
- **Commerce (selling firmware/hardware)** — *Trigger:* owner is ready to sell. *Shape:* Stripe Checkout/Payment Links (Discord user ID in `client_reference_id`) → signature-verified, idempotent webhook process → grant role + issue license + unlock gated firmware download; physical fulfilment via Stripe shipping; refund/chargeback → revoke. Own Stripe, **not** Discord native monetization.
- **Voice features** — out of scope (and Bun's voice support is broken anyway).
- **Multi-guild / public bot** — out of scope; the config model keeps it possible later.
- **Role menus, GitHub/release feeds, scheduled announcements** — considered and cut for now (YAGNI). Cheap to add later on the module system if wanted.

## 4. Architecture

### 4.1 Runtime & process model

- Single **Bun** process running the bot (one `Client`, single shard — sharding is not required below 2,500 guilds).
- Runs as a **Docker container** under Docker Compose with `restart: unless-stopped` (absorbs transient WS crashes and reconnects). See §4.10.
- Secrets (bot token, application/client IDs) in a gitignored `.env` (passed to the container via `env_file`); everything else in the DB.
- Migrations run automatically on startup before the gateway connects.
- Graceful shutdown: stop accepting work, flush, close the DB, disconnect the gateway.

### 4.2 Data layer

- **Driver:** `bun:sqlite` (native, synchronous, zero-install).
- **ORM:** Drizzle (`drizzle-orm/bun-sqlite`); schema-as-TypeScript is the single source of truth.
- **Migrations:** drizzle-kit `generate` (versioned SQL) + runtime `migrate()` on startup.
- **Startup pragmas** (set on the connection):
  ```
  PRAGMA journal_mode = WAL;      -- concurrent readers + 1 writer
  PRAGMA busy_timeout = 5000;     -- wait, don't throw, on contention
  PRAGMA synchronous = NORMAL;    -- safe + fast under WAL
  PRAGMA foreign_keys = ON;       -- enforce FKs
  ```
- **Repository layer (D8):** each module exposes a repository (`infractions.addCase()`, `config.get()`, `tickets.close()`…). No business logic imports Drizzle tables directly.
- **Transaction hygiene:** keep write transactions tiny; never hold a write transaction open across an `await` on Discord/network I/O (avoids `SQLITE_BUSY`).
- **Backups:** nightly SQLite `.backup`/file copy to a separate location.

### 4.3 Config service

- **Storage:** guild-scoped rows (`guild_config`), typed accessors over a JSON/value column, with an in-memory cache and explicit invalidation on write.
- **Access:** admin-only `/config` commands (`get` / `set` / `list` / `unset`), permission-gated.
- **Role in the system:** the single source of truth for channel IDs, role IDs, feature toggles, thresholds, templates. This is exactly what a future dashboard edits — so the dashboard is "just another writer," not a new data model.

### 4.4 Module system

- A **module** is a self-contained unit: `{ name, commands[], listeners[], services, repository, schema slice }`.
- A **loader** discovers and registers modules at startup; a **router** dispatches interactions (slash commands, buttons, modals, selects) to the owning module.
- Cross-module use goes through **services**, never by reaching into another module's internals — preserving the "understand/change in isolation" property.
- Discord-specific glue (interaction parsing, embed building) is kept thin at the edge; the testable logic lives in services that take plain arguments.

### 4.5 Scheduler

- A single poller scans a `scheduled_actions` table (e.g. every few seconds) for due jobs and dispatches them to the owning module (unban, unmute, ticket auto-close, etc.).
- Jobs are persisted, so restarts don't lose pending expirations.

### 4.6 Logging (two senses)

1. **Application logging:** structured, leveled logs to stdout (captured by systemd/journald). Lean logger; JSON in production.
2. **Discord audit logging (a feature module):** structured embeds to configured channels — message edits/deletes, joins/leaves, and every moderation action (actor, target, reason, case ID, timestamp). Content of edits/deletes requires MESSAGE_CONTENT.

### 4.7 Intents & permissions

- **Intents:** `Guilds`, `GuildMembers` (privileged), `GuildModeration`, `GuildMessages`, `MessageContent` (privileged), `GuildMessageReactions` (if needed). **Never** `GuildPresences`.
- Both privileged intents are free portal toggles for a private single-server bot (Discord's review only applies to public bots at 10k+ users).
- **Authorization:** every mod/admin command checks the invoker's Discord permissions/roles server-side, plus role-hierarchy checks on targets (can't action someone equal/higher, the bot, or self).

### 4.8 Error handling

- Central interaction error boundary: user-facing failures reply with a clean ephemeral message; internal errors are logged with context and never leak stack traces to users.
- All external calls (Discord REST) treat rate limits and transient failures as expected; respect `retry_after`.
- Idempotency where it matters (scheduler jobs, future webhooks).

### 4.9 Ops / deployment

- **Host:** homelab, running the container via Docker Compose (see §4.10).
- **Outbound-only** until web features arrive; then **Cloudflare Tunnel** for inbound (no port-forwarding).
- **Secrets:** gitignored `.env` (never baked into the image), rotatable token.
- **Command registration:** per-guild registration for instant iteration during development (guild commands update immediately vs ~1h for global).

### 4.10 Containerization & CI/CD

- **Image:** multi-stage Dockerfile on the official `oven/bun` base. `bun install --frozen-lockfile` (deps stage) → copy source (no build step; Bun runs TS directly) → production deps only in the final stage. A `.dockerignore` excludes `.git`, `node_modules`, `.env`, `data/`, `docs/`.
- **Compose:** one service (`bot`) with `restart: unless-stopped`, `env_file: .env`, and a **bind-mounted volume** for the SQLite file (e.g. `./data:/app/data`) so data survives redeploys and stays on-host (WAL requirement). Migrations run on container startup, before the gateway connects.
- **`bun:sqlite` in-container note:** it's built into Bun (no native compile / node-gyp), so it works on both the Debian-slim and Alpine `oven/bun` variants without extra system packages. Default to the Debian-slim variant for fewest surprises.
- **CI (GitHub Actions):**
  - *On PR / push:* `bun install` → typecheck → lint → `bun test` (in-memory SQLite). This is the merge gate.
  - *On merge to `main` (or tag):* build the image and push to **GHCR** (`ghcr.io/<owner>/clanker-bot`), tagged with the commit SHA and `latest`/semver.
- **Deploy:** homelab pulls the new image — `docker compose pull && docker compose up -d` (optionally automated with a watcher later). Rollback = pin the previous image tag.

## 5. Feature modules

Each module below is a build target for a later phase. Listed with purpose / interface / data / dependencies.

### 5.1 Moderation
- **Purpose:** manual moderator actions + (later) a custom automod engine.
- **Manual commands:** `/warn`, `/timeout` (duration-parsed, ≤28d native cap), `/kick`, `/ban` (+ optional message-delete window), `/unban`, `/note`, `/case <id>`, `/history <user>`.
- **Automod engine (Phase 3):** spam/flood "heat", mention-spam caps, link/invite filters, keyword filters, new-account + join-velocity anti-raid — all rules configurable via the config service; actions escalate slowmode → warn → timeout → kick → ban.
- **Data:** `cases` (per-guild case numbering), automod rule config.
- **Depends on:** config, logging, scheduler (temp actions), infraction ledger.

### 5.2 Infraction ledger (Phase 2)
- **Purpose:** turn discrete cases into a weighted, decaying strike score with auto-escalation.
- **Behaviour:** each case carries points (e.g. slur/scam 2–3, minor 1); points decay over a configurable window (e.g. 60–90 days); crossing thresholds triggers configured escalations; temp-ban/temp-mute expiry via the scheduler.
- **Depends on:** moderation, scheduler, config.

### 5.3 Logging (Phase 1)
- **Purpose:** the Discord audit-log module (see §4.6).
- **Data:** log-channel config; no message archive beyond what's needed for edit/delete display.

### 5.4 Verification (Phase 4)
- **Purpose:** gate new members against bots and low-effort trolls, in-Discord.
- **Flow:** join → restricted state → image captcha (distorted code) → modal answer → verified role. Plus account-age gate and join-velocity raid heuristics.
- **Extensibility:** a `VerificationStrategy` interface (captcha strategy now; IP/fingerprint web strategy is a future drop-in per D12).
- **Bun note:** render the captcha as SVG → PNG via a **WASM** rasterizer (e.g. resvg-wasm) to avoid native-module (N-API) risk on Bun.
- **Depends on:** config, logging.

### 5.5 Tickets (Phase 5)
- **Purpose:** private support tickets for firmware/hardware help.
- **Flow:** panel/button + modal (category/subject) → create **private channel** with scoped perms → staff claim → close → transcript persisted to DB → archive/delete.
- **Data:** `tickets`, `ticket_messages` (transcript). Optional HTML export later.
- **Depends on:** config, logging, scheduler (inactivity auto-close, optional).

### 5.6 FAQ/tags + welcome (Phase 6)
- **Purpose:** canned answers to common firmware questions + new-member welcome.
- **`/tag`:** admin-managed create/edit/delete/list, name autocomplete, post by name.
- **Welcome:** configurable template + channel on `guildMemberAdd`.
- **Depends on:** config.

## 6. Future-proofing seams (recap)

The architecture makes each deferred item a drop-in rather than a rewrite:
- **Config-in-DB** → dashboard is "just another writer."
- **Repository layer** → Postgres and/or Node are cheap swaps.
- **Module system** → new features are additive.
- **VerificationStrategy interface** → IP/fingerprint layer is a plugin.
- **Separate processes for web/webhooks** → the gateway connection is never at the mercy of a web redeploy/crash.

## 7. Roadmap (phased decomposition)

Each phase gets its own spec → plan → implementation cycle.

1. **Phase 1 — Foundation + Logging + Manual Moderation** *(first spec; detailed in §8)*
2. **Phase 2 — Infraction ledger + temp-actions + scheduler**
3. **Phase 3 — Custom automod + anti-raid**
4. **Phase 4 — Verification (in-Discord captcha)**
5. **Phase 5 — Tickets (private channels)**
6. **Phase 6 — FAQ/tags + welcome**
- **Later / trigger-gated:** web dashboard · IP/fingerprint verification · commerce

## 8. Phase 1 — detailed spec (Foundation + Logging + Manual Moderation)

**Goal:** a deployable, genuinely useful moderation bot: the kernel everything else builds on, plus audit logging and reason-required manual moderation.

### 8.1 In scope
- **Kernel:** Bun + discord.js client bootstrap; env/secret loading; module loader; interaction router; central error boundary; structured application logger; graceful shutdown.
- **Data layer:** Drizzle + `bun:sqlite` with pragmas; drizzle-kit migrations applied on startup; repository layer; in-memory (`:memory:`) DB support for tests.
- **Config service:** `guild_config` storage + typed accessor + cache; `/config get|set|list|unset` (admin-gated). Initial keys: `mod_log_channel_id`, `member_log_channel_id`, `mod_role_ids`, `dm_on_action` (bool).
- **Logging module:** listeners for `messageDelete`, `messageUpdate`, `guildMemberAdd`, `guildMemberRemove` → embeds to configured channels; a `modLog()` service used by moderation.
- **Moderation (manual subset):** `/warn`, `/timeout`, `/kick`, `/ban`, `/unban`, `/note`, `/case <id>`, `/history <user>`. Each: permission + role-hierarchy checks, required reason, optional DM to target, persist a `cases` row (per-guild sequential case number), post to mod-log.
- **Command registration:** per-guild registration script + on-startup sync.
- **Containerization:** multi-stage Dockerfile (`oven/bun` base), `docker-compose.yml` (`restart: unless-stopped`, `env_file`, bind-mounted `./data` volume for the SQLite file), `.dockerignore`, and a `.env.example`.
- **CI/CD:** GitHub Actions workflow — PR gate (typecheck + lint + `bun test`) and a `main`/tag job that builds and pushes the image to GHCR.

### 8.2 Data model (Phase 1)
- `guild_config(guild_id, key, value_json, updated_at)` — PK (guild_id, key).
- `cases(id, guild_id, case_number, user_id, moderator_id, type, reason, meta_json, created_at)` — `type ∈ {warn, timeout, kick, ban, unban, note}`; `case_number` is per-guild sequential.
- `scheduled_actions` table is introduced in Phase 2 (kept out of Phase 1 to stay minimal; timeouts in Phase 1 use Discord's native ≤28d expiry, no scheduler needed).

### 8.3 Behaviours & rules
- **Duration parsing** for `/timeout` (e.g. `10m`, `2h`, `7d`), capped at Discord's 28-day native limit; reject longer with a clear message.
- **Hierarchy safety:** refuse to action self, the bot, users with an equal/higher top role, or (for ban/kick) the guild owner.
- **Reason required** on all actions; stored and shown in mod-log and DM.
- **DM best-effort:** notify the target of the action + reason if `dm_on_action` is set; swallow failures (closed DMs) gracefully.
- **Idempotent-ish:** `/unban` on a non-banned user, `/case` on a missing ID, etc. return clean errors, not crashes.

### 8.4 Acceptance criteria
- Bot boots on Bun, runs migrations, registers guild commands, connects, and appears online.
- Each mod command performs the Discord action, persists a correctly-numbered case, DMs (when enabled), and logs an embed to the configured mod-log channel.
- Permission and hierarchy checks reject unauthorized/invalid targets with clear ephemeral errors.
- `/config` round-trips values and they take effect without a restart.
- Edit/delete/join/leave events produce correct log embeds in the configured channels.
- The bot builds into a Docker image and runs via `docker compose up`, with the SQLite file persisted on the mounted volume across `docker compose down/up`.
- The container restart policy brings the bot back after a crash.
- CI runs typecheck + lint + `bun test` on PRs and pushes an image to GHCR on merge to `main`.

### 8.5 Testing strategy
- **Runner:** `bun test`.
- **Unit:** services + repositories against an in-memory SQLite with migrations applied — case numbering, duration parser, hierarchy checks, config get/set/cache invalidation. Services take plain args (no live Discord) so they're testable in isolation.
- **Manual smoke test:** a private test guild; run each command path and verify Discord side-effects + log embeds.

### 8.6 Out of scope for Phase 1 (deferred to later phases)
- Weighted strike ledger, decay, auto-escalation (Phase 2).
- Temp-ban/temp-mute beyond native timeout, and the scheduler (Phase 2).
- Any automod/anti-raid (Phase 3).
- Verification, tickets, FAQ (Phases 4–6).

## 9. Cross-cutting testing & quality
- Keep Discord-specific code thin; put logic in services with plain inputs → high unit-test coverage without mocking the whole gateway.
- Type-check in CI (`tsc --noEmit` or `bun` typecheck) + `bun test`.
- Lint/format (Biome or ESLint+Prettier — pick one in Phase 1).

## 10. Open questions / to decide later
- Application logger: lean custom vs `pino` (decide in Phase 1 implementation).
- Lint/format tool: Biome vs ESLint+Prettier (decide in Phase 1).
- Ticket transcript format: DB-only vs HTML export (decide in Phase 5).
- Captcha rasterizer library specifics (decide in Phase 4).
- Commerce specifics — entity/location, one-time vs subscription, node-locked vs resellable keys, merchant-of-record vs self-filed tax (revisit when commerce is triggered).
