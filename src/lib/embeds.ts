// Embeds as the bot posts them, packed under Discord's limits: 10 embeds and 6000 characters of embed
// text a message, 4096 a description, 25 fields an embed of 256-character names and 1024-character values.

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  author?: { name: string };
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
}

export const EMBEDS = 10;
export const MESSAGE = 6000;
export const DESCRIPTION = 4096;
export const FIELDS = 25;
const NAME = 256;
const VALUE = 1024;

// The site's colours: its accent, and ok, warn and bad.
export const ACCENT = 0x0080ff;
export const OK = 0x10b981;
export const WARN = 0xf59e0b;
export const BAD = 0xdc2626;

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// A field cut to Discord's lengths; a field can't be empty, so an empty part shows as a blank.
export const field = (name: string, value: string, inline = false): EmbedField => ({
  name: clip(name, NAME) || "​",
  value: clip(value, VALUE) || "​",
  ...(inline ? { inline } : {}),
});

// The characters Discord counts against a message's 6000.
export function embedLength(e: Embed): number {
  return (
    (e.author?.name.length ?? 0) +
    (e.title?.length ?? 0) +
    (e.description?.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

// Lines packed into descriptions of at most `max` characters; a line too long for one is cut.
export function descriptions(lines: string[], max = DESCRIPTION): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of lines) {
    const line = clip(raw, max);
    if (cur && cur.length + 1 + line.length > max) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

// Embeds in order, packed into as few messages as Discord takes.
export function pack<T extends Embed>(embeds: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const e of embeds) {
    const n = embedLength(e);
    if (cur.length > 0 && (cur.length === EMBEDS || size + n > MESSAGE)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// Embeds packed into messages, each embed in a group (an area, a verdict) carrying its group's heading:
// one that follows an embed of its group in the same message drops it, so a message that opens part way
// through a group still says what it holds. Dropping a heading only shortens a message.
export function packGroups<T extends Embed & { group: string }>(embeds: T[]): T[][] {
  return pack(embeds).map((message) =>
    message.map((e, i) => {
      if (i === 0 || message[i - 1]!.group !== e.group) return e;
      const { author: _a, title: _t, url: _u, ...rest } = e;
      return rest as T;
    }),
  );
}
