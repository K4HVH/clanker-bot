import { Events, PermissionFlagsBits } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { createCase } from "../../db/cases";
import { type AutomodConfig, checkContentRules } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { applyEscalation } from "../../lib/escalation";
import { HeatTracker } from "../../lib/heat";
import { logCase } from "../../lib/modlog";

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

    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    let violation = checkContentRules(message.content, mentionCount, cfg);
    if (!violation && cfg.spam) {
      const windowMs = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodSpamWindowMs);
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
    await applyEscalation(ctx, message.guild, message.author.id);
  },
};

export const automodModule: BotModule = {
  name: "automod",
  listeners: [onMessage] as Listener[],
};
