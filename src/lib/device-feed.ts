import { escapeMarkdown } from "discord.js";
import type { AppContext } from "../core/context";
import { many, one, run } from "../db/index";
import { CONFIG_KEYS } from "./config";
import { type Embed, GREEN, RED, YELLOW, descriptions, packGroups } from "./embeds";

// The device feed: the site's Devices list posted in a channel. The first read posts the whole list,
// silently; after that, devices new to it or whose verdict changed. The list merges owners' reports with
// what the usage stats saw on 2 or more boxes; this follows both.

export interface FeedDevice {
  name: string;
  kind: "mouse" | "keyboard" | "other";
  verdict: "works" | "partial" | "doesnt";
  note?: string;
  vidpid?: string;
  reported?: string;
  boxes?: number;
  url?: string; // the device's card on the Devices page
}

const VERDICT: Record<FeedDevice["verdict"], string> = { works: "Supported", partial: "Partial", doesnt: "Unsupported" };
const COLOR: Record<FeedDevice["verdict"], number> = { works: GREEN, partial: YELLOW, doesnt: RED };
// Unsupported first: the devices a reader most needs to find.
const VERDICTS: FeedDevice["verdict"][] = ["doesnt", "partial", "works"];
const KINDS = new Set(["mouse", "keyboard", "other"]);
const SILENT = 4096; // Discord's suppress-notifications flag

const source = (d: FeedDevice) => (d.reported ? `reported on ${d.reported}` : d.boxes ? `seen on ${d.boxes} boxes` : "");

// Names from the usage stats are whatever a device reports, so markdown in them is shown as typed.
const plain = (s: string) => escapeMarkdown(s).replace(/[[\]]/g, "\\$&");

// A device's line under its verdict's heading: what it was, if that changed, and where the list has it from.
function line(d: FeedDevice, was?: FeedDevice["verdict"]): string {
  const name = d.url ? `[**${plain(d.name)}**](${d.url})` : `**${plain(d.name)}**`;
  const parts = [...(was ? [`was ${VERDICT[was]}`] : []), ...(source(d) ? [source(d)] : [])];
  // One line a device: the lines of an embed are counted to know which devices it carries.
  return `- ${name} (${d.kind})${parts.length > 0 ? `: ${parts.join(", ")}` : ""}${d.note ? `. ${plain(d.note)}` : ""}`.replace(/\s*\n\s*/g, " ");
}

const readable = (d: unknown): d is FeedDevice => {
  const x = d as FeedDevice;
  return typeof x?.name === "string" && x.name.trim() !== "" && KINDS.has(x.kind) && x.verdict in VERDICT;
};

// A device's identity. A report is its name: names on the list are unique, and its USB id comes from
// the usage stats, which can move it to another id of the same device or drop it while they're down. A
// device only the stats know is its USB id: several can share a name.
const identity = (d: { name: string; vidpid?: string | null; reported?: string }) =>
  d.reported || !d.vidpid ? `name:${d.name.toLowerCase()}` : `id:${d.vidpid}`;

interface Item {
  device: FeedDevice;
  text: string;
}

// Sections as embeds, one a verdict in its colour; packed into messages, each with the devices it carries.
function messages(sections: { heading?: string; items: Item[] }[]): { embeds: Embed[]; devices: FeedDevice[] }[] {
  const embeds: (Embed & { group: string; devices: FeedDevice[] })[] = [];
  for (const s of sections) {
    for (const verdict of VERDICTS) {
      const items = s.items.filter((i) => i.device.verdict === verdict);
      // A verdict's devices past one embed's text go on in the next, under the same colour.
      let at = 0;
      for (const description of descriptions(items.map((i) => i.text))) {
        const count = description.split("\n").length;
        embeds.push({
          group: `${s.heading} ${verdict}`,
          title: s.heading ? `${s.heading}: ${VERDICT[verdict]}` : VERDICT[verdict],
          color: COLOR[verdict],
          description,
          devices: items.slice(at, at + count).map((i) => i.device),
        });
        at += count;
      }
    }
  }
  return packGroups(embeds).map((message) => ({
    embeds: message.map(({ group: _g, devices: _d, ...e }) => e),
    devices: message.flatMap((e) => e.devices),
  }));
}

interface Seen {
  ident: string;
  name: string;
  vidpid: string | null;
  verdict: FeedDevice["verdict"];
}

