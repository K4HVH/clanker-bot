import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
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
import {
  deleteChallenge,
  getChallenge,
  setChallenge,
} from "../../db/verification";
import { generateCode, renderCaptcha } from "../../lib/captcha";
import { CONFIG_KEYS } from "../../lib/config";

const CHALLENGE_TTL_MS = 10 * 60_000;

function enterRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_enter")
      .setLabel("Enter Code")
      .setStyle(ButtonStyle.Primary),
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
      new ButtonBuilder()
        .setCustomId("verify_start")
        .setLabel("Verify")
        .setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    if (!ctx.config.get<string>(member.guild.id, CONFIG_KEYS.verifiedRoleId)) return;
    const { embed, file } = await issueChallenge(ctx, member.guild.id, member.id);
    await member.user
      .send({ embeds: [embed], files: [file], components: [enterRow()] })
      .catch(() => {});
  },
};

const startHandler: ComponentHandler = {
  customId: "verify_start",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    const guildId = button.guildId ?? ctx.env.guildId;
    const { embed, file } = await issueChallenge(ctx, guildId, button.user.id);
    await button.reply({
      embeds: [embed],
      files: [file],
      components: [enterRow()],
      flags: MessageFlags.Ephemeral,
    });
  },
};

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

const modalHandler: ComponentHandler = {
  customId: "verify_modal",
  type: "modal",
  async handle(interaction, ctx) {
    const modal = interaction as ModalSubmitInteraction;
    const guildId = modal.guildId ?? ctx.env.guildId;
    const entered = modal.fields.getTextInputValue("code").trim().toUpperCase();
    const challenge = getChallenge(ctx.db, guildId, modal.user.id);

    const fail = (msg: string) => modal.reply({ content: msg, flags: MessageFlags.Ephemeral });

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
