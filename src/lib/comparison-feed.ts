import { escapeMarkdown } from "discord.js";
import type { AppContext } from "../core/context";
import { many, run } from "../db/index";
import { CONFIG_KEYS } from "./config";
import { ACCENT, BAD, type Embed, type EmbedField, FIELDS, MESSAGE, clip, descriptions, embedLength, field, packGroups } from "./embeds";

// The comparison summary: the Overview of the site's comparison of stock and Medius, kept in a channel.
// Each read posts it if it isn't there and edits it in place when the site's results change, so the
// channel holds one copy.

type Box = "stock" | "medius";

interface Cell {
  text: string;
  code?: boolean;
}

export interface Summary {
  firmware: Record<Box, string>;
  url: string;
  areas: {
    title: string;
    url: string;
    rows: { id: string; test: string; case: string; stock: Cell; medius: Cell; result: string | null; defects: { box: Box; url: string }[] }[];
  }[];
  defects: { box: Box; text: string; url: string; where: { title: string; url: string } }[];
}

const SILENT = 4096; // Discord's suppress-notifications flag
const HIDDEN = 4; // Discord's suppress-embeds flag, set by "Remove embeds"
const UNKNOWN_MESSAGE = 10008;
const BOX: Record<Box, string> = { stock: "Stock", medius: "Medius" };

const plain = (s: string) => escapeMarkdown(s).replace(/[[\]]/g, "\\$&");
const str = (x: unknown): x is string => typeof x === "string";
const isBox = (x: unknown): x is Box => x === "stock" || x === "medius";
const isCell = (x: unknown): x is Cell => str((x as Cell)?.text);

const isRow = (r: Summary["areas"][number]["rows"][number]) =>
  str(r?.test) && str(r?.case) && isCell(r?.stock) && isCell(r?.medius) && Array.isArray(r?.defects) && r.defects.every((d) => isBox(d?.box) && str(d?.url));
const isArea = (a: Summary["areas"][number]) => str(a?.title) && str(a?.url) && Array.isArray(a?.rows) && a.rows.length > 0 && a.rows.every(isRow);
const isDefect = (d: Summary["defects"][number]) => isBox(d?.box) && str(d?.text) && str(d?.where?.title) && str(d?.where?.url);

// The summary, or null if any of it can't be read: a summary missing a row or a defect would state less
// than the site, and one missing the defects would say none were found.
function readSummary(body: unknown): Summary | null {
  const b = body as Summary | null;
  if (!b || !str(b.firmware?.stock) || !str(b.firmware?.medius) || !str(b.url)) return null;
  if (!Array.isArray(b.areas) || b.areas.length === 0 || !b.areas.every(isArea)) return null;
  if (!Array.isArray(b.defects) || !b.defects.every(isDefect)) return null;
  return b;
}

// A box's value, in bold and ticked when that box is ahead, with the defects of that box the row shows.
function cell(r: Summary["areas"][number]["rows"][number], box: Box): string {
  const c = r[box];
  const text = c.code ? `\`${c.text.replace(/`/g, "")}\`` : plain(c.text);
  const shown = r.result === box ? `**${text}** ✓` : text;
  const defects = r.defects.filter((d) => d.box === box).map((d) => `[${BOX[d.box]} defect](${d.url})`);
  return [shown, ...defects].join("\n");
}

