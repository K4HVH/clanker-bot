import { Events, PermissionFlagsBits } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { createCase } from "../../db/cases";
import { getTicketByChannel } from "../../db/tickets";
import { getChallenge } from "../../db/verification";
import { type AutomodConfig, checkContentRules } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { HeatTracker } from "../../lib/heat";
import { logCase } from "../../lib/modlog";
import { inVerifyChannel } from "../../lib/verify-channel";
import { isCodeShaped } from "../../lib/verification-logic";

const heat = new HeatTracker();

const onMessage: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    if (!message.guild || message.author.bot || !message.content) return;

    const guildId = message.guild.id;
    const cfg: AutomodConfig = {
      spam: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodSpam),
      invites: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodInvites),
      links: ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.automodLinks),
      mentionLimit: ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodMentionLimit),
    };
    if (!cfg.spam && !cfg.invites && !cfg.links) return;

    // Exempt staff.
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

    // The verify channel (and threads under it) is owned by the verification flow, which
    // scrubs it; don't double-moderate it or count it toward flood heat.
    if (inVerifyChannel(ctx, message)) return;

    // Ticket channels are private support channels — never moderate them (a user pasting
    // a repro link or invite while asking for help shouldn't get warned/escalated).
    if (getTicketByChannel(ctx.db, message.channelId)) return;

    // Exempt an in-progress verification attempt elsewhere: a code the user types in a
    // channel must not count toward spam heat or trip the content filters (it's about to
    // be deleted by the verification flow anyway).
    const challenge = getChallenge(ctx.db, guildId, message.author.id);
    if (
      challenge &&
      challenge.expiresAt >= Date.now() &&
      isCodeShaped(message.content.trim().toUpperCase(), challenge.code.length)
    ) {
      return;
    }

    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    let violation = checkContentRules(message.content, mentionCount, cfg);
    if (!violation && cfg.spam) {
      const windowMs =
        ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodSpamWindowSeconds) * 1000;
      const maxMessages = ctx.config.getEffective<number>(
        guildId,
        CONFIG_KEYS.automodSpamMaxMessages,
      );
      if (heat.record(guildId, message.author.id, Date.now(), windowMs, maxMessages)) {
        violation = "spam (message flood)";
      }
    }
    if (!violation) return;

    await message.delete().catch(() => {});
    const record = createCase(ctx.db, {
      guildId: message.guild.id,
      userId: message.author.id,
      moderatorId: message.client.user.id,
      type: "warn",
      reason: `Automod: ${violation}`,
    });
    await logCase(ctx, message.guild, record);
  },
};

export const automodModule: BotModule = {
  name: "automod",
  listeners: [onMessage] as Listener[],
};
