# clanker-bot Phase 5 — Ticket System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Private-channel support tickets: a panel button opens a modal (subject) → creates a private ticket channel visible to the opener + staff → a Close button saves a transcript and removes the channel.

**Architecture:** Reuses the component-routing kernel (buttons + modals). A `tickets` table tracks each ticket (per-guild sequential number, opener, channel, status, transcript). Config supplies the category to create channels under and the staff role. Breadth-first defaults; deep controls (claim, categories, SLAs) are a later pass.

**Tech Stack:** As before.

## Global Constraints

- All prior constraints (repository layer, `bun run lint:fix` before gate, gate = `bun test && bun run typecheck && bun run lint`, per-task commits).
- Config: `ticket_category_id` (category to create ticket channels in), `ticket_staff_role_id` (role that can see/handle tickets). If category unset, ticket channels are created at guild root.
- Transcript: on close, fetch up to 100 messages, store as text on the ticket row, and post it as a `.txt` attachment to the mod-log channel.

---

## File Structure

```
src/db/schema.ts                    # MODIFY: tickets table
drizzle/                            # GENERATED migration
src/services/config.service.ts      # MODIFY: ticketCategoryId, ticketStaffRoleId keys
src/modules/config/index.ts         # MODIFY: /config ticket-category, ticket-staff
src/repositories/tickets.repository.ts   # NEW: ticket CRUD + numbering
src/modules/tickets/index.ts        # NEW: panel + open/modal/close handlers
src/modules/index.ts                # MODIFY: register ticketsModule
test/repositories/tickets.repository.test.ts
```

---

## Task 1: tickets table, migration & config

**Files:** Modify `src/db/schema.ts`, `src/services/config.service.ts`, `src/modules/config/index.ts`; generate migration.

- [ ] **Step 1: Add the table** (append to `src/db/schema.ts`)

```typescript
export const tickets = sqliteTable(
  "tickets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guildId: text("guild_id").notNull(),
    ticketNumber: integer("ticket_number").notNull(),
    channelId: text("channel_id").notNull(),
    openerId: text("opener_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull(), // "open" | "closed"
    transcript: text("transcript"),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (t) => [uniqueIndex("tickets_channel_idx").on(t.channelId)],
);
```

- [ ] **Step 2: Generate migration** — `bun run db:generate` (`drizzle/0004_*.sql`); verify with `bun test test/db/client.test.ts`.

- [ ] **Step 3: Config keys** — in `CONFIG_KEYS`: `ticketCategoryId: "ticket_category_id",` and `ticketStaffRoleId: "ticket_staff_role_id",`.

- [ ] **Step 4: Config subcommands** — add to the `/config` builder:

```typescript
  .addSubcommand((s) =>
    s
      .setName("ticket-category")
      .setDescription("Category new ticket channels are created under.")
      .addChannelOption((o) =>
        o
          .setName("category")
          .setDescription("Category channel")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("ticket-staff")
      .setDescription("Role that can see and handle tickets.")
      .addRoleOption((o) => o.setName("role").setDescription("Staff role").setRequired(true)),
  )
```

Handler branches:

