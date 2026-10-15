import { escapeMarkdown } from "discord.js";
import type { AppContext } from "../core/context";
import { many, run } from "../db/index";
import { CONFIG_KEYS } from "./config";

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

const LIMIT = 2000;
const QUIET = 4; // Discord's suppress-embeds flag: no link previews
const SILENT = 4096; // Discord's suppress-notifications flag
const UNKNOWN_MESSAGE = 10008;
const BOX: Record<Box, string> = { stock: "Stock", medius: "Medius" };

const plain = (s: string) => escapeMarkdown(s).replace(/[[\]]/g, "\\$&");
const cut = (line: string) => (line.length > LIMIT ? `${line.slice(0, LIMIT - 1)}…` : line);
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

const value = (box: Box, c: Cell, ahead: boolean) => {
  const text = `${BOX[box]}: ${c.code ? `\`${c.text.replace(/`/g, "")}\`` : plain(c.text)}`;
  return ahead ? `**${text}**` : text;
};

// The summary's messages, in order: each area and the defects kept whole in one message where they fit.
export function render(s: Summary): string[] {
  const blocks: string[][] = [
    [
      `# [Stock vs Medius](<${s.url}>)`,
      `Stock MAKCU firmware ${plain(s.firmware.stock)} and Medius ${plain(s.firmware.medius)}, tested the same way on two MAKCU boxes. The main results from each area are below, and each area's page has the rest.`,
    ],
  ];
  for (const a of s.areas) {
    const rows = a.rows.map((r) => {
      const cells = [`${plain(r.test)} (${plain(r.case)})`, value("stock", r.stock, r.result === "stock"), value("medius", r.medius, r.result === "medius")];
      for (const d of r.defects) cells.push(`[${BOX[d.box]} defect](<${d.url}>)`);
      return cut(`- ${cells.join(" | ")}`);
    });
    blocks.push([`### [${plain(a.title)}](<${a.url}>)`, ...rows]);
  }
  const defects = (["stock", "medius"] as Box[]).flatMap((box) => {
    const mine = s.defects.filter((d) => d.box === box);
    return mine.length > 0
      ? mine.map((d) => cut(`- ${BOX[box]}: ${plain(d.text)} ([${plain(d.where.title)}](<${d.where.url}>))`))
      : [`- ${BOX[box]}: None found`];
  });
  blocks.push(["### Defects", ...defects]);

  const out: string[] = [];
  let cur = "";
  const add = (piece: string, gap: string) => {
    if (cur && cur.length + gap.length + piece.length > LIMIT) {
      out.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}${gap}${piece}` : piece;
  };
  for (const block of blocks) {
    const whole = block.join("\n");
    if (whole.length <= LIMIT) add(whole, "\n\n");
    else block.forEach((line, i) => add(line, i === 0 ? "\n\n" : "\n"));
  }
  if (cur) out.push(cur);
  return out;
}

export interface Board {
  send(o: { content: string; flags: number; allowedMentions: { parse: [] } }): Promise<{ id: string }>;
  messages: {
    fetch(id: string): Promise<unknown>;
    edit(id: string, o: { content: string; flags: number; allowedMentions: { parse: [] } }): Promise<unknown>;
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

  // A set with a part missing from this channel (deleted, or the channel changed) comes down and the
  // summary goes up whole: a part posted alone would land after the rest.
  // A take-down stopped part way leaves a gap in the parts: finish it.
  let whole = posts.some((p, i) => p.part !== i);
  for (const p of posts) {
    if (whole) break;
    whole = await board.messages.fetch(p.message_id).then(
      () => false,
      (error) => {
        if (gone(error)) return true;
        throw error;
      },
    );
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

  for (const [part, content] of parts.entries()) {
    const p = posts[part];
    if (!p) {
      const m = await board.send({ content, flags: QUIET | SILENT, allowedMentions: { parse: [] } });
      run(ctx.db, "INSERT INTO comparison_posts (guild_id, part, channel_id, message_id, content) VALUES (?, ?, ?, ?, ?)", guildId, part, channelId, m.id, content);
    } else if (p.content !== content) {
      await board.messages.edit(p.message_id, { content, flags: QUIET, allowedMentions: { parse: [] } });
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
