import {
  ActionRowBuilder,
  type AttachmentBuilder,
  type EmbedBuilder,
  type Guild,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { AppContext } from "../../core/context";
import { CONFIG_KEYS } from "../../lib/config";

// Ticket pieces used by both the command/button wiring in index.ts and the intelligence
// check in check.ts. They live here so neither of those has to import the other.

export const SUBJECT_MAX = 300;

export async function isTicketStaff(
  guild: Guild,
  userId: string,
  ctx: AppContext,
): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const staffRoleId = ctx.config.get<string>(guild.id, CONFIG_KEYS.ticketStaffRoleId);
  return !!staffRoleId && member.roles.cache.has(staffRoleId);
}

export async function sendToModLog(
  ctx: AppContext,
  guild: Guild,
  payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] },
): Promise<void> {
  const id = ctx.config.get<string>(guild.id, CONFIG_KEYS.modLogChannelId);
  if (!id) return;
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (channel?.isTextBased()) await channel.send(payload).catch(() => {});
}

// The panel's "what do you need help with" prompt. Shown either straight off the Open
// Ticket button, or off the last answer of a passed check.
export function subjectModal(): ModalBuilder {
  const subject = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel("What do you need help with? (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(SUBJECT_MAX)
    .setRequired(false);
  return new ModalBuilder()
    .setCustomId("ticket_modal")
    .setTitle("Open a ticket")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(subject));
}
