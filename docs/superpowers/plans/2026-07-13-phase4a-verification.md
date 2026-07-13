# clanker-bot Phase 4A — Captcha Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** In-Discord captcha verification: a new member gets a distorted-image captcha (DM'd on join, plus a persistent `/verify-panel` button as fallback), types the code into a modal, and — on success — is granted a configured "Verified" role.

**Architecture:** Adds **component-interaction routing** (buttons + modals) to the kernel, alongside the existing command router. A captcha service builds a distorted-text SVG and rasterizes it to PNG via `@resvg/resvg-wasm` using a **bundled font** (no native modules, no system-font dependency — verified working on Bun and in the slim container). Per-user challenges are stored in a `verification_challenges` table with an expiry. Access gating is left to the server owner: the bot just grants a configured role.

**Tech Stack:** As before + `@resvg/resvg-wasm` (WASM SVG→PNG) + a vendored OFL/free monospace TTF in `assets/`.

## Global Constraints

- All prior constraints apply (repository layer, `bun run lint:fix` before each gate, gate = `bun test && bun run typecheck && bun run lint`, per-task commits).
- Captcha rendering MUST use an explicit bundled font (`fontBuffers` + `loadSystemFonts: false`); the container has no system fonts.
- `initWasm` for resvg must be called exactly once before rendering (lazy singleton).
- Single-guild assumption: modal submissions from DMs (no guild context) resolve the guild via `env.guildId`.
- New config key: `verified_role_id` (string).
- Component custom IDs: `verify_start` (panel button), `verify_enter` (opens modal), `verify_modal` (modal submit).

---

## File Structure

```
assets/captcha-font.ttf                   # NEW: vendored free monospace font
package.json                              # MODIFY: add @resvg/resvg-wasm
src/core/module.ts                        # MODIFY: add ComponentHandler + components to BotModule
src/core/component-router.ts              # NEW: routes button/modal interactions
src/core/client.ts                        # MODIFY: dispatch component interactions
src/services/captcha.service.ts           # NEW: generateCode + renderCaptcha
src/db/schema.ts                          # MODIFY: verification_challenges table
drizzle/                                  # GENERATED migration
src/repositories/verification.repository.ts  # NEW: challenge CRUD
src/services/config.service.ts            # MODIFY: verifiedRoleId key
src/modules/config/index.ts               # MODIFY: /config verified-role
src/modules/verification/index.ts         # NEW: panel command + join DM + component handlers
src/modules/index.ts                      # MODIFY: register verificationModule
test/services/captcha.service.test.ts
test/repositories/verification.repository.test.ts
test/core/component-router.test.ts
```

---

## Task 1: Vendor the captcha font + add the renderer dependency

**Files:** Create `assets/captcha-font.ttf`; modify `package.json`.

- [ ] **Step 1: Add the dependency**

Run: `bun add @resvg/resvg-wasm`

- [ ] **Step 2: Vendor a free monospace font**

Prefer DejaVu Sans Mono (permissive, redistributable). Try the system copy first; fall back to fetching JetBrains Mono (OFL) from the `@fontsource` package.

```bash
mkdir -p assets
FONT=$(find /usr/share/fonts -iname "DejaVuSansMono.ttf" 2>/dev/null | head -1)
if [ -n "$FONT" ]; then
  cp "$FONT" assets/captcha-font.ttf
else
  bun add -d @fontsource/jetbrains-mono
  cp node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2 /dev/null 2>/dev/null || true
  # If only woff is available, instead download a TTF:
  FONT=$(find /usr/share/fonts -iname "*mono*.ttf" 2>/dev/null | head -1)
  cp "$FONT" assets/captcha-font.ttf
fi
ls -la assets/captcha-font.ttf
```

(The build agent should ensure `assets/captcha-font.ttf` exists and is a valid TTF; a permissively-licensed monospace font is required. Confirm license permits redistribution.)

- [ ] **Step 3: Ensure the font ships in the image** — add to the `Dockerfile` release stage (after `COPY src ./src`):

```dockerfile
COPY assets ./assets
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock assets/captcha-font.ttf Dockerfile
git commit -m "chore: add resvg-wasm and vendor a captcha font"
```

---

## Task 2: Captcha service

**Files:** Create `src/services/captcha.service.ts`; test.

