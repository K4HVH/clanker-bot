# clanker-bot Phase 6 — FAQ/Tags & Welcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** (1) A `/tag` system of admin-managed canned responses for common firmware questions; (2) configurable welcome messages posted when a member joins.

**Architecture:** A `tags` table (guild + name → content) with a repository and a `/tag get|set|delete|list` command. A `welcome` module posts a configured template (with `{user}` substitution) on `guildMemberAdd`. No kernel changes.

**Tech Stack:** As before.

## Global Constraints

- All prior constraints (repository layer, `bun run lint:fix` before gate, gate = `bun test && bun run typecheck && bun run lint`, per-task commits).
- Welcome config: `welcome_channel_id`, `welcome_message` (supports `{user}` → mention). Default off (unset channel = no welcome).
- Tag set/delete require Manage Messages; get/list are open to everyone.

---

## File Structure

```
src/db/schema.ts                    # MODIFY: tags table
drizzle/                            # GENERATED migration
src/services/config.service.ts      # MODIFY: welcomeChannelId, welcomeMessage keys
src/modules/config/index.ts         # MODIFY: /config welcome-channel, welcome-message
src/repositories/tags.repository.ts # NEW
src/modules/tags/index.ts           # NEW: /tag command
src/modules/welcome/index.ts        # NEW: join welcome listener
src/modules/index.ts                # MODIFY: register both
test/repositories/tags.repository.test.ts
```

---

## Task 1: tags table, migration & welcome config

- [ ] **Step 1: Add the table** (append to `src/db/schema.ts`)

```typescript
export const tags = sqliteTable(
  "tags",
  {
    guildId: text("guild_id").notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.name] })],
);
```

- [ ] **Step 2: Generate migration** — `bun run db:generate`; verify with `bun test test/db/client.test.ts`.

- [ ] **Step 3: Config keys** — in `CONFIG_KEYS`: `welcomeChannelId: "welcome_channel_id",` and `welcomeMessage: "welcome_message",`.

- [ ] **Step 4: Config subcommands** — add to the `/config` builder:

```typescript
  .addSubcommand((s) =>
    s
      .setName("welcome-channel")
      .setDescription("Channel where welcome messages are posted.")
      .addChannelOption((o) =>
        o
          .setName("channel")
          .setDescription("Welcome channel")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("welcome-message")
      .setDescription("Welcome message template ({user} = mention).")
      .addStringOption((o) =>
        o.setName("text").setDescription("Template; use {user} for the mention").setRequired(true),
      ),
  )
```

Handlers:

```typescript
    if (sub === "welcome-channel") {
      const channel = interaction.options.getChannel("channel", true);
      ctx.config.set(guildId, CONFIG_KEYS.welcomeChannelId, channel.id);
      await interaction.reply({
        content: `Welcome channel set to <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "welcome-message") {
      const text = interaction.options.getString("text", true);
      ctx.config.set(guildId, CONFIG_KEYS.welcomeMessage, text);
      await interaction.reply({ content: "Welcome message updated.", flags: MessageFlags.Ephemeral });
      return;
    }
```

- [ ] **Step 5: Gate & commit**

```bash
git add src/db/schema.ts drizzle src/services/config.service.ts src/modules/config/index.ts
git commit -m "feat: add tags table and welcome config"
```

---

## Task 2: Tags repository

- [ ] **Step 1: Write it**

```typescript
// src/repositories/tags.repository.ts
import { and, asc, eq } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { tags } from "../db/schema";

export function setTag(db: BotDatabase, guildId: string, name: string, content: string): void {
  db.insert(tags)
    .values({ guildId, name, content, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [tags.guildId, tags.name],
      set: { content, updatedAt: Date.now() },
    })
    .run();
}

export function getTag(db: BotDatabase, guildId: string, name: string): string | undefined {
  return db
    .select({ content: tags.content })
    .from(tags)
    .where(and(eq(tags.guildId, guildId), eq(tags.name, name)))
    .get()?.content;
}

export function deleteTag(db: BotDatabase, guildId: string, name: string): void {
  db.delete(tags).where(and(eq(tags.guildId, guildId), eq(tags.name, name))).run();
}

export function listTags(db: BotDatabase, guildId: string): string[] {
  return db
    .select({ name: tags.name })
    .from(tags)
    .where(eq(tags.guildId, guildId))
    .orderBy(asc(tags.name))
    .all()
    .map((r) => r.name);
}
```

- [ ] **Step 2: Test**

```typescript
// test/repositories/tags.repository.test.ts
import { expect, test } from "bun:test";
import { deleteTag, getTag, listTags, setTag } from "../../src/repositories/tags.repository";
import { makeTestDb } from "../helpers/db";

