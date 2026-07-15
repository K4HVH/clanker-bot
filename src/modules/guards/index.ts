import { EmbedBuilder, Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { logModAlert } from "../../lib/modlog";

const DAY_MS = 86_400_000;

// Account-age gate: flag and/or auto-kick accounts younger than the threshold.
const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    const guild = member.guild;
    const minDays = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.minAccountAgeDays);
    if (minDays <= 0) return;

    const ageMs = Date.now() - member.user.createdTimestamp;
    if (ageMs >= minDays * DAY_MS) return;

    const ageDays = Math.floor(ageMs / DAY_MS);
    if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.accountAgeGateFlag)) {
      await logModAlert(
        ctx,
        guild,
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle("New account flagged (age gate)")
          .addFields(
            { name: "User", value: `<@${member.id}> (${member.id})` },
            { name: "Account age", value: `${ageDays}d (min ${minDays}d)` },
          ),
      );
    }
    if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.accountAgeGateKick)) {
      await member.kick(`Account younger than ${minDays}d`).catch(() => {});
    }
  },
};

export const guardsModule: BotModule = {
  name: "guards",
  listeners: [onJoin] as Listener[],
};