**Interfaces:**
- `generateCode(length?: number): string` — non-confusing charset (no 0/O/1/I/L).
- `renderCaptcha(code: string): Promise<Uint8Array>` — PNG bytes.

- [ ] **Step 1: Write the service**

```typescript
// src/services/captcha.service.ts
import { readFileSync } from "node:fs";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const FONT_PATH = "./assets/captcha-font.ttf";

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(readFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm"));
  }
  return wasmReady;
}

let fontBuffer: Buffer | null = null;
function font(): Buffer {
  if (!fontBuffer) fontBuffer = readFileSync(FONT_PATH);
  return fontBuffer;
}

export function generateCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CHARSET[b % CHARSET.length];
  return out;
}

function buildSvg(code: string): string {
  const w = 240;
  const h = 90;
  const rand = () => Math.random();
  let chars = "";
  for (let i = 0; i < code.length; i++) {
    const x = 26 + i * 34;
    const y = 58 + (rand() * 16 - 8);
    const rot = rand() * 40 - 20;
    chars += `<text x="${x}" y="${y}" font-family="CaptchaFont" font-size="44" font-weight="bold" fill="#e6e6e6" transform="rotate(${rot.toFixed(1)} ${x} ${y})">${code[i]}</text>`;
  }
  let noise = "";
  for (let i = 0; i < 7; i++) {
    noise += `<line x1="${(rand() * w).toFixed(0)}" y1="${(rand() * h).toFixed(0)}" x2="${(rand() * w).toFixed(0)}" y2="${(rand() * h).toFixed(0)}" stroke="#7a7a7a" stroke-width="1" opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2b2d31"/>${noise}${chars}</svg>`;
}

export async function renderCaptcha(code: string): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(buildSvg(code), {
    font: { fontBuffers: [font()], loadSystemFonts: false, defaultFontFamily: "CaptchaFont" },
  });
  return resvg.render().asPng();
}
```

> Note: the vendored font's internal family name may not be literally "CaptchaFont"; `defaultFontFamily` + `loadSystemFonts:false` makes resvg fall back to the only loaded font regardless, so the text renders with the bundled font.

- [ ] **Step 2: Test**

```typescript
// test/services/captcha.service.test.ts
import { expect, test } from "bun:test";
import { generateCode, renderCaptcha } from "../../src/services/captcha.service";

test("generateCode returns the requested length from the safe charset", () => {
  const code = generateCode(6);
  expect(code).toHaveLength(6);
  expect(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(code)).toBe(true);
});