```typescript
    if (sub === "ticket-category") {
      const category = interaction.options.getChannel("category", true);
      ctx.config.set(guildId, CONFIG_KEYS.ticketCategoryId, category.id);
      await interaction.reply({ content: `Ticket category set.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === "ticket-staff") {
      const role = interaction.options.getRole("role", true);
      ctx.config.set(guildId, CONFIG_KEYS.ticketStaffRoleId, role.id);
      await interaction.reply({
        content: `Ticket staff role set to <@&${role.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
```

- [ ] **Step 5: Gate & commit**

```bash
git add src/db/schema.ts drizzle src/services/config.service.ts src/modules/config/index.ts
git commit -m "feat: add tickets table and ticket config options"
```

---

## Task 2: Tickets repository

**Files:** Create `src/repositories/tickets.repository.ts`; test.

**Interfaces:**
- `interface TicketRecord { id; guildId; ticketNumber; channelId; openerId; subject; status; transcript: string|null; createdAt; closedAt: number|null }`
- `createTicket(db, { guildId, channelId, openerId, subject }): TicketRecord` (per-guild sequential number)
- `getTicketByChannel(db, channelId): TicketRecord | undefined`
- `closeTicket(db, channelId, transcript, closedAt): void`

- [ ] **Step 1: Write it**

```typescript
// src/repositories/tickets.repository.ts
import { eq, sql } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { tickets } from "../db/schema";

export interface TicketRecord {
  id: number;
  guildId: string;
  ticketNumber: number;
  channelId: string;
  openerId: string;
  subject: string;
  status: string;
  transcript: string | null;
  createdAt: number;
  closedAt: number | null;
}

export function createTicket(
  db: BotDatabase,
  input: { guildId: string; channelId: string; openerId: string; subject: string },
): TicketRecord {
  return db.transaction((tx) => {
    const row = tx
      .select({ max: sql<number | null>`max(${tickets.ticketNumber})` })
      .from(tickets)
      .where(eq(tickets.guildId, input.guildId))
      .get();
    return tx
      .insert(tickets)
      .values({
        guildId: input.guildId,
        ticketNumber: (row?.max ?? 0) + 1,
        channelId: input.channelId,
        openerId: input.openerId,
        subject: input.subject,
        status: "open",
        transcript: null,
        createdAt: Date.now(),
        closedAt: null,
      })
      .returning()
      .get() as TicketRecord;
  });
}

export function getTicketByChannel(db: BotDatabase, channelId: string): TicketRecord | undefined {
  return db.select().from(tickets).where(eq(tickets.channelId, channelId)).get() as
    | TicketRecord
    | undefined;
}

export function closeTicket(
  db: BotDatabase,
  channelId: string,
  transcript: string,
  closedAt: number,
): void {
  db.update(tickets)
    .set({ status: "closed", transcript, closedAt })
    .where(eq(tickets.channelId, channelId))
    .run();
}
```

- [ ] **Step 2: Test**

```typescript
// test/repositories/tickets.repository.test.ts
import { expect, test } from "bun:test";
import {
  closeTicket,
  createTicket,
  getTicketByChannel,
} from "../../src/repositories/tickets.repository";
import { makeTestDb } from "../helpers/db";

test("ticket numbers increment per guild and close persists a transcript", () => {
  const db = makeTestDb();
  const a = createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "help" });
  const b = createTicket(db, { guildId: "g", channelId: "c2", openerId: "u", subject: "more" });
  expect(a.ticketNumber).toBe(1);
  expect(b.ticketNumber).toBe(2);
  expect(getTicketByChannel(db, "c1")?.status).toBe("open");
  closeTicket(db, "c1", "hello world", 999);
  const closed = getTicketByChannel(db, "c1");
  expect(closed?.status).toBe("closed");
  expect(closed?.transcript).toBe("hello world");
});
```

- [ ] **Step 3: Gate & commit**

```bash
git add src/repositories/tickets.repository.ts test/repositories/tickets.repository.test.ts
git commit -m "feat: add tickets repository"
```

---

## Task 3: Tickets module

**Files:** Create `src/modules/tickets/index.ts`; modify `src/modules/index.ts`.

- [ ] **Step 1: Write the module**

```typescript
// src/modules/tickets/index.ts
import {
  ActionRowBuilder,
  AttachmentBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { BotModule, ComponentHandler, SlashCommand } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";
import { logModAlert } from "../../services/modlog.service";
import {
  closeTicket,
  createTicket,
  getTicketByChannel,
} from "../../repositories/tickets.repository";

function closeRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Danger),
  );
}

const ticketPanel: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Post the ticket panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    if (!interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "Can't post here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Support")
      .setDescription("Need help? Click **Open Ticket** to talk to the team privately.");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket_open").setLabel("Open Ticket").setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};

const openHandler: ComponentHandler = {
  customId: "ticket_open",
  type: "button",
  async handle(interaction) {
    const modal = new ModalBuilder().setCustomId("ticket_modal").setTitle("Open a ticket");
    const subject = new TextInputBuilder()
      .setCustomId("subject")
      .setLabel("What do you need help with?")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(300)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(subject));
    await (interaction as ButtonInteraction).showModal(modal);
  },
};

const modalHandler: ComponentHandler = {
  customId: "ticket_modal",
  type: "modal",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    if (!modal.guild) return;
    await modal.deferReply({ flags: MessageFlags.Ephemeral });

    const subject = modal.fields.getTextInputValue("subject");
    const categoryId = ctx.config.get<string>(modal.guild.id, CONFIG_KEYS.ticketCategoryId);
    const staffRoleId = ctx.config.get<string>(modal.guild.id, CONFIG_KEYS.ticketStaffRoleId);

    const overwrites = [
      { id: modal.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: modal.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];
    if (staffRoleId) {
      overwrites.push({
        id: staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      });
    }

    const channel = await modal.guild.channels.create({
      name: `ticket-${modal.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: categoryId ?? undefined,
      permissionOverwrites: overwrites.map((o) => ({ ...o, type: OverwriteType.Role })),
    });

    const record = createTicket(ctx.db, {
      guildId: modal.guild.id,
      channelId: channel.id,
      openerId: modal.user.id,
      subject,
    });

    const embed = new EmbedBuilder()
      .setTitle(`Ticket #${record.ticketNumber}`)
      .setDescription(subject)
      .addFields({ name: "Opened by", value: `<@${modal.user.id}>` });
    await channel.send({
      content: staffRoleId ? `<@&${staffRoleId}>` : undefined,
      embeds: [embed],
      components: [closeRow()],
    });

    await modal.editReply({ content: `Ticket opened: <#${channel.id}>` });
  },
};

