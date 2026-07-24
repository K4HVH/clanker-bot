import type { Guild } from "discord.js";

// A honeypot hit. Emitted by the honeypot module; the automod module's seeding subscribes to seed
// the signature list. An in-process seam so the honeypot doesn't import the signature code.
export interface HoneypotAttachment {
  url: string; // cdn.discordapp.com, the original bytes (not proxyURL, which re-encodes)
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

// Fire-and-forget: a slow or throwing subscriber must not block the honeypot's own removal path.
export function emitHoneypotHit(hit: HoneypotHit): void {
  for (const handler of handlers) {
    Promise.resolve()
      .then(() => handler(hit))
      .catch(() => {});
  }
}
