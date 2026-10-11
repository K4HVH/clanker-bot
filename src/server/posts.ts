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
