import {
  ActionRowBuilder,
  type AnySelectMenuInteraction,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ContainerBuilder,
  InteractionContextType,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextDisplayBuilder,
} from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler, SlashCommand } from "../../core/module";
import { getSetting, REGISTRY, validateSetting } from "../../lib/config";
import { buildModal, buildPanel } from "./panel";

const V2 = MessageFlags.IsComponentsV2;
const DEFAULT_CATEGORY = "general";

type Interaction = MessageComponentInteraction | ModalSubmitInteraction;

async function requireManageGuild(interaction: Interaction): Promise<boolean> {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  await interaction
    .reply({ content: "You need the Manage Server permission.", flags: MessageFlags.Ephemeral })
    .catch(() => {});
  return false;
}

// ── /config command ─────────────────────────────────────────────────────────
const configCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Open the server configuration panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    await interaction.reply({
      flags: V2 | MessageFlags.Ephemeral,
      components: buildPanel(ctx, interaction.guildId, DEFAULT_CATEGORY),
    });
  },
};

// ── Export / Import handlers ─────────────────────────────────────────────────
async function handleExport(
  interaction: ButtonInteraction,
  ctx: AppContext,
  guildId: string,
): Promise<void> {
  const config: Record<string, unknown> = {};
  for (const s of REGISTRY) {
    const value = ctx.config.getEffective<unknown>(guildId, s.key);
    if (value !== undefined) config[s.key] = value;
  }
  const payload = { schemaVersion: 1, guildId, exportedAt: new Date().toISOString(), config };
  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), {
    name: `clanker-config-${guildId}.json`,
  });
  await interaction.reply({
    content:
      "Here's your config export.\n⚠️ Channel/role/category IDs are specific to **this** server and won't resolve if imported elsewhere.",
    files: [file],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleImport(
  interaction: ButtonInteraction,
  ctx: AppContext,
  guildId: string,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.reply({ content: "Can't import here.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content: "Upload your `.json` config in this channel within 60s (or type `cancel`).",
    flags: MessageFlags.Ephemeral,
  });

  const collector = channel.createMessageCollector({
    filter: (m) => m.author.id === interaction.user.id,
    max: 1,
    time: 60_000,
  });

  collector.on("collect", async (msg) => {
    if (msg.content.trim().toLowerCase() === "cancel") {
      await interaction.followUp({ content: "Import cancelled.", flags: MessageFlags.Ephemeral });
      return;
    }
    const attachment = msg.attachments.first();
    if (!attachment || !/\.json$/i.test(attachment.name)) {
      await interaction.followUp({
        content: "No `.json` file attached — nothing imported.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (attachment.size > 65_536) {
      await interaction.followUp({ content: "That file is too large.", flags: MessageFlags.Ephemeral });
      return;
    }
    let incoming: Record<string, unknown>;
    try {
      const text = await fetch(attachment.url).then((r) => r.text());
      const parsed = JSON.parse(text) as { config?: Record<string, unknown> } & Record<
        string,
        unknown
      >;
      incoming = parsed.config ?? parsed;
    } catch {
      await interaction.followUp({
        content: "Couldn't read that file as JSON.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let applied = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(incoming)) {
      const setting = getSetting(key);
      if (!setting || !validateSetting(setting, value)) {
        skipped++;
        continue;
      }
      ctx.config.set(guildId, key, value);
      applied++;
    }
    await msg.delete().catch(() => {});
    await interaction.followUp({
      content: `Import complete — **${applied}** applied, **${skipped}** skipped (unknown or invalid). Reopen \`/config\` to see the changes.`,
      flags: MessageFlags.Ephemeral,
    });
  });

  collector.on("end", (collected) => {
    if (collected.size === 0) {
      void interaction
        .followUp({ content: "Import timed out — nothing changed.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  });
}

// ── Button handler (toggle/edit/export/import/reset/close) ───────────────────
const buttonHandler: ComponentHandler = {
  customId: "cfg",
  type: "button",
  match: "prefix",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    if (!(await requireManageGuild(button))) return;
    const guildId = button.guildId ?? ctx.env.guildId;
    const [, verb, arg] = button.customId.split(":");

    if (verb === "toggle" && arg) {
      const setting = getSetting(arg);
      if (!setting) return;
      ctx.config.set(guildId, setting.key, !ctx.config.getEffective<boolean>(guildId, setting.key));
      await button.update({ flags: V2, components: buildPanel(ctx, guildId, setting.category) });
      return;
    }

    if (verb === "edit" && arg) {
      const setting = getSetting(arg);
      if (!setting) return;
      const current = ctx.config.getEffective<unknown>(guildId, setting.key);
      await button.showModal(buildModal(setting, current === undefined ? "" : String(current)));
      return;
    }

    if (verb === "export") {
      await handleExport(button, ctx, guildId);
      return;
    }

    if (verb === "import") {
      await handleImport(button, ctx, guildId);
      return;
    }

    if (verb === "reset" && arg) {
      const confirm = new ContainerBuilder()
        .setAccentColor(0xe74c3c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## ⚠️ Reset everything?\nThis reverts **every** setting to its default by clearing all saved config for this server. This cannot be undone.",
          ),
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`cfg:resetyes:${arg}`)
              .setStyle(ButtonStyle.Danger)
              .setLabel("Reset everything"),
            new ButtonBuilder()
              .setCustomId(`cfg:resetno:${arg}`)
              .setStyle(ButtonStyle.Secondary)
              .setLabel("Cancel"),
          ),
        );
      await button.update({ flags: V2, components: [confirm] });
      return;
    }

    if (verb === "resetyes" && arg) {
      const cleared = ctx.config.reset(guildId);
      ctx.logger.info("config reset", { guildId, cleared });
      await button.update({ flags: V2, components: buildPanel(ctx, guildId, arg) });
      return;
    }

    if (verb === "resetno" && arg) {
      await button.update({ flags: V2, components: buildPanel(ctx, guildId, arg) });
      return;
    }

    if (verb === "close") {
      await button.update({
        flags: V2,
        components: [
          new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent("Configuration panel closed."),
          ),
        ],
      });
    }
  },
};

// ── Select handler (category nav / channel / role / choice) ─────────────────
const selectHandler: ComponentHandler = {
  customId: "cfg",
  type: "select",
  match: "prefix",
  async handle(interaction, ctx) {
    const select = interaction as AnySelectMenuInteraction;
    if (!(await requireManageGuild(select))) return;
    const guildId = select.guildId ?? ctx.env.guildId;
    const [, verb, arg] = select.customId.split(":");

    if (verb === "cat") {
      const category = select.values[0] ?? DEFAULT_CATEGORY;
      await select.update({ flags: V2, components: buildPanel(ctx, guildId, category) });
      return;
    }

    // chan / role / choice: set the chosen value, or unset when the selection is cleared
    if (arg) {
      const setting = getSetting(arg);
      if (!setting) return;
      const chosen = select.values[0];
      if (chosen) {
        if (!validateSetting(setting, chosen)) return;
        ctx.config.set(guildId, setting.key, chosen);
      } else {
        ctx.config.unset(guildId, setting.key);
      }
      await select.update({ flags: V2, components: buildPanel(ctx, guildId, setting.category) });
    }
  },
};

// ── Modal handler (text/int edits) ──────────────────────────────────────────
const modalHandler: ComponentHandler = {
  customId: "cfg",
  type: "modal",
  match: "prefix",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    if (!(await requireManageGuild(modal))) return;
    const guildId = modal.guildId ?? ctx.env.guildId;
    const [, , key] = modal.customId.split(":");
    const setting = key ? getSetting(key) : undefined;
    if (!setting) return;

    const raw = modal.fields.getTextInputValue("val");
    let value: unknown = raw;
    if (setting.type === "int") {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!validateSetting(setting, parsed)) {
        await modal.reply({
          content: `Invalid value — must be a whole number between ${setting.min} and ${setting.max}.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      value = parsed;
    }
    ctx.config.set(guildId, setting.key, value);

    if (modal.isFromMessage()) {
      await modal.update({ flags: V2, components: buildPanel(ctx, guildId, setting.category) });
    } else {
      await modal.reply({ content: "Saved.", flags: MessageFlags.Ephemeral });
    }
  },
};

export const configModule: BotModule = {
  name: "config",
  commands: [configCommand],
  components: [buttonHandler, selectHandler, modalHandler],
};
