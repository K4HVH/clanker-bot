import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { BotModule } from "../../core/module";
import { deleteTag, getTag, listTags, setTag } from "../../db/tags";

const getSub: Subcommand = {
  description: "Post a tag.",
  options: (s) =>
    s.addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const name = interaction.options.getString("name", true).toLowerCase();
    const content = getTag(ctx.db, interaction.guildId, name);
    await interaction.reply(
      content
        ? { content }
        : { content: `No tag named \`${name}\`.`, flags: MessageFlags.Ephemeral },
    );
  },
};

const listSub: Subcommand = {
  description: "List tag names.",
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const names = listTags(ctx.db, interaction.guildId);
    await interaction.reply({
      content: names.length ? `Tags: ${names.map((n) => `\`${n}\``).join(", ")}` : "No tags yet.",
      flags: MessageFlags.Ephemeral,
    });
  },
};

const setSub: Subcommand = {
  description: "Create or update a tag.",
  permission: PermissionFlagsBits.ManageMessages,
  options: (s) =>
    s
      .addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true))
      .addStringOption((o) => o.setName("content").setDescription("Tag content").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const name = interaction.options.getString("name", true).toLowerCase();
    const content = interaction.options.getString("content", true);
    setTag(ctx.db, interaction.guildId, name, content);
    await interaction.reply({ content: `Tag \`${name}\` saved.`, flags: MessageFlags.Ephemeral });
  },
};

const deleteSub: Subcommand = {
  description: "Delete a tag.",
  permission: PermissionFlagsBits.ManageMessages,
  options: (s) =>
    s.addStringOption((o) => o.setName("name").setDescription("Tag name").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) return;
    const name = interaction.options.getString("name", true).toLowerCase();
    deleteTag(ctx.db, interaction.guildId, name);
    await interaction.reply({ content: `Tag \`${name}\` deleted.`, flags: MessageFlags.Ephemeral });
  },
};

export const tagsModule: BotModule = {
  name: "tags",
  commands: [
    featureCommand({
      name: "tag",
      description: "Canned answers for common questions.",
      subcommands: { get: getSub, list: listSub, set: setSub, delete: deleteSub },
    }),
  ],
};