const closeHandler: ComponentHandler = {
  customId: "ticket_close",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    if (!button.guild || !button.channel) return;
    const ticket = getTicketByChannel(ctx.db, button.channelId);
    if (!ticket || ticket.status === "closed") {
      await button.reply({ content: "This isn't an open ticket.", flags: MessageFlags.Ephemeral });
      return;
    }
    await button.reply({ content: "Closing and saving transcript…", flags: MessageFlags.Ephemeral });

    // Build a transcript from the last 100 messages (oldest first).
    const fetched = await button.channel.messages.fetch({ limit: 100 }).catch(() => null);
    const lines = fetched
      ? [...fetched.values()]
          .reverse()
          .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`)
      : ["(transcript unavailable)"];
    const transcript = `Ticket #${ticket.ticketNumber} — ${ticket.subject}\n\n${lines.join("\n")}`;

    closeTicket(ctx.db, button.channelId, transcript, Date.now());

    const file = new AttachmentBuilder(Buffer.from(transcript, "utf8"), {
      name: `ticket-${ticket.ticketNumber}.txt`,
    });
    await logModAlert(
      ctx,
      button.guild,
      new EmbedBuilder()
        .setTitle(`Ticket #${ticket.ticketNumber} closed`)
        .addFields(
          { name: "Opened by", value: `<@${ticket.openerId}>` },
          { name: "Closed by", value: `<@${button.user.id}>` },
          { name: "Subject", value: ticket.subject },
        ),
    ).catch(() => {});
    // Attach the transcript file to the mod-log too (best-effort, separate message).
    const modLogId = ctx.config.get<string>(button.guild.id, CONFIG_KEYS.modLogChannelId);
    if (modLogId) {
      const modLog = await button.guild.channels.fetch(modLogId).catch(() => null);
      if (modLog?.isTextBased()) await modLog.send({ files: [file] }).catch(() => {});
    }

    await button.channel.delete().catch(() => {});
  },
};

export const ticketsModule: BotModule = {
  name: "tickets",
  commands: [ticketPanel],
  components: [openHandler, modalHandler, closeHandler],
};
```

- [ ] **Step 2: Register** — in `src/modules/index.ts`, import and append `ticketsModule`.

- [ ] **Step 3: Gate & commit**

```bash
git add src/modules/tickets/index.ts src/modules/index.ts
git commit -m "feat: add ticket system (panel, open modal, private channel, close+transcript)"
```

---

## Task 4: Integration, live smoke test & PR

- [ ] **Step 1: Full gate** — `bun run lint:fix && bun test && bun run typecheck && bun run lint`.
- [ ] **Step 2: Live smoke** — `timeout --preserve-status --signal=SIGTERM 12 bun src/index.ts` → 12 commands (adds `/ticket-panel`), connect, exit 0.
- [ ] **Step 3: Push, PR, verify CI, merge** (standard flow).

## Self-Review

**1. Coverage:** private-channel tickets (Task 3) ✓; open via button+modal w/ subject (Task 3) ✓; staff + opener perms, @everyone denied (Task 3) ✓; transcript to DB + mod-log on close (Task 2/3) ✓; per-guild ticket numbering (Task 2) ✓. Deferred to deep pass: claim button, ticket categories, inactivity auto-close.
**2. Placeholders:** none.
**3. Types:** `createTicket`/`getTicketByChannel`/`closeTicket` (Task 2) used in Task 3. `CONFIG_KEYS.ticketCategoryId`/`ticketStaffRoleId` (Task 1) used in Task 3. Component handlers (Task 3) routed by the Phase 4A kernel.

## Execution Handoff

Execute with executing-plans.
