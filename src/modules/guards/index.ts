import { EmbedBuilder, Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { logModAlert } from "../../lib/modlog";
import { RaidDetector } from "../../lib/raid";

const raid = new RaidDetector();

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    const guild = member.guild;

    // Account-age gate: flag and/or auto-kick accounts younger than the threshold.
    const minDays = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.minAccountAgeDays);
    if (minDays > 0) {
      const ageMs = Date.now() - member.user.createdTimestamp;
      if (ageMs < minDays * 86_400_000) {
        const ageDays = Math.floor(ageMs / 86_400_000);
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
        return; // handled; skip raid tracking for this join
      }
    }

    // Raid detection: alert the mod-log on a join spike.
    if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.raidDetection)) {
      const windowMs = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.raidWindowMs);
      const threshold = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.raidJoinThreshold);
      const cooldownMs = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.raidAlertCooldownMs);
      if (raid.record(guild.id, Date.now(), windowMs, threshold, cooldownMs)) {
        await logModAlert(
          ctx,
          guild,
          new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle("⚠️ Possible raid detected")
            .setDescription("A burst of joins was detected. Consider locking down the server."),
        );
      }
    }
  },
};

export const guardsModule: BotModule = {
  name: "guards",
  listeners: [onJoin] as Listener[],
};
