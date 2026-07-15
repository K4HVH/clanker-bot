import type { Message } from "discord.js";
import { strToU8, zipSync } from "fflate";

// Cap the archive so it stays under Discord's upload limit even on unboosted guilds.
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export interface TicketArchiveMeta {
  ticketNumber: number;
  subject: string;
  openerId: string;
  claimedBy?: string | null;
  closedBy: string;
  reason?: string | null;
}

// Build a .zip containing transcript.txt plus every image posted in the ticket
// (downloaded, capped to the size budget). Returns the zip bytes AND the plain text
// (stored in the DB for the record). `messages` must be oldest-first.
export async function buildTicketArchive(
  meta: TicketArchiveMeta,
  messages: Message[],
): Promise<{ bytes: Uint8Array; text: string; imageCount: number }> {
  const header = [
    `Ticket #${meta.ticketNumber} — ${meta.subject}`,
    `Opened by: ${meta.openerId}`,
    meta.claimedBy ? `Claimed by: ${meta.claimedBy}` : undefined,
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

    for (const a of atts) {
      const name = a.name ?? "file";
      const isImage = IMAGE_EXT.test(name) || (a.contentType?.startsWith("image/") ?? false);
      if (!isImage || total >= MAX_ARCHIVE_BYTES) continue;
      const res = await fetch(a.url).catch(() => null);
      if (!res?.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (total + buf.length > MAX_ARCHIVE_BYTES) continue;
      total += buf.length;
      imageCount += 1;
      files[`images/${imageCount}-${name}`.slice(0, 200)] = buf;
    }
  }

  const text = `${header.join("\n")}\n${lines.join("\n")}\n`;
  files["transcript.txt"] = strToU8(text);
  return { bytes: zipSync(files), text, imageCount };
}