// The summary as messages of embeds: Overview's line, an embed per area with a row of three columns per
// result (what was tested, stock, Medius), then the defects.
export function render(s: Summary): { embeds: Embed[] }[] {
  const embeds: (Embed & { group: string })[] = [
    {
      group: "head",
      title: "Stock vs Medius",
      url: s.url,
      color: ACCENT,
      description: `Stock MAKCU firmware ${plain(s.firmware.stock)} and Medius ${plain(s.firmware.medius)}, tested the same way on two MAKCU boxes. The main results from each area are below, and each area's page has the rest.`,
    },
  ];
  for (const [n, a] of s.areas.entries()) {
    const head = { title: clip(plain(a.title), 256), url: a.url, color: ACCENT, group: `area ${n}` };
    // An area past what one embed holds, in fields or in characters, goes on in the next.
    let fields: EmbedField[] = [];
    for (const r of a.rows) {
      const row = [field(plain(r.test), plain(r.case), true), field(BOX.stock, cell(r, "stock"), true), field(BOX.medius, cell(r, "medius"), true)];
      const grown = embedLength({ ...head, fields: [...fields, ...row] });
      if (fields.length > 0 && (fields.length + row.length > FIELDS || grown > MESSAGE)) {
        embeds.push({ ...head, fields });
        fields = [];
      }
      fields.push(...row);
    }
    embeds.push({ ...head, fields });
  }
  const lines = (["stock", "medius"] as Box[]).flatMap((box, n) => {
    const mine = s.defects.filter((d) => d.box === box);
    return [
      ...(n > 0 ? [""] : []),
      `**${BOX[box]}**`,
      ...(mine.length > 0 ? mine.map((d) => `- ${plain(d.text)} ([${plain(d.where.title)}](${d.where.url}))`) : ["None found"]),
    ];
  });
  for (const description of descriptions(lines)) embeds.push({ group: "defects", title: "Defects", color: BAD, description });
  return packGroups(embeds).map((message) => ({ embeds: message.map(({ group: _, ...e }) => e) }));
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
  part: number;
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
  const parts = render(summary);
  const board = await channel(channelId);
  if (!board) return;

  let posts = many<Post>(ctx.db, "SELECT part, channel_id, message_id, content FROM comparison_posts WHERE guild_id = ? ORDER BY part", guildId);
  const drop = (p: Post) => run(ctx.db, "DELETE FROM comparison_posts WHERE guild_id = ? AND part = ?", guildId, p.part);

  // A set with a part missing from this channel (deleted, or the channel changed) or a gap in its parts
  // (a take-down stopped part way) comes down and the summary goes up whole: a part posted alone would
  // land after the rest. A part whose embeds someone hid is edited, which shows them again.
  let whole = posts.some((p, i) => p.part !== i);
  const hidden = new Set<number>();
  for (const p of posts) {
    if (whole) break;
    const m = await board.messages.fetch(p.message_id).catch((error) => {
      if (gone(error)) return null;
      throw error;
    });
    if (m === null) whole = true;
    else if (suppressed(m)) hidden.add(p.part);
  }
  if (whole) {
    for (const p of posts) {
      const where = p.channel_id === channelId ? board : await channel(p.channel_id);
      await where?.messages.delete(p.message_id).catch((error) => {
        if (gone(error)) return;
        // A channel the summary left can keep a stale copy; this one can't hold two.
        if (where === board) throw error;
        ctx.logger.warn("comparison: couldn't remove a post from the channel it left", { guildId, channelId: p.channel_id });
      });
      drop(p);
    }
    posts = [];
  }

  for (const [part, message] of parts.entries()) {
    const p = posts[part];
    const content = JSON.stringify(message.embeds);
    if (!p) {
      const m = await board.send({ embeds: message.embeds, flags: SILENT, allowedMentions: { parse: [] } });
      run(ctx.db, "INSERT INTO comparison_posts (guild_id, part, channel_id, message_id, content) VALUES (?, ?, ?, ?, ?)", guildId, part, channelId, m.id, content);
    } else if (p.content !== content || hidden.has(p.part)) {
      // The text is cleared, so a summary posted as text becomes embeds in place.
      await board.messages.edit(p.message_id, { content: "", embeds: message.embeds, flags: 0, allowedMentions: { parse: [] } });
      run(ctx.db, "UPDATE comparison_posts SET content = ? WHERE guild_id = ? AND part = ?", content, guildId, p.part);
    }
  }
  for (const p of posts.slice(parts.length)) {
    await board.messages.delete(p.message_id).catch((error) => {
      if (!gone(error)) throw error;
    });
    drop(p);
  }
}