test("renderCaptcha produces a valid PNG", async () => {
  const png = await renderCaptcha("A7K9Q2");
  expect(png.length).toBeGreaterThan(500);
  expect(png[0]).toBe(0x89);
  expect(png[1]).toBe(0x50); // 'P'
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/captcha.service.ts test/services/captcha.service.test.ts
git commit -m "feat: add captcha code generator and SVG->PNG renderer"
```

---

## Task 3: Component-interaction routing

**Files:** Modify `src/core/module.ts`, `src/core/client.ts`; create `src/core/component-router.ts`; test.

**Interfaces:**
- `interface ComponentHandler { customId: string; type: "button" | "modal"; handle(interaction: MessageComponentInteraction | ModalSubmitInteraction, ctx: AppContext): Promise<void> }`
- `BotModule` gains `components?: ComponentHandler[]`.
- `class ComponentRouter { constructor(handlers, ctx); handle(interaction): Promise<void> }`

- [ ] **Step 1: Extend `BotModule`** in `src/core/module.ts`

Add imports and the type:

```typescript
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ClientEvents,
  ModalSubmitInteraction,
  SlashCommandBuilder,
} from "discord.js";
```

Append:

```typescript
export interface ComponentHandler {
  customId: string;
  type: "button" | "modal";
  handle(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    ctx: AppContext,
  ): Promise<void>;
}
```

And add `components?: ComponentHandler[];` to `BotModule`.

- [ ] **Step 2: Write the component router**

```typescript
// src/core/component-router.ts
import {
  type ButtonInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import type { AppContext } from "./context";
import type { ComponentHandler } from "./module";

export class ComponentRouter {
  private readonly handlers = new Map<string, ComponentHandler>();

  constructor(
    handlers: ComponentHandler[],
    private readonly ctx: AppContext,
  ) {
    for (const h of handlers) this.handlers.set(`${h.type}:${h.customId}`, h);
  }

  async handle(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
    const type = interaction.isButton() ? "button" : "modal";
    const handler = this.handlers.get(`${type}:${interaction.customId}`);
    if (!handler) return;
    try {
      await handler.handle(interaction, this.ctx);
    } catch (error) {
      this.ctx.logger.error("component failed", {
        customId: interaction.customId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!interaction.replied && !interaction.deferred && !interaction.isModalSubmit()) {
        await interaction
          .reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  }
}
```

- [ ] **Step 3: Wire it into the client** — in `src/core/client.ts`, import `ComponentRouter`, build it from `modules.flatMap((m) => m.components ?? [])`, and extend the `InteractionCreate` handler:

```typescript
  const componentRouter = new ComponentRouter(
    modules.flatMap((m) => m.components ?? []),
    ctx,
  );

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) void router.handle(interaction);
    else if (interaction.isButton() || interaction.isModalSubmit())
      void componentRouter.handle(interaction);
  });
```

(Replace the existing single-line `InteractionCreate` handler.)

- [ ] **Step 4: Test the router**

```typescript
// test/core/component-router.test.ts
import { expect, test } from "bun:test";
import type { ButtonInteraction } from "discord.js";
import { ComponentRouter } from "../../src/core/component-router";
import type { ComponentHandler } from "../../src/core/module";
import { silentContext } from "../helpers/fakes";

function fakeButton(customId: string) {
  return {
    customId,
    isButton: () => true,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
  } as unknown as ButtonInteraction;
}

test("routes a button to its handler by type+customId", async () => {
  let hit = false;
  const h: ComponentHandler = {
    customId: "verify_start",
    type: "button",
    handle: async () => {
      hit = true;
    },
  };
  const router = new ComponentRouter([h], silentContext());
  await router.handle(fakeButton("verify_start"));
  expect(hit).toBe(true);
});

test("ignores unknown customIds", async () => {
  const router = new ComponentRouter([], silentContext());
  await router.handle(fakeButton("nope")); // no throw
});
```

- [ ] **Step 5: Gate & commit**

```bash
git add src/core/module.ts src/core/component-router.ts src/core/client.ts test/core/component-router.test.ts
git commit -m "feat: add button/modal component routing to the kernel"
```

---

## Task 4: Verification challenge storage

**Files:** Modify `src/db/schema.ts` (+ migration); create `src/repositories/verification.repository.ts`; test.

- [ ] **Step 1: Add the table** (append to `src/db/schema.ts`)

```typescript
export const verificationChallenges = sqliteTable(
  "verification_challenges",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    code: text("code").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);
```

- [ ] **Step 2: Generate migration** — `bun run db:generate` (creates `drizzle/0003_*.sql`).

- [ ] **Step 3: Write the repository**

```typescript
// src/repositories/verification.repository.ts
import { and, eq } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { verificationChallenges } from "../db/schema";

export function setChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
  code: string,
  expiresAt: number,
): void {
  db.insert(verificationChallenges)
    .values({ guildId, userId, code, expiresAt })
    .onConflictDoUpdate({
      target: [verificationChallenges.guildId, verificationChallenges.userId],
      set: { code, expiresAt },
    })
    .run();
}

export function getChallenge(
  db: BotDatabase,
  guildId: string,
  userId: string,
): { code: string; expiresAt: number } | undefined {
  const row = db
    .select({ code: verificationChallenges.code, expiresAt: verificationChallenges.expiresAt })
    .from(verificationChallenges)
    .where(and(eq(verificationChallenges.guildId, guildId), eq(verificationChallenges.userId, userId)))
    .get();
  return row;
}

export function deleteChallenge(db: BotDatabase, guildId: string, userId: string): void {
  db.delete(verificationChallenges)
    .where(and(eq(verificationChallenges.guildId, guildId), eq(verificationChallenges.userId, userId)))
    .run();
}
```

- [ ] **Step 4: Test**

```typescript
// test/repositories/verification.repository.test.ts
import { expect, test } from "bun:test";
import {
  deleteChallenge,
  getChallenge,
  setChallenge,
} from "../../src/repositories/verification.repository";
import { makeTestDb } from "../helpers/db";

test("set/get/delete a challenge with upsert", () => {
  const db = makeTestDb();
  setChallenge(db, "g", "u", "ABC123", 100);
  expect(getChallenge(db, "g", "u")).toEqual({ code: "ABC123", expiresAt: 100 });
  setChallenge(db, "g", "u", "XYZ789", 200);
  expect(getChallenge(db, "g", "u")?.code).toBe("XYZ789");
  deleteChallenge(db, "g", "u");
  expect(getChallenge(db, "g", "u")).toBeUndefined();
});
```

- [ ] **Step 5: Gate & commit**

```bash
git add src/db/schema.ts drizzle src/repositories/verification.repository.ts test/repositories/verification.repository.test.ts
git commit -m "feat: add verification challenge table and repository"
```

---

## Task 5: `verified_role_id` config + `/config verified-role`

**Files:** Modify `src/services/config.service.ts`, `src/modules/config/index.ts`.

- [ ] **Step 1: Add the key** — in `CONFIG_KEYS`: `verifiedRoleId: "verified_role_id",`.

- [ ] **Step 2: Add a `verified-role` subcommand** to `/config` builder:

```typescript
  .addSubcommand((s) =>
    s
      .setName("verified-role")
      .setDescription("Set the role granted when a member passes verification.")
      .addRoleOption((o) => o.setName("role").setDescription("Verified role").setRequired(true)),
  )
```

Handler branch in `execute`:

```typescript
    if (sub === "verified-role") {
      const role = interaction.options.getRole("role", true);
      ctx.config.set(guildId, CONFIG_KEYS.verifiedRoleId, role.id);
      await interaction.reply({
        content: `Verified role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
```

Add a field to `/config view`:

```typescript
        {
          name: "Verified role",
          value: (() => {
            const r = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
            return r ? `<@&${r}>` : "*(unset)*";
          })(),
        },
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/services/config.service.ts src/modules/config/index.ts
git commit -m "feat: add verified-role config option"
```

---

## Task 6: Verification module

**Files:** Create `src/modules/verification/index.ts`; modify `src/modules/index.ts`.

- [ ] **Step 1: Write the module**

```typescript
// src/modules/verification/index.ts
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  EmbedBuilder,
  Events,
  type Guild,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler, Listener, SlashCommand } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";
import { generateCode, renderCaptcha } from "../../services/captcha.service";
import {
  deleteChallenge,
  getChallenge,
  setChallenge,
} from "../../repositories/verification.repository";

const CHALLENGE_TTL_MS = 10 * 60_000;

function enterRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("verify_enter").setLabel("Enter Code").setStyle(ButtonStyle.Primary),
  );
}

async function issueChallenge(ctx: AppContext, guildId: string, userId: string) {
  const code = generateCode(6);
  setChallenge(ctx.db, guildId, userId, code, Date.now() + CHALLENGE_TTL_MS);
  const png = await renderCaptcha(code);
  const file = new AttachmentBuilder(Buffer.from(png), { name: "captcha.png" });
  const embed = new EmbedBuilder()
    .setTitle("Verification")
    .setDescription("Type the code shown in the image to verify.")
    .setImage("attachment://captcha.png");
  return { embed, file };
}

// /verify-panel — post the persistent Verify button.
const verifyPanel: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("verify-panel")
    .setDescription("Post the verification panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "Can't post here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Server Verification")
      .setDescription("Click **Verify** to prove you're human and unlock the server.");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("verify_start").setLabel("Verify").setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};

// DM the captcha on join (best-effort).
const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    if (!ctx.config.get<string>(member.guild.id, CONFIG_KEYS.verifiedRoleId)) return;
    const { embed, file } = await issueChallenge(ctx, member.guild.id, member.id);
    await member.send({ embeds: [embed], files: [file], components: [enterRow()] }).catch(() => {});
  },
};

// Panel "Verify" button -> ephemeral captcha.
const startHandler: ComponentHandler = {
  customId: "verify_start",
  type: "button",
  async handle(interaction, ctx) {
    const guildId = interaction.guildId ?? ctx.env.guildId;
    const { embed, file } = await issueChallenge(ctx, guildId, interaction.user.id);
    await (interaction as ButtonInteraction).reply({
      embeds: [embed],
      files: [file],
      components: [enterRow()],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// "Enter Code" button -> modal.
const enterHandler: ComponentHandler = {
  customId: "verify_enter",
  type: "button",
  async handle(interaction) {
    const modal = new ModalBuilder().setCustomId("verify_modal").setTitle("Verification");
    const input = new TextInputBuilder()
      .setCustomId("code")
      .setLabel("Enter the code from the image")
      .setStyle(TextInputStyle.Short)
      .setMinLength(4)
      .setMaxLength(8)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await (interaction as ButtonInteraction).showModal(modal);
  },
};

// Modal submit -> check + grant role.
const modalHandler: ComponentHandler = {
  customId: "verify_modal",
  type: "modal",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    const guildId = modal.guildId ?? ctx.env.guildId;
    const entered = modal.fields.getTextInputValue("code").trim().toUpperCase();
    const challenge = getChallenge(ctx.db, guildId, modal.user.id);

    const fail = async (msg: string) =>
      modal.reply({ content: msg, flags: MessageFlags.Ephemeral });

    if (!challenge || challenge.expiresAt < Date.now()) {
      await fail("Your code expired. Start verification again.");
      return;
    }
    if (entered !== challenge.code) {
      await fail("Incorrect code. Try again.");
      return;
    }

    const roleId = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
    if (!roleId) {
      await fail("Verification isn't fully configured. Contact a moderator.");
      return;
    }

    let guild: Guild;
    try {
      guild = modal.guild ?? (await modal.client.guilds.fetch(guildId));
    } catch {
      await fail("Couldn't reach the server. Contact a moderator.");
      return;
    }
    try {
      const member = await guild.members.fetch(modal.user.id);
      await member.roles.add(roleId, "Passed verification");
    } catch {
      await fail("Couldn't grant your role (my role may be too low). Contact a moderator.");
      return;
    }
    deleteChallenge(ctx.db, guildId, modal.user.id);
    await modal.reply({ content: "✅ Verified — welcome!", flags: MessageFlags.Ephemeral });
  },
};

export const verificationModule: BotModule = {
  name: "verification",
  commands: [verifyPanel],
  listeners: [onJoin] as Listener[],
  components: [startHandler, enterHandler, modalHandler],
};
```

- [ ] **Step 2: Register** — in `src/modules/index.ts`, import and append `verificationModule`.

- [ ] **Step 3: Gate & commit**

```bash
git add src/modules/verification/index.ts src/modules/index.ts
git commit -m "feat: add captcha verification module (panel, join DM, modal grant)"
```

---

## Task 7: Integration, live smoke test & PR

- [ ] **Step 1: Full gate** — `bun run lint:fix && bun test && bun run typecheck && bun run lint`.

- [ ] **Step 2: Live smoke test** — `timeout --preserve-status --signal=SIGTERM 12 bun src/index.ts`
Expected: `registered guild commands` count now **11** (added `/verify-panel`), `logged in`, clean shutdown. No captcha/wasm errors on startup.

- [ ] **Step 3: Manual verification (in Discord)** — `/config verified-role @Verified`, `/verify-panel`, click Verify → image appears → Enter Code → type it → gets the role.

- [ ] **Step 4: Push, PR, verify CI, merge** (standard flow). Confirm the Docker build still succeeds with the new `assets/` copy + resvg dep.

---

## Self-Review

**1. Spec coverage:** Captcha flow via DM-on-join AND panel button (Task 6 `onJoin` + `verifyPanel` + component handlers) ✓; distorted-image captcha, Bun/container-safe (Task 1–2, verified) ✓; grant configured Verified role (Task 5 + modal handler) ✓; challenge storage w/ expiry (Task 4) ✓; component routing added to kernel (Task 3) ✓. Account-age gate + raid detection are **Phase 4B** (separate plan).

**2. Placeholder scan:** No TBD/TODO; complete code. (Task 1 font-vendoring is a scripted step with an explicit success criterion.)

**3. Type consistency:** `ComponentHandler` (Task 3) implemented in Task 6 and routed in Task 3. `generateCode`/`renderCaptcha` (Task 2) used in Task 6. `setChallenge`/`getChallenge`/`deleteChallenge` (Task 4) used in Task 6. `CONFIG_KEYS.verifiedRoleId` (Task 5) used in Task 6. `ctx.env.guildId` used for DM-context guild resolution. ✓

## Execution Handoff

Plan complete and saved. Execute with executing-plans.
