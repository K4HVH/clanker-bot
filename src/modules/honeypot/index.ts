import { EmbedBuilder, Events, type GuildMember, MessageFlags, PermissionFlagsBits } from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener } from "../../core/module";
import { type GuardAction, parseGuardAction } from "../../lib/actions";
import { Claims } from "../../lib/claim";
import { createCase } from "../../db/cases";
import { CONFIG_KEYS } from "../../lib/config";
import { emitHoneypotHit, type HoneypotAttachment } from "../../lib/honeypot-events";
import { inHoneypotChannel } from "../../lib/honeypot";
import { deleteSuppressed } from "../../lib/log-suppress";
import { applyModAction, autobanWipeSeconds } from "../../lib/mod-action";
import { logModAlert } from "../../lib/modlog";

const REASON = "Honeypot: posted in a trap channel";

// Collapse a burst into the trap into one action: claim the user before the first await, and the
// concurrent handlers for the other messages bail.
const claims = new Claims(30_000);

function actionOf(ctx: AppContext, guildId: string): GuardAction {
  return parseGuardAction(ctx.config.getEffective(guildId, CONFIG_KEYS.honeypotAction));
}

function exemptRoleIds(ctx: AppContext, guildId: string): string[] {
  const raw = ctx.config.getEffective<string>(guildId, CONFIG_KEYS.honeypotExemptRoles) ?? "";
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => /^\d{17,20}$/.test(s));
}

function dmText(guildName: string): string {
  return (
    `You were removed from **${guildName}** for posting in a channel that is a trap for ` +
    `compromised accounts. If this wasn't you, your account may be compromised. Change your ` +
    `password from a device you trust, then revoke access under **Settings → Authorized Apps**.`
  );
}

function alertEmbed(a: { userId: string; channelId: string; bait: string; effective: GuardAction }): EmbedBuilder {
  const actionLabel =
    a.effective === "ban" ? "Banned" : a.effective === "kick" ? "Kicked" : "Flagged (no removal)";
  return new EmbedBuilder()
    .setColor(a.effective === "flag" ? 0xe67e22 : 0x992d22)
    .setTitle("🍯 Honeypot trip")
    .addFields(
      { name: "User", value: `<@${a.userId}> (${a.userId})` },
      { name: "Channel", value: `<#${a.channelId}>` },
      { name: "Action", value: actionLabel },
      { name: "Posted", value: a.bait },
    )
    .setTimestamp(new Date());
}

const onCreate: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    const guild = message.guild;
    // Never fire on bots/webhooks: our own pinned warning, or another integration, would
    // otherwise self-trigger.
    if (!guild || message.author.bot) return;
    if (!inHoneypotChannel(ctx, message)) return;

    const configured = actionOf(ctx, guild.id);
    if (configured === "off") return;

    // Claim before resolving the member (which may await a fetch when the member isn't cached),
    // keyed on the author id we already have, so a concurrent burst can't race past this.
    if (!claims.claim(`${guild.id}:${message.author.id}`)) return;

    // Fail closed on member resolution: an instant ban must never fire against a moderator whose
    // member object simply didn't resolve. (Automod's `member?.permissions` fails open, fine for
    // a delete + warn, not for a ban.)
    const member: GuildMember | null =
      message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));
    if (!member) {
      ctx.logger.warn("honeypot: couldn't resolve member, taking no action", {
        guildId: guild.id,
        userId: message.author.id,
      });
      return;
    }

    // Exemptions: the owner, anyone with Manage Messages (staff testing the trap), or a configured
    // exempt role.
    if (member.id === guild.ownerId) return;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    const exemptRoles = exemptRoleIds(ctx, guild.id);
    if (exemptRoles.some((r) => member.roles.cache.has(r))) return;

    // Capture the bait before acting: a ban's server-side prune does not reliably emit per-message
    // delete events, so this is the only record of what they posted.
    const bait = (message.content || "*(no text, attachment or embed only)*").slice(0, 1024);
    const attachments: HoneypotAttachment[] = message.attachments.map((a) => ({
      url: a.url,
      size: a.size,
      width: a.width ?? null,
      height: a.height ?? null,
      name: a.name,
      contentType: a.contentType ?? null,
    }));

    let effective: GuardAction = configured;
    let didServerPrune = false;

    if (configured === "kick" || configured === "ban") {
      const wipeSeconds = configured === "ban" ? autobanWipeSeconds(ctx, guild.id) : 0;
      const dm = ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.honeypotDmUser)
        ? dmText(guild.name)
        : undefined;
      const acted = await applyModAction({
        guild,
        member,
        userId: member.id,
        type: configured,
        reason: REASON,
        dm,
        deleteMessageSeconds: configured === "ban" ? wipeSeconds : undefined,
      });
      if (acted) {
        if (configured === "ban" && wipeSeconds > 0) didServerPrune = true;
        // Record for /mod history. The action already happened, so a failed insert is logged, not
        // thrown. Only kick/ban write a case; a ban is terminal so ladder coupling is harmless.
        try {
          createCase(ctx.db, {
            guildId: guild.id,
            userId: member.id,
            moderatorId: message.client.user.id,
            type: configured,
            reason: REASON,
          });
        } catch (error) {
          ctx.logger.error("honeypot: acted but failed to record case", {
            guildId: guild.id,
            userId: member.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        effective = "flag"; // couldn't carry it out, report honestly
      }
    }

    // Remove the bait message when we didn't already prune it server-side (kick, or ban with 0h).
    // Flag = alert only, leave it. suppressDeletion keeps the member-log from echoing the scam.
    if ((effective === "kick" || effective === "ban") && !didServerPrune) {
      await deleteSuppressed(message.id, () => message.delete());
    }

    await logModAlert(
      ctx,
      guild,
      alertEmbed({ userId: member.id, channelId: message.channelId, bait, effective }),
      { pingRoleId: ctx.config.get<string>(guild.id, CONFIG_KEYS.honeypotAlertRoleId) },
    );

    // Hand the confirmed-bad evidence to the scam-signatures seeder (a no-op unless seeding is on).
    emitHoneypotHit({ guild, userId: member.id, content: message.content, attachments });
  },
};

const panelSub: Subcommand = {
  description: "Post the honeypot warning message in this channel.",
  permission: PermissionFlagsBits.ManageGuild,
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "Can't post here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setDescription(ctx.config.getEffective<string>(interaction.guildId, CONFIG_KEYS.honeypotPanelText));
    await interaction.channel.send({ embeds: [embed] });
    await interaction.reply({ content: "Honeypot warning posted.", flags: MessageFlags.Ephemeral });
  },
};

export const honeypotModule: BotModule = {
  name: "honeypot",
  commands: [
    featureCommand({
      name: "honeypot",
      description: "Honeypot trap-channel controls",
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      subcommands: { panel: panelSub },
    }),
  ],
  listeners: [onCreate] as Listener[],
};
