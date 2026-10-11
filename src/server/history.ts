import type { DiscordApi } from "./api";

// A channel's messages, read so a retired channel can be copied into another before it goes.
export interface HistoryMessage {
  id: string;
  type?: number;
  content: string;
  timestamp?: string;
  flags?: number;
  author: { id: string; username?: string; global_name?: string | null };
  attachments?: { filename: string; url: string; size: number }[];
  embeds?: Record<string, unknown>[];
  sticker_items?: { name: string }[];
  message_snapshots?: { message: { content: string; attachments?: { filename: string; url: string; size: number }[] } }[];
  poll?: { question: { text?: string } };
}

export interface History {
  messages: HistoryMessage[];
  threads: number;
}

// What members wrote and replies; joins, pins and other notices from Discord aren't copied.
export const copyable = (m: HistoryMessage) => (m.type ?? 0) === 0 || m.type === 19;

export const after = (id: string, than: string) => BigInt(id) > BigInt(than);

// When a message was sent, in Unix seconds: its timestamp, or the time in its id.
export function sentAt(m: HistoryMessage): number {
  const ms = Date.parse(m.timestamp ?? "");
  return Math.floor((Number.isNaN(ms) ? Number((BigInt(m.id) >> 22n) + 1420070400000n) : ms) / 1000);
}

// Text cut into messages of at most `max` characters: after a line end or a space in the second half
// of a message, else at `max`, never inside a character. The parts joined give the text back exactly.
export function chunk(text: string, max = 2000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const at = (c: string) => rest.lastIndexOf(c, max - 1) + 1;
    let cut = [at("\n"), at(" ")].find((n) => n >= max / 2) ?? 0;
    if (cut === 0) cut = /[\uD800-\uDBFF]/.test(rest[max - 1]!) ? max - 1 : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

// Every message after `since`, oldest first.
export async function readHistory(api: DiscordApi, channelId: string, since = "0"): Promise<HistoryMessage[]> {
  const out: HistoryMessage[] = [];
  let cursor = since;
  for (;;) {
    const page = await api.get<HistoryMessage[]>(`/channels/${channelId}/messages?limit=100&after=${cursor}`);
    out.push(...page);
    if (page.length < 100) break;
    cursor = page.reduce((max, m) => (after(m.id, max) ? m.id : max), cursor);
  }
  return out.sort((a, b) => (after(a.id, b.id) ? 1 : -1));
}

export async function readThreadCount(api: DiscordApi, guildId: string, channelId: string): Promise<number> {
  const active = await api.get<{ threads: { parent_id: string | null }[] }>(`/guilds/${guildId}/threads/active`);
  const archived = await Promise.all(
    (["public", "private"] as const).map((kind) => api.get<{ threads: unknown[] }>(`/channels/${channelId}/threads/archived/${kind}`)),
  );
  return active.threads.filter((t) => t.parent_id === channelId).length + archived.reduce((n, a) => n + a.threads.length, 0);
}
