// Pure message-matching for /mod purge, kept separate from Discord objects so the filter logic
// is unit-testable. The 14-day bulk-delete cutoff is handled by the caller (it partitions the
// matched messages into fast bulk-delete vs slow individual delete), not here.

export interface PurgeCriteria {
  userId?: string; // only this author
  filter?: string | null; // "bots" | "humans" | "links" | "attachments" | null
}

export interface PurgeableMessage {
  authorId: string;
  authorBot: boolean;
  content: string;
  attachmentCount: number;
}

// Catches http(s):// plus scheme-less links people actually post (www., invite shorteners).
const LINK_RE = /(https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)/i;

export function messageMatchesPurge(m: PurgeableMessage, c: PurgeCriteria): boolean {
  if (c.userId && m.authorId !== c.userId) return false;
  switch (c.filter) {
    case "bots":
      return m.authorBot;
    case "humans":
      return !m.authorBot;
    case "links":
      return LINK_RE.test(m.content);
    case "attachments":
      return m.attachmentCount > 0;
    default:
      return true;
  }
}
