import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Message } from "discord.js";
import type { AppContext } from "../core/context";
import { loadSignatures, type SignatureKind } from "../db/scam-signature";
import { extractHostnames } from "./automod";
import { CONFIG_KEYS } from "./config";
import { attachmentTriple } from "./scam-seed";

// The reader side of the scam-signature store. Shared between automod's scan (index.ts, which
// enforces matches) and its seeding (seeding.ts, which writes the store); the signature cache and
// the forget-token map are the state both sides share.

// Per-guild signature sets, reused for CACHE_TTL so the hot path is a Set lookup, not a query per
// message. Invalidated on a write so a correction takes effect at once.
const CACHE_TTL = 60_000;
const cache = new Map<string, { sets: ReturnType<typeof loadSignatures>; at: number }>();

export function signatureSets(ctx: AppContext, guildId: string, now: number) {
  const cached = cache.get(guildId);
  if (cached && now - cached.at < CACHE_TTL) return cached.sets;
  const sets = loadSignatures(ctx.db, guildId, now);
  cache.set(guildId, { sets, at: now });
  return sets;
}

export function invalidateSignatures(guildId: string): void {
  cache.delete(guildId);
}

function embedTexts(message: Message): string[] {
  const out: string[] = [];
  for (const e of message.embeds) {
    if (e.url) out.push(e.url);
    if (e.title) out.push(e.title);
    if (e.description) out.push(e.description);
    if (e.author?.url) out.push(e.author.url);
    if (e.footer?.text) out.push(e.footer.text);
    for (const f of e.fields) out.push(f.value);
  }
  return out;
}

export async function sha256Of(url: string, maxBytes: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(buf);
    return hasher.digest("hex");
  } catch {
    return null;
  }
}

export interface SignatureMatch {
  kind: SignatureKind;
  value: string;
}

// Check a message against the seeded signatures. Domains (content + embeds + filenames + bare) are
// always checked and run on edits too; they only ever match confirmed-bad seeded values, so there
// is no false-positive surface to gate behind toggles. Images hash only on create (attachments are
// immutable after send). Returns the first match, or null.
export async function matchSignatures(
  ctx: AppContext,
  message: Message,
  now: number,
  opts: { skipImages: boolean },
): Promise<SignatureMatch | null> {
  const guildId = message.guild?.id;
  if (!guildId) return null;
  const sets = signatureSets(ctx, guildId, now);

  if (sets.domain.size) {
    const hosts = extractHostnames({
      content: message.content,
      embedTexts: embedTexts(message),
      filenames: message.attachments.map((a) => a.name),
      includeBare: true,
    });
    for (const host of hosts) if (sets.domain.has(host)) return { kind: "domain", value: host };
  }

  if (!opts.skipImages && (sets.sha256.size || sets.triple.size)) {
    const maxBytes = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamMaxImageMb) * 1_000_000;
    if (sets.sha256.size) {
      for (const a of message.attachments.values()) {
        if (!a.width || !a.height || a.size > maxBytes) continue;
        const hash = await sha256Of(a.url, maxBytes);
        if (hash && sets.sha256.has(hash)) return { kind: "sha256", value: hash };
      }
    }
    if (sets.triple.size) {
      for (const a of message.attachments.values()) {
        const triple = attachmentTriple(a.size, a.width, a.height);
        if (triple && sets.triple.has(triple)) return { kind: "triple", value: triple };
      }
    }
  }
  return null;
}

// "Not a scam" buttons carry a short token, not the (possibly long) signature value, since Discord
// caps a customId at 100 chars. The token map is in-memory, so a button from before a restart
// resolves to expired (the /automod forget command still works for those). automod's scan stashes
// the token when it posts a match alert; its seeding reads it back when the button is clicked.
const forgetTargets = new Map<string, { kind: SignatureKind; value: string; at: number }>();
let forgetSeq = 0;
const FORGET_TTL = 3_600_000;

export function forgetButton(kind: SignatureKind, value: string): ActionRowBuilder<ButtonBuilder> {
  const now = Date.now();
  for (const [k, v] of forgetTargets) if (now - v.at > FORGET_TTL) forgetTargets.delete(k);
  const token = (forgetSeq++).toString(36);
  forgetTargets.set(token, { kind, value, at: now });
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scam:forget:${token}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Not a scam, remove"),
  );
}

export function takeForgetToken(token: string): { kind: SignatureKind; value: string } | null {
  const target = forgetTargets.get(token);
  if (!target) return null;
  forgetTargets.delete(token);
  return { kind: target.kind, value: target.value };
}
