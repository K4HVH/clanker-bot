import type { MenuSpec } from "./spec";

// A bot-owned post is a Markdown file; Discord caps a message at 2000 characters. The file is cut
// at its "## " headings and the sections packed into as few messages as fit, so an edit to one
// section touches one message. A section over the limit is cut at its last blank line that fits.

const LIMIT = 2000;

export function splitPost(markdown: string): string[] {
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
  for (const piece of sections.flatMap(breakLong)) {
    const joined = acc ? `${acc}\n\n${piece}` : piece;
    if (joined.length <= LIMIT) {
      acc = joined;
    } else {
      if (acc) chunks.push(acc);
      acc = piece;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
}

function breakLong(section: string): string[] {
  const out: string[] = [];
  let rest = section;
  while (rest.length > LIMIT) {
    const blank = rest.lastIndexOf("\n\n", LIMIT);
    const at = blank > 0 ? blank : LIMIT; // one paragraph over the limit: cut it hard
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  out.push(rest);
  return out;
}


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
