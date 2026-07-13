import { Events, PermissionFlagsBits } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { createCase } from "../../repositories/cases.repository";
import { type AutomodConfig, checkContentRules } from "../../services/automod.service";
import { CONFIG_KEYS } from "../../services/config.service";
import { applyEscalation } from "../../services/escalation.service";
import { HeatTracker } from "../../services/heat.service";
import { logCase } from "../../services/modlog.service";

const heat = new HeatTracker();

const onMessage: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    if (!message.guild || message.author.bot || !message.content) return;

    const cfg: AutomodConfig = {
      spam: ctx.config.get<boolean>(message.guild.id, CONFIG_KEYS.automodSpam) ?? false,
      invites: ctx.config.get<boolean>(message.guild.id, CONFIG_KEYS.automodInvites) ?? false,
      links: ctx.config.get<boolean>(message.guild.id, CONFIG_KEYS.automodLinks) ?? false,
      mentionLimit: 5,
    };
    if (!cfg.spam && !cfg.invites && !cfg.links) return;

    // Exempt staff.
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    let violation = checkContentRules(message.content, mentionCount, cfg);
    if (!violation && cfg.spam && heat.record(message.guild.id, message.author.id, Date.now())) {
      violation = "spam (message flood)";
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
