import type { AppContext } from "../core/context";
import { many, one, run } from "../db/index";
import { CONFIG_KEYS } from "./config";

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
const KINDS = new Set(["mouse", "keyboard", "other"]);
const PAGE = "https://medius.k4tech.net/guide/compatibility";
const LIMIT = 2000;
const SILENT = 4096; // Discord's suppress-notifications flag

const source = (d: FeedDevice) => (d.reported ? `reported on ${d.reported}` : d.boxes ? `seen on ${d.boxes} boxes` : "");

function line(d: FeedDevice, was?: FeedDevice["verdict"]): string {
  const name = d.url ? `[**${d.name}**](<${d.url}>)` : `**${d.name}**`;
  const parts = [VERDICT[d.verdict], ...(was ? [`was ${VERDICT[was]}`] : []), ...(source(d) ? [source(d)] : [])];
  return `- ${name} (${d.kind}): ${parts.join(", ")}${d.note ? `. ${d.note}` : ""}`;
}

const readable = (d: unknown): d is FeedDevice => {
  const x = d as FeedDevice;
  return typeof x?.name === "string" && x.name.trim() !== "" && KINDS.has(x.kind) && x.verdict in VERDICT;
};

// A device's identity: its USB id where it has one (a stats device that gains a report is renamed
// then), else its name.
const identity = (d: { name: string; vidpid?: string | null }) => (d.vidpid ? `id:${d.vidpid}` : `name:${d.name.toLowerCase()}`);

interface Item {
  device: FeedDevice;
  text: string;
}

// Sections cut into messages under Discord's limit, each with the devices it carries, the page's link on
// the last.
function messages(sections: { heading: string; items: Item[] }[]): { content: string; devices: FeedDevice[] }[] {
  const footer = `\n<${PAGE}>`;
  const out: { content: string; devices: FeedDevice[] }[] = [];
  let cur = { content: "", devices: [] as FeedDevice[] };
  for (const s of sections) {
    for (const [i, item] of s.items.entries()) {
      const piece = `${i === 0 ? `${cur.content ? "\n\n" : ""}${s.heading}\n` : "\n"}${item.text}`;
      if (cur.content && cur.content.length + piece.length + footer.length > LIMIT) {
        out.push(cur);
        cur = { content: i === 0 ? `${s.heading}\n${item.text}` : item.text, devices: [item.device] };
      } else {
        cur.content += cur.content ? piece : piece.replace(/^\n+/, "");
        cur.devices.push(item.device);
      }
    }
  }
  if (cur.content) out.push(cur);
  if (out.length > 0) out[out.length - 1]!.content += footer;
  return out;
}

interface Seen {
  name: string;
  vidpid: string | null;
  verdict: FeedDevice["verdict"];
}

type Postable = { send(o: { content: string; flags?: number; allowedMentions: { parse: [] } }): Promise<unknown> };

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

  const seen = new Map(many<Seen>(ctx.db, "SELECT name, vidpid, verdict FROM device_feed WHERE guild_id = ?", guildId).map((s) => [identity(s), s]));
  const byName = new Map([...seen.values()].map((s) => [s.name.toLowerCase(), s]));
  const match = (d: FeedDevice) => (d.vidpid ? seen.get(`id:${d.vidpid}`) : undefined) ?? byName.get(d.name.toLowerCase());

  const sections: { heading: string; items: Item[] }[] = [];
  if (!seeded) {
    // Only what isn't recorded yet, so a first post stopped part way carries on where it stopped.
    const rest = [...devices.values()].filter((d) => !match(d));
    sections.push({ heading: "On the Devices list:", items: rest.map((device) => ({ device, text: line(device) })) });
  } else {
    const added: Item[] = [];
    const changed: Item[] = [];
    for (const d of devices.values()) {
      const s = match(d);
      if (!s) added.push({ device: d, text: line(d) });
      else if (s.verdict !== d.verdict) changed.push({ device: d, text: line(d, s.verdict) });
    }
    if (added.length > 0) sections.push({ heading: "Added to Devices:", items: added });
    if (changed.length > 0) sections.push({ heading: "Changed on Devices:", items: changed });
  }

  const record = (d: FeedDevice) => {
    const s = match(d);
    if (s) run(ctx.db, "DELETE FROM device_feed WHERE guild_id = ? AND name = ?", guildId, s.name);
    run(ctx.db, "INSERT OR REPLACE INTO device_feed (guild_id, name, vidpid, verdict) VALUES (?, ?, ?, ?)", guildId, d.name, d.vidpid ?? null, d.verdict);
  };
  const parts = messages(sections);
  if (parts.length > 0) {
    const target = await channel(channelId);
    if (!target) return; // left unrecorded, so it posts once the channel is back
    // Each part records its devices once it's sent, so a part that fails goes again with only its own.
    for (const part of parts) {
      await target.send({ content: part.content, ...(seeded ? {} : { flags: SILENT }), allowedMentions: { parse: [] } });
      for (const d of part.devices) record(d);
    }
  }
  if (!seeded) run(ctx.db, "INSERT INTO device_feed_meta (guild_id, seeded_at) VALUES (?, ?)", guildId, Date.now());
}
