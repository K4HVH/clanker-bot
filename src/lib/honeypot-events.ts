import type { Guild } from "discord.js";

// A message the honeypot confirmed as bad. Emitted by the honeypot module; the anti-scam module
// subscribes to seed the signature blocklist. Kept as a tiny in-process seam so the honeypot
// (detection + action) never has to import the signature machinery (intelligence).
export interface HoneypotAttachment {
  url: string; // cdn.discordapp.com — the ORIGINAL bytes (never proxyURL, which re-encodes)
  size: number;
  width: number | null;
  height: number | null;
  name: string;
  contentType: string | null;
}

export interface HoneypotHit {
  guild: Guild;
  userId: string;
  content: string;
  attachments: HoneypotAttachment[];
}

type Handler = (hit: HoneypotHit) => void | Promise<void>;

const handlers: Handler[] = [];

// Subscribe to honeypot hits (the anti-scam module does this once at import).
export function onHoneypotHit(handler: Handler): void {
  handlers.push(handler);
}

// Fire-and-forget dispatch: a slow/throwing subscriber must never block or break the honeypot's
// own removal + logging path.
export function emitHoneypotHit(hit: HoneypotHit): void {
  for (const handler of handlers) {
    Promise.resolve()
      .then(() => handler(hit))
      .catch(() => {});
  }
}