test("set/get/list/delete with upsert", () => {
  const db = makeTestDb();
  setTag(db, "g", "flash", "Hold BOOT then tap RESET.");
  expect(getTag(db, "g", "flash")).toBe("Hold BOOT then tap RESET.");
  setTag(db, "g", "flash", "Updated.");
  expect(getTag(db, "g", "flash")).toBe("Updated.");
  setTag(db, "g", "wiring", "Check 3V3.");
  expect(listTags(db, "g")).toEqual(["flash", "wiring"]);
  deleteTag(db, "g", "flash");
  expect(getTag(db, "g", "flash")).toBeUndefined();
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/repositories/tags.repository.ts test/repositories/tags.repository.test.ts
git commit -m "feat: add tags repository"
```

---

## Task 3: Tags module

- [ ] **Step 1: Write it**

```typescript
// src/modules/tags/index.ts
import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";
import { deleteTag, getTag, listTags, setTag } from "../../repositories/tags.repository";

const tag: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("tag")
    .setDescription("Canned answers for common questions.")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("get")
        .setDescription("Post a tag.")
        .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("List tag names."))
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Create or update a tag (Manage Messages).")
        .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true))
        .addStringOption((o) => o.setName("content").setDescription("Tag content").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete a tag (Manage Messages).")
        .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true)),
    ),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === "get") {
      const name = interaction.options.getString("name", true).toLowerCase();
      const content = getTag(ctx.db, guildId, name);
      await interaction.reply(
        content
          ? { content }
          : { content: `No tag named \`${name}\`.`, flags: MessageFlags.Ephemeral },
      );
      return;
    }

    if (sub === "list") {
      const names = listTags(ctx.db, guildId);
      await interaction.reply({
        content: names.length ? `Tags: ${names.map((n) => `\`${n}\``).join(", ")}` : "No tags yet.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // set/delete require Manage Messages
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ content: "You can't manage tags.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "set") {
      const name = interaction.options.getString("name", true).toLowerCase();
      const content = interaction.options.getString("content", true);
      setTag(ctx.db, guildId, name, content);
      await interaction.reply({ content: `Tag \`${name}\` saved.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "delete") {
      const name = interaction.options.getString("name", true).toLowerCase();
      deleteTag(ctx.db, guildId, name);
      await interaction.reply({ content: `Tag \`${name}\` deleted.`, flags: MessageFlags.Ephemeral });
    }
  },
};

export const tagsModule: BotModule = { name: "tags", commands: [tag] };
```

- [ ] **Step 2: Register** in `src/modules/index.ts` (append `tagsModule`).

- [ ] **Step 3: Gate & commit**

```bash
git add src/modules/tags/index.ts src/modules/index.ts
git commit -m "feat: add /tag canned-response system"
```

---

## Task 4: Welcome module

- [ ] **Step 1: Write it**

```typescript
// src/modules/welcome/index.ts
import { Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    const channelId = ctx.config.get<string>(member.guild.id, CONFIG_KEYS.welcomeChannelId);
    if (!channelId) return;
    const template =
      ctx.config.get<string>(member.guild.id, CONFIG_KEYS.welcomeMessage) ??
      "Welcome {user}!";
    const channel =
      member.guild.channels.cache.get(channelId) ??
      (await member.guild.channels.fetch(channelId).catch(() => null));
    if (channel?.isTextBased()) {
      await channel
        .send({ content: template.replaceAll("{user}", `<@${member.id}>`) })
        .catch(() => {});
    }
  },
};

export const welcomeModule: BotModule = { name: "welcome", listeners: [onJoin] as Listener[] };
```

- [ ] **Step 2: Register** in `src/modules/index.ts` (append `welcomeModule`).

- [ ] **Step 3: Gate & commit**

```bash
git add src/modules/welcome/index.ts src/modules/index.ts
git commit -m "feat: add configurable welcome messages"
```

---

## Task 5: Integration, live smoke & PR

- [ ] **Step 1: Full gate.**
- [ ] **Step 2: Live smoke** — expect 13 commands (adds `/tag`), connect, exit 0.
- [ ] **Step 3: Push, PR, verify CI, merge.**

## Self-Review

**1. Coverage:** `/tag` get/set/delete/list w/ perm gate (Task 3) ✓; welcome message on join, config-gated (Task 4) ✓. Deep-pass TODO: tag-name autocomplete, welcome embeds/images.
**2. Placeholders:** none.
**3. Types:** tags repo (Task 2) used in Task 3; `CONFIG_KEYS.welcomeChannelId`/`welcomeMessage` (Task 1) used in Task 4.

## Execution Handoff

Execute with executing-plans.
