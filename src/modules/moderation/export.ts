import { AttachmentBuilder, type ChatInputCommandInteraction, EmbedBuilder, type Guild, MessageFlags } from "discord.js";
import type { AppContext } from "../../core/context";
import { one } from "../../db/index";
import { memberPosts, memberRows } from "../../lib/export";
import { logModAlert, userValue } from "../../lib/modlog";

export interface ExportDeps {
  posts: typeof memberPosts;
  log: (ctx: AppContext, guild: Guild, embed: EmbedBuilder) => Promise<void>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Run in the member's open ticket, the copy is posted there for them; anywhere else, only whoever ran
// it sees it, so a copy never lands in a channel others read.
export async function runExport(interaction: ChatInputCommandInteraction, ctx: AppContext, deps?: ExportDeps): Promise<void> {
  const guild = interaction.guild!;
  const user = interaction.options.getUser("user", true);
  if (user.id === interaction.client.user.id) {
    await interaction.reply({ content: "That's the bot: there's no member data to copy.", flags: MessageFlags.Ephemeral });
    return;
  }
  const d: ExportDeps = deps ?? { posts: memberPosts, log: logModAlert };
  const theirTicket = !!one(
    ctx.db,
    "SELECT 1 AS x FROM tickets WHERE guild_id = ? AND opener_id = ? AND channel_id = ? AND status = 'open'",
    guild.id,
    user.id,
    interaction.channelId,
  );
  await interaction.deferReply(theirTicket ? undefined : { flags: MessageFlags.Ephemeral });

  const rows = memberRows(ctx.db, guild.id, user.id);
  const posts = await d.posts(ctx, guild, user.id);
  const copy = { user: user.id, server: guild.name, exported: new Date().toISOString(), ...rows, logPosts: posts.posts };
  const summary = [
    plural(rows.cases.length, "case"),
    plural(rows.tickets.length, "ticket"),
    plural(rows.ticketChecks.length, "check result"),
    plural(rows.captcha.length, "captcha challenge"),
    plural(rows.scheduled.length, "scheduled action"),
    plural(posts.posts.length, "log post"),
  ].join(", ");
  const lines = [theirTicket ? `A copy of everything the bot holds on you: ${summary}.` : `A copy of everything the bot holds on <@${user.id}>: ${summary}. Only you can see this; run it in their ticket to send it to them.`];
  if (posts.unreachable.length > 0) lines.push(`Not reached: ${posts.unreachable.join(", ")}.`);
  const file = new AttachmentBuilder(Buffer.from(JSON.stringify(copy, null, 2), "utf8"), { name: `data-${user.id}.json` });
  // The token lasts 15 minutes; a long scan can outlive it. The log still happens.
  await interaction.editReply({ content: lines.join("\n"), files: [file], allowedMentions: { parse: [] } }).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Sent a member a copy of their data at their request.")
    .addFields({ name: "By", value: userValue(interaction.user.id, interaction.user.username) }, { name: "Copied", value: summary });
  if (!theirTicket) embed.addFields({ name: "Sent to", value: "Only whoever ran it" });
  await d.log(ctx, guild, embed);
}
