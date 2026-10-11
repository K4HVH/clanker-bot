import { type ChatInputCommandInteraction, EmbedBuilder, type Guild, MessageFlags } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule } from "../../core/module";
import { getTicketByChannel } from "../../db/tickets";
import { forgetPosts, forgetRows } from "../../lib/forget";
import { logModAlert } from "../../lib/modlog";
import { closeTicketQuietly } from "../tickets/index";

export interface ForgetDeps {
  modules: Pick<BotModule, "name" | "forget">[];
  posts: typeof forgetPosts;
  close: (channel: { id: string; delete(reason?: string): Promise<unknown> }) => Promise<void>;
  log: (ctx: AppContext, guild: Guild, embed: EmbedBuilder) => Promise<void>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The order matters: rows and posts go first, then the reply (the ticket channel it lands in is
// about to go), then one mod-log line naming no one, and last the ticket channel itself, closed
// without a transcript so the request doesn't recreate what was just deleted.
export async function runForget(interaction: ChatInputCommandInteraction, ctx: AppContext, deps?: ForgetDeps): Promise<void> {
  const d = deps ?? {
    modules: (await import("../index")).modules,
    posts: forgetPosts,
    close: closeTicketQuietly,
    log: logModAlert,
  };
  const guild = interaction.guild!;
  const user = interaction.options.getUser("user", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const inTheirTicket = getTicketByChannel(ctx.db, interaction.channelId)?.openerId === user.id;

  for (const m of d.modules) m.forget?.(ctx, guild.id, user.id);
  const rows = forgetRows(ctx.db, guild.id, user.id, Date.now());
  const posts = await d.posts(ctx, guild, user.id);

  const lines = [
    `Deleted: ${[
      plural(rows.cases, "case"),
      plural(rows.tickets, "ticket"),
      plural(rows.checks, "check result"),
      plural(rows.challenges, "captcha challenge"),
      plural(rows.scheduled, "scheduled action"),
      plural(posts.logPosts, "log post"),
      plural(posts.dms, "DM"),
    ].join(", ")}.`,
  ];
  if (posts.unreachable.length > 0) lines.push(`Not reached: ${posts.unreachable.join(", ")}.`);
  if (inTheirTicket) lines.push("This ticket closes now.");
  await interaction.editReply({ content: lines.join("\n") });
  await d.log(ctx, guild, new EmbedBuilder().setColor(0x95a5a6).setTitle("Deleted a member's data at their request."));
  if (inTheirTicket && interaction.channel) await d.close(interaction.channel as never);
}
