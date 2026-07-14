import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { BotModule, SlashCommand } from "../../core/module";
import { deleteTag, getTag, listTags, setTag } from "../../db/tags";

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
        .addStringOption((o) =>
          o.setName("content").setDescription("Tag content").setRequired(true),
        ),
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
      await interaction.reply({
        content: `Tag \`${name}\` deleted.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

export const tagsModule: BotModule = { name: "tags", commands: [tag] };
