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

// Words, for the minimum-description rule. Anything with no letter or digit in it does
// not count, so "??? !!!" and a row of emoji are worth nothing towards the total.
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

// How many words this guild wants before it will open a ticket. 0 turns the rule off.
export function minSubjectWords(ctx: AppContext, guildId: string): number {
  return ctx.config.getEffective<number>(guildId, CONFIG_KEYS.ticketMinSubjectWords);
}

// Whether this description clears the bar, as a message for whoever wrote it. Their text
// comes back with it: making someone retype what they just wrote is the fastest way to
// lose them, and the point is to get a usable description, not to punish a short one.
export function subjectDenial(subject: string, minWords: number): string | null {
  if (minWords <= 0) return null;
  const words = countWords(subject);
  if (words >= minWords) return null;
  const quoted = subject.trim().replace(/^/gm, "> ");
  return (
    `Tickets need a description of at least **${minWords} words**, and that was ${words}. ` +
    "Say what happened, what you already tried, and what you expected instead." +
    (quoted ? `\n\nWhat you wrote, so you don't have to type it again:\n${quoted}` : "")
  );
}

// The panel's "what do you need help with" prompt. Shown either straight off the Open
// Ticket button, or off the last answer of a passed check.
//
// Those two need different responses, and the custom id is what tells them apart. A modal
// opened from ANY message component arrives with that component's message attached, so
// "did this come from a message?" cannot distinguish them: answering the panel button's
// modal with an update would edit the public panel message itself and wipe the panel for
// the whole server. The check's question message is ephemeral and IS the thing to edit.
export function subjectModal(fromCheck = false, minWords = 0): ModalBuilder {
  const subject = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel(minWords > 0 ? "What do you need help with?" : "What do you need help with? (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(SUBJECT_MAX)
    .setRequired(minWords > 0);
  if (minWords > 0) {
    // Discord enforces a length client-side, which stops "it broke" reaching us at all.
    // It cannot count words, so the real check still happens on submit; this is about
    // saying so before they hit submit rather than after.
    subject.setMinLength(Math.min(minWords * 3, SUBJECT_MAX));
    subject.setPlaceholder(
      "What happened, what you already tried, and what you expected instead. Full sentences.",
    );
  }
  return new ModalBuilder()
    .setCustomId(fromCheck ? "ticket_modal:check" : "ticket_modal")
    .setTitle("Open a ticket")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(subject));
}
