import {
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  type User,
} from "discord.js";
import type { AppContext } from "../../core/context";
import { type CaseType, createCase } from "../../db/cases";
import { CONFIG_KEYS } from "../../lib/config";
import { checkActionable } from "../../lib/moderation";
import { logCase } from "../../lib/modlog";

export async function recordAndAnnounce(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
  input: { target: User; type: CaseType; reason: string; dmText?: string },
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const record = createCase(ctx.db, {
    guildId: guild.id,
    userId: input.target.id,
    moderatorId: interaction.user.id,
    type: input.type,
    reason: input.reason,
  });

  const dmOn = ctx.config.get<boolean>(guild.id, CONFIG_KEYS.dmOnAction) ?? false;
  if (dmOn && input.dmText) {
    await input.target.send(input.dmText).catch(() => {});
  }
  await logCase(ctx, guild, record);

  await interaction.reply({
    content: `✅ **${input.type}** applied to ${input.target.tag}.\nReason: ${input.reason}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function assertActionable(
  interaction: ChatInputCommandInteraction,
  targetUserId: string,
  opts: { requireMember: boolean },
): Promise<GuildMember | "not-member" | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  const actor = await guild.members.fetch(interaction.user.id);
  const botMember = await guild.members.fetchMe();
  let targetMember: GuildMember | undefined;
  try {
    targetMember = await guild.members.fetch(targetUserId);
  } catch {
    targetMember = undefined;
  }

  if (opts.requireMember && !targetMember) {
    await interaction.reply({
      content: "That user isn't in this server.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const check = checkActionable({
    actorId: interaction.user.id,
    targetId: targetUserId,
    botId: botMember.id,
    guildOwnerId: guild.ownerId,
    actorHighestRole: actor.roles.highest.position,
    targetHighestRole: targetMember?.roles.highest.position ?? -1,
    botHighestRole: botMember.roles.highest.position,
    targetIsMember: Boolean(targetMember),
  });
  if (!check.ok) {
    await interaction.reply({ content: `❌ ${check.reason}`, flags: MessageFlags.Ephemeral });
    return null;
  }
  return targetMember ?? "not-member";
}
