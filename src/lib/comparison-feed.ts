import { escapeMarkdown } from "discord.js";
import type { AppContext } from "../core/context";
import { one, run } from "../db/index";
import { CONFIG_KEYS } from "./config";
import { type Embed, field } from "./embeds";

// The comparison summary: the site's comparison of stock and Medius in brief, kept in a channel. Each read
// posts it if it isn't there and edits it in place when the site's results change.

interface Count {
  medius: number;
  stock: number;
  same: number;
}

export interface Summary {
  firmware: { stock: string; medius: string };
  url: string;
  total: Count;
  areas: (Count & { title: string; url: string })[];
  defects: { stock: number; medius: number; url: string };
}

const SILENT = 4096; // Discord's suppress-notifications flag
const HIDDEN = 4; // Discord's suppress-embeds flag, set by "Remove embeds"
const UNKNOWN_MESSAGE = 10008;

const plain = (s: string) => escapeMarkdown(s).replace(/[[\]]/g, "\\$&");
const str = (x: unknown): x is string => typeof x === "string";
const num = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isCount = (c: Count | undefined) => num(c?.medius) && num(c?.stock) && num(c?.same);

// The summary, or null if any of it can't be read: one missing an area would state less than the site.
function readSummary(body: unknown): Summary | null {
  const b = body as Summary | null;
  if (!b || !str(b.firmware?.stock) || !str(b.firmware?.medius) || !str(b.url) || !isCount(b.total)) return null;
  if (!Array.isArray(b.areas) || b.areas.length === 0 || !b.areas.every((a) => str(a?.title) && str(a?.url) && isCount(a))) return null;
  if (!num(b.defects?.stock) || !num(b.defects?.medius) || !str(b.defects?.url)) return null;
  return b;
}

// One embed: the totals, each box's defects, and a field per area, each linking the site.
export function render(s: Summary): Embed {
  const defects = (box: string, n: number) => (n === 0 ? `${box} has none` : `${box} has [${n} defect${n === 1 ? "" : "s"}](${s.defects.url})`);
  const description = [`${defects("Stock", s.defects.stock)}. ${defects("Medius", s.defects.medius)}.`, "", `**[Read the full comparison](${s.url})**`].join("\n");
  const fields = [
    field("Medius ahead", String(s.total.medius), true),
    field("Stock ahead", String(s.total.stock), true),
    field("Equal", String(s.total.same), true),
    ...s.areas.map((a) => field(plain(a.title), `Medius ${a.medius}, stock ${a.stock}, equal ${a.same}\n[All results](${a.url})`, true)),
  ];
  return { title: `Stock ${plain(s.firmware.stock)} vs Medius ${plain(s.firmware.medius)}`, description, fields };
}

export interface Board {
  send(o: { embeds: Embed[]; flags: number; allowedMentions: { parse: [] } }): Promise<{ id: string }>;
  messages: {
    fetch(id: string): Promise<unknown>;
    edit(id: string, o: { content: string; embeds: Embed[]; flags: number; allowedMentions: { parse: [] } }): Promise<unknown>;
    delete(id: string): Promise<unknown>;
  };
}

interface Post {
  channel_id: string;
  message_id: string;
  content: string;
}

const gone = (error: unknown) => (error as { code?: unknown }).code === UNKNOWN_MESSAGE;

// Flags are a number from the API, a bit field from discord.js.
const suppressed = (m: unknown) => {
  const flags = (m as { flags?: number | { has(bit: number): boolean } }).flags;
  return typeof flags === "number" ? (flags & HIDDEN) !== 0 : (flags?.has(HIDDEN) ?? false);
};

export async function runComparison(
  ctx: AppContext,
  guildId: string,
  channel: (id: string) => Promise<Board | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const channelId = ctx.config.get<string>(guildId, CONFIG_KEYS.comparisonChannelId);
  if (!channelId) return;
  let body: unknown;
  try {
    const res = await fetchImpl(ctx.config.getEffective<string>(guildId, CONFIG_KEYS.comparisonUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    body = await res.json();
  } catch {
    return;
  }
  const summary = readSummary(body);
  if (!summary) return;
  const embeds = [render(summary)];
  const content = JSON.stringify(embeds);
  const board = await channel(channelId);
  if (!board) return;

  let post = one<Post>(ctx.db, "SELECT channel_id, message_id, content FROM comparison_posts WHERE guild_id = ?", guildId);
  const drop = () => run(ctx.db, "DELETE FROM comparison_posts WHERE guild_id = ?", guildId);
  if (post && post.channel_id !== channelId) {
    // The channel changed: the post in the old one comes down, where the bot still can.
    const old = await channel(post.channel_id);
    await old?.messages.delete(post.message_id).catch((error) => {
      if (!gone(error)) ctx.logger.warn("comparison: couldn't remove the post from the channel it left", { guildId, channelId: post!.channel_id });
    });
    drop();
    post = undefined;
  }
  const live = post
    ? await board.messages.fetch(post.message_id).catch((error) => {
        if (gone(error)) return null;
        throw error;
      })
    : null;
  if (!post || live === null) {
    drop();
    const m = await board.send({ embeds, flags: SILENT, allowedMentions: { parse: [] } });
    run(ctx.db, "INSERT INTO comparison_posts (guild_id, channel_id, message_id, content) VALUES (?, ?, ?, ?)", guildId, channelId, m.id, content);
  } else if (post.content !== content || suppressed(live)) {
    // No text, and flags 0 clears "Remove embeds", which would keep the embed hidden.
    await board.messages.edit(post.message_id, { content: "", embeds, flags: 0, allowedMentions: { parse: [] } });
    run(ctx.db, "UPDATE comparison_posts SET content = ? WHERE guild_id = ?", content, guildId);
  }
}
