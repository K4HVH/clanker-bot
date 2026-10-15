import type { MenuSpec } from "./spec";

// A bot-owned post is a Markdown file; Discord caps a message at 2000 characters. The file is cut
// at its "## " headings and the sections packed into as few messages as fit, so an edit to one
// section touches one message. A section over the limit is cut at its last blank line that fits.

const LIMIT = 2000;
const DESCRIPTION = 4096;

export function splitPost(markdown: string, limit = LIMIT): string[] {
  const text = markdown.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join("\n").trim());

  const chunks: string[] = [];
  let acc = "";
  for (const piece of sections.flatMap((section) => breakLong(section, limit))) {
    const joined = acc ? `${acc}\n\n${piece}` : piece;
    if (joined.length <= limit) {
      acc = joined;
    } else {
      if (acc) chunks.push(acc);
      acc = piece;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
}

function breakLong(section: string, limit: number): string[] {
  const out: string[] = [];
  let rest = section;
  while (rest.length > limit) {
    const blank = rest.lastIndexOf("\n\n", limit);
    const at = blank > 0 ? blank : limit; // one paragraph over the limit: cut it hard
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  out.push(rest);
  return out;
}


// A post shown as embeds, one a message: the file's "# Title" or "# [Title](url)" line titles the first,
// and the rest is cut as a text post is, at a description's 4096 characters.
export interface PostEmbed {
  title?: string;
  url?: string;
  description?: string;
  color: number;
}

export function embedPost(markdown: string, color: number): PostEmbed[] {
  const text = markdown.replace(/\r\n/g, "\n").trim();
  const [first = "", ...rest] = text.split("\n");
  const head = first.match(/^# (?:\[(.+)\]\((\S+)\)|(.+))$/);
  const title = head ? (head[1] ?? head[3])!.trim() : undefined;
  const url = head?.[2];
  const parts = splitPost(head ? rest.join("\n") : text, DESCRIPTION);
  const titled = { ...(title ? { title } : {}), ...(url ? { url } : {}) };
  if (parts.length === 0) return title ? [{ ...titled, color }] : [];
  return parts.map((description, i) => ({ ...(i === 0 ? titled : {}), description, color }));
}

// What the planner compares of a post's embed: the parts the spec sets.
export const embedKey = (e: { title?: string; url?: string; description?: string; color?: number } | null | undefined): string | null =>
  // Discord leaves a colour of 0 out.
  e ? JSON.stringify([e.title ?? null, e.url ?? null, e.description ?? null, e.color ?? 0]) : null;

// A role menu as message components: one select per question, its options naming roles by key.
export function menuComponents(menu: MenuSpec): unknown[] {
  return menu.questions.map((q) => ({
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `roles:${menu.key}:${q.key}`,
        placeholder: q.title,
        min_values: 0,
        max_values: q.multiple ? q.options.length : 1,
        options: q.options.map((o) => ({
          label: o.label,
          value: o.role,
          ...(o.description ? { description: o.description } : {}),
          ...(o.emoji ? { emoji: { name: o.emoji } } : {}),
        })),
      },
    ],
  }));
}

// A post chunk's state: "channelId/messageId", or for a forum post "threadId/messageId@forumId".
export function parsePosted(value: string): { channel: string; message: string; forum?: string } {
  const [where, forum] = value.split("@");
  const [channel, message] = where!.split("/");
  return { channel: channel!, message: message!, ...(forum !== undefined ? { forum } : {}) };
}
