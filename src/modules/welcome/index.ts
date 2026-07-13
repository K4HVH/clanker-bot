import { Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../services/config.service";

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    const channelId = ctx.config.get<string>(member.guild.id, CONFIG_KEYS.welcomeChannelId);
    if (!channelId) return;
    const template =
      ctx.config.get<string>(member.guild.id, CONFIG_KEYS.welcomeMessage) ?? "Welcome {user}!";
    const channel =
      member.guild.channels.cache.get(channelId) ??
      (await member.guild.channels.fetch(channelId).catch(() => null));
    if (channel?.isTextBased()) {
      await channel
        .send({ content: template.replaceAll("{user}", `<@${member.id}>`) })
        .catch(() => {});
    }
  },
};

export const welcomeModule: BotModule = { name: "welcome", listeners: [onJoin] as Listener[] };
