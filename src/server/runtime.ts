import type { BotDatabase } from "../db/index";
import type { ChannelSpec, ServerSpec } from "./spec";
import { channelsFlat } from "./spec";
import { SPECS } from "./specs";
import { getSpecName, loadState, type StateKind, stateKey } from "./state";

// What a running module reads of a server's spec: the spec it follows, and keys and ids both ways.

export function specFor(db: BotDatabase, guildId: string, specs: Record<string, ServerSpec> = SPECS): ServerSpec | undefined {
  const name = getSpecName(db, guildId);
  return name ? specs[name] : undefined;
}

export function idFor(db: BotDatabase, guildId: string, kind: StateKind, key: string): string | undefined {
  return loadState(db, guildId).get(stateKey(kind, key));
}

export function keyFor(db: BotDatabase, guildId: string, kind: StateKind, id: string): string | undefined {
  for (const [k, v] of loadState(db, guildId)) if (v === id && k.startsWith(`${kind}:`)) return k.slice(kind.length + 1);
  return undefined;
}

// The spec's channel for a live channel id, if the server follows a spec that names it.
export function channelSpecFor(
  db: BotDatabase,
  guildId: string,
  channelId: string,
  specs: Record<string, ServerSpec> = SPECS,
): ChannelSpec | undefined {
  const spec = specFor(db, guildId, specs);
  const key = spec ? keyFor(db, guildId, "channel", channelId) : undefined;
  if (!spec || !key) return undefined;
  const found = channelsFlat(spec).find((c) => c.channel.key === key)?.channel;
  return found && found.type !== "category" ? found : undefined;
}
