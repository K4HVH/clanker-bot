import type { AppContext } from "../core/context";
import { many, one, run } from "../db/index";
import { chunk } from "../server/history";
import { CONFIG_KEYS } from "./config";

// The device feed: devices new or changed on the site's Devices list, posted in a channel. The list
// merges owners' reports with what the usage stats saw on 2 or more boxes; this follows both. The first
// read records the list without posting it.

export interface FeedDevice {
  name: string;
  kind: "mouse" | "keyboard" | "other";
  verdict: "works" | "partial" | "doesnt";
  note?: string;
  vidpid?: string;
  reported?: string;
  boxes?: number;
}

const VERDICT: Record<FeedDevice["verdict"], string> = { works: "Supported", partial: "Partial", doesnt: "Unsupported" };
const PAGE = "https://medius.k4tech.net/guide/compatibility";

const source = (d: FeedDevice) => (d.reported ? `reported on ${d.reported}` : d.boxes ? `seen on ${d.boxes} boxes` : "");

function line(d: FeedDevice, was?: FeedDevice["verdict"]): string {
  const parts = [VERDICT[d.verdict], ...(was ? [`was ${VERDICT[was]}`] : []), ...(source(d) ? [source(d)] : [])];
  return `- **${d.name}** (${d.kind}): ${parts.join(", ")}${d.note ? `. ${d.note}` : ""}`;
}

export function feedText(added: FeedDevice[], changed: { device: FeedDevice; was: FeedDevice["verdict"] }[]): string | null {
  if (added.length === 0 && changed.length === 0) return null;
  const sections: string[] = [];
  if (added.length > 0) sections.push(["Added to Devices:", ...added.map((d) => line(d))].join("\n"));
  if (changed.length > 0) sections.push(["Changed on Devices:", ...changed.map((c) => line(c.device, c.was))].join("\n"));
  return `${sections.join("\n\n")}\n<${PAGE}>`;
}

interface Seen {
  name: string;
  vidpid: string | null;
  verdict: FeedDevice["verdict"];
}

type Postable = { send(o: { content: string; allowedMentions: { parse: [] } }): Promise<unknown> };

export async function runFeed(
  ctx: AppContext,
  guildId: string,
  channel: (id: string) => Promise<Postable | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const channelId = ctx.config.get<string>(guildId, CONFIG_KEYS.deviceFeedChannelId);
  if (!channelId) return;
  let devices: FeedDevice[];
  try {
    const res = await fetchImpl(ctx.config.getEffective<string>(guildId, CONFIG_KEYS.deviceFeedUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const body = (await res.json()) as { devices?: unknown };
    if (!Array.isArray(body.devices)) return;
    devices = body.devices as FeedDevice[];
  } catch {
    return;
  }

  const seen = many<Seen>(ctx.db, "SELECT name, vidpid, verdict FROM device_feed WHERE guild_id = ?", guildId);
  // A device keeps its identity by USB id where it has one (a stats device that gains a report is
  // renamed then), else by name.
  const match = (d: FeedDevice) =>
    (d.vidpid ? seen.find((s) => s.vidpid === d.vidpid) : undefined) ?? seen.find((s) => s.name.toLowerCase() === d.name.toLowerCase());
  const added: FeedDevice[] = [];
  const changed: { device: FeedDevice; was: FeedDevice["verdict"] }[] = [];
  for (const d of devices) {
    const s = match(d);
    if (!s) added.push(d);
    else if (s.verdict !== d.verdict) changed.push({ device: d, was: s.verdict });
  }

  const seeded = !!one(ctx.db, "SELECT 1 AS x FROM device_feed_meta WHERE guild_id = ?", guildId);
  const text = seeded ? feedText(added, changed) : null;
  if (text) {
    const target = await channel(channelId);
    if (!target) return; // kept unrecorded, so it posts once the channel is back
    for (const content of chunk(text)) await target.send({ content, allowedMentions: { parse: [] } });
  }

  for (const d of [...added, ...changed.map((c) => c.device)]) {
    const s = match(d);
    if (s) run(ctx.db, "DELETE FROM device_feed WHERE guild_id = ? AND name = ?", guildId, s.name);
    run(
      ctx.db,
      "INSERT OR REPLACE INTO device_feed (guild_id, name, vidpid, verdict) VALUES (?, ?, ?, ?)",
      guildId,
      d.name,
      d.vidpid ?? null,
      d.verdict,
    );
  }
  if (!seeded) run(ctx.db, "INSERT INTO device_feed_meta (guild_id, seeded_at) VALUES (?, ?)", guildId, Date.now());
}