// Each device in the list with its record. Its identity first; then, over records no device claimed
// that way, what it was known by before: a report by the USB id the stats gave it (a stats device that
// gained a report, or a renamed report) or by its name (the stats' name for it), preferring a record
// with its verdict; a stats device by the report it was, if that report left the list.
function matches(devices: FeedDevice[], seen: Seen[]): Map<FeedDevice, Seen> {
  const byIdent = new Map(seen.map((s) => [s.ident, s]));
  const found = new Map<FeedDevice, Seen>();
  const claimed = new Set<string>();
  const claim = (d: FeedDevice, s: Seen | undefined) => {
    if (!s || claimed.has(s.ident)) return;
    found.set(d, s);
    claimed.add(s.ident);
  };
  for (const d of devices) claim(d, byIdent.get(identity(d)));
  const free = (s: Seen) => !claimed.has(s.ident);
  for (const d of devices) {
    if (found.has(d)) continue;
    const name = d.name.toLowerCase();
    if (identity(d).startsWith("id:")) {
      claim(d, byIdent.get(`name:${name}`));
      continue;
    }
    const sameName = seen.filter((s) => free(s) && s.name.toLowerCase() === name);
    claim(d, (d.vidpid ? seen.find((s) => free(s) && s.vidpid === d.vidpid) : undefined) ?? sameName.find((s) => s.verdict === d.verdict) ?? sameName[0]);
  }
  return found;
}

type Postable = { send(o: { embeds: Embed[]; flags?: number; allowedMentions: { parse: [] } }): Promise<unknown> };

export async function runFeed(
  ctx: AppContext,
  guildId: string,
  channel: (id: string) => Promise<Postable | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const channelId = ctx.config.get<string>(guildId, CONFIG_KEYS.deviceFeedChannelId);
  if (!channelId) return;
  let body: { devices?: unknown; stats?: unknown };
  try {
    const res = await fetchImpl(ctx.config.getEffective<string>(guildId, CONFIG_KEYS.deviceFeedUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    body = (await res.json()) as typeof body;
  } catch {
    return;
  }
  if (!Array.isArray(body.devices)) return;
  const devices = new Map<string, FeedDevice>();
  for (const d of body.devices.filter(readable)) if (!devices.has(identity(d))) devices.set(identity(d), d);

  const seeded = !!one(ctx.db, "SELECT 1 AS x FROM device_feed_meta WHERE guild_id = ?", guildId);
  // The first read is the whole list: one missing the usage stats' devices would leave them to be
  // posted as new later, so it waits for a complete one.
  if (!seeded && (devices.size === 0 || body.stats === false)) return;

  const seen = many<Seen>(ctx.db, "SELECT ident, name, vidpid, verdict FROM device_feed WHERE guild_id = ?", guildId);
  const found = matches([...devices.values()], seen);
  const match = (d: FeedDevice) => found.get(d);

  const sections: { heading?: string; items: Item[] }[] = [];
  if (!seeded) {
    // Only what isn't recorded yet, so a first post stopped part way carries on where it stopped.
    const rest = [...devices.values()].filter((d) => !match(d));
    sections.push({ items: rest.map((device) => ({ device, text: line(device) })) });
  } else {
    const added: Item[] = [];
    const changed: Item[] = [];
    for (const d of devices.values()) {
      const s = match(d);
      if (!s) added.push({ device: d, text: line(d) });
      else if (s.verdict !== d.verdict) changed.push({ device: d, text: line(d, s.verdict) });
    }
    if (added.length > 0) sections.push({ heading: "New", items: added });
    if (changed.length > 0) sections.push({ heading: "Changed", items: changed });
  }

  const record = (d: FeedDevice) => {
    const s = match(d);
    if (s) run(ctx.db, "DELETE FROM device_feed WHERE guild_id = ? AND ident = ?", guildId, s.ident);
    run(ctx.db, "INSERT OR REPLACE INTO device_feed (guild_id, ident, name, vidpid, verdict) VALUES (?, ?, ?, ?, ?)", guildId, identity(d), d.name, d.vidpid ?? s?.vidpid ?? null, d.verdict);
  };
  // A device known under another name or id, its verdict the same, is recorded as it is now without a
  // post, so it's still found once the old name or id is gone.
  for (const [d, s] of found) {
    if (s.verdict === d.verdict && (s.ident !== identity(d) || s.name !== d.name || (d.vidpid && d.vidpid !== s.vidpid))) record(d);
  }
  const parts = messages(sections);
  if (parts.length > 0) {
    const target = await channel(channelId);
    if (!target) return; // left unrecorded, so it posts once the channel is back
    // Each part records its devices once it's sent, so a part that fails goes again with only the devices it held.
    for (const part of parts) {
      await target.send({ embeds: part.embeds, ...(seeded ? {} : { flags: SILENT }), allowedMentions: { parse: [] } });
      for (const d of part.devices) record(d);
    }
  }
  if (!seeded) run(ctx.db, "INSERT INTO device_feed_meta (guild_id, seeded_at) VALUES (?, ?)", guildId, Date.now());
}
