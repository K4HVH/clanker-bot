import type { Message } from "discord.js";
import { strToU8, zipSync } from "fflate";

// Cap the archive so it stays under Discord's upload limit even on unboosted guilds.
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export interface TicketArchiveMeta {
  ticketNumber: number;
  subject: string;
  openerId: string;
  closedBy: string;
  reason?: string | null;
}

// Build a text transcript of the whole ticket. When `withImages` is on, also
// download every posted image (skipping any that can't fit the size budget BEFORE
// fetching, so a huge attachment can't OOM the bot) and return them zipped alongside
// transcript.txt. `messages` must be oldest-first.
export async function buildTicketArchive(
  meta: TicketArchiveMeta,
  messages: Message[],
  opts: { withImages: boolean },
): Promise<{ text: string; zipBytes: Uint8Array | null; imageCount: number }> {
  const header = [
    `Ticket #${meta.ticketNumber} — ${meta.subject}`,
    `Opened by: ${meta.openerId}`,
    `Closed by: ${meta.closedBy}${meta.reason ? ` — ${meta.reason}` : ""}`,
    "",
  ].filter((l): l is string => l !== undefined);

  const lines: string[] = [];
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  let imageCount = 0;

  for (const m of messages) {
    const time = new Date(m.createdTimestamp).toISOString();
    const atts = [...m.attachments.values()];
    const note = atts.length ? `  [attached: ${atts.map((a) => a.name ?? "file").join(", ")}]` : "";
    lines.push(`[${time}] ${m.author.tag}: ${m.content}${note}`);
    if (!opts.withImages) continue;

    for (const a of atts) {
      const name = a.name ?? "file";
      const isImage = IMAGE_EXT.test(name) || (a.contentType?.startsWith("image/") ?? false);
      // Gate on the DECLARED size before downloading anything.
      if (!isImage || a.size > MAX_ARCHIVE_BYTES - total) continue;
      const res = await fetch(a.url).catch(() => null);
      if (!res?.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (total + buf.length > MAX_ARCHIVE_BYTES) continue; // backstop vs a lying Content-Length
      total += buf.length;
      imageCount += 1;
      files[`images/${imageCount}-${name}`.slice(0, 200)] = buf;
    }
  }

  const text = `${header.join("\n")}\n${lines.join("\n")}\n`;
  if (opts.withImages && imageCount > 0) {
    files["transcript.txt"] = strToU8(text);
    return { text, zipBytes: zipSync(files), imageCount };
  }
  return { text, zipBytes: null, imageCount };
}
