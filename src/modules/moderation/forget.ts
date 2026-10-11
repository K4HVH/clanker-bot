import { type ChatInputCommandInteraction, EmbedBuilder, type Guild, MessageFlags } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule } from "../../core/module";
import { many } from "../../db/index";
import { forgetPosts, forgetRows } from "../../lib/forget";
import { logModAlert, userValue } from "../../lib/modlog";
import { closeTicketQuietly } from "../tickets/index";

type Closable = { id: string; delete(reason?: string): Promise<unknown> };

export interface ForgetDeps {
  modules: Pick<BotModule, "name" | "forget">[];
  posts: typeof forgetPosts;
  channel: (id: string) => Promise<Closable | null>;
  close: (channel: Closable) => Promise<void>;
  log: (ctx: AppContext, guild: Guild, embed: EmbedBuilder) => Promise<void>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The order matters. Their open tickets are noted before their rows go; rows and posts are deleted;
// the reply goes out (it may land in a ticket about to close); the mod log gets who ran it and what
// went, naming no one; and the tickets close last, without transcripts, so the request doesn't
// recreate what was just deleted.
export async function runForget(interaction: ChatInputCommandInteraction, ctx: AppContext, deps?: ForgetDeps): Promise<void> {
  const guild = interaction.guild!;
  const user = interaction.options.getUser("user", true);
  if (user.id === interaction.client.user.id) {
    await interaction.reply({ content: "The bot's own records aren't a member's data.", flags: MessageFlags.Ephemeral });
    return;
  }
  const d: ForgetDeps = deps ?? {
    modules: (await import("../index")).modules,
    posts: forgetPosts,
    channel: (id) => guild.channels.fetch(id).catch(() => null) as Promise<Closable | null>,
    close: closeTicketQuietly,
    log: logModAlert,
  };
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const open = many<{ channelId: string }>(
    ctx.db,
    "SELECT channel_id AS channelId FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = 'open' ORDER BY ticket_number",
    guild.id,
    user.id,
  ).map((t) => t.channelId);
  const here = open.includes(interaction.channelId);

  for (const m of d.modules) m.forget?.(ctx, guild.id, user.id);
  const rows = forgetRows(ctx.db, guild.id, user.id);
  const posts = await d.posts(ctx, guild, user.id);

  const summary = [
    plural(rows.cases, "case"),
    plural(rows.tickets, "ticket"),
    plural(rows.checks, "check result"),
    plural(rows.challenges, "captcha challenge"),
    plural(rows.scheduled, "scheduled action"),
    plural(posts.logPosts, "log post"),
    plural(posts.dms, "DM"),
  ].join(", ");
  const lines = [`Deleted: ${summary}.`];
  if (posts.failed > 0) lines.push(`Couldn't delete ${plural(posts.failed, "post")}.`);
  if (posts.unreachable.length > 0) lines.push(`Not reached: ${posts.unreachable.join(", ")}.`);
  if (open.length === 1) lines.push(here ? "This ticket closes now." : "Their open ticket closes now.");
  else if (open.length > 1) lines.push(`Their ${open.length} open tickets close now${here ? ", this one last" : ""}.`);
  // The token lasts 15 minutes; a long scan can outlive it. The log and the closing still happen.
  await interaction.editReply({ content: lines.join("\n") }).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("Deleted a member's data at their request.")
    .addFields({ name: "By", value: userValue(interaction.user.id, interaction.user.username) }, { name: "Deleted", value: summary });
  if (posts.failed > 0) embed.addFields({ name: "Couldn't delete", value: plural(posts.failed, "post") });
  if (posts.unreachable.length > 0) embed.addFields({ name: "Not reached", value: posts.unreachable.join(", ") });
  await d.log(ctx, guild, embed);

  for (const id of [...open.filter((c) => c !== interaction.channelId), ...(here ? [interaction.channelId] : [])]) {
    const channel = id === interaction.channelId && interaction.channel ? (interaction.channel as unknown as Closable) : await d.channel(id);
    if (channel) await d.close(channel);
  }
}
