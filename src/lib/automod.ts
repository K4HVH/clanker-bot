import { matchBlocklist, parseBlocklist } from "./guards";

// Covers the common Discord invite hosts + a couple of shorteners. Allows optional spaces
// after the slash to catch light obfuscation like "discord.gg/ evil".
export const INVITE_REGEX =
  /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.new|dsc\.gg|invite\.gg)\/\s*[a-z0-9-]+/i;

// Matches http(s):// and www. links. Deliberately NOT bare "domain.tld" — that false-positives
// on filenames like readme.md / script.sh, which are common in a firmware community.
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s]+/gi;

export interface ContentRules {
  invites: boolean;
  links: boolean;
  linkAllowlist: string;
  wordBlocklist: string;
  mentionLimit: number; // 0 = off
  massMention: boolean;
  caps: boolean;
}

function domainOf(raw: string): string {
  // Strip trailing sentence punctuation the URL_REGEX greedily swallowed (e.g. "github.com."),
  // give a scheme so www./scheme-less links parse, then normalize the hostname.
  const trimmed = raw.replace(/[.,;:!?)\]}'"]+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed.replace(/^www\./i, "")}`;
  try {
    return new URL(withScheme).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return "";
  }
}

// True if the content contains a URL whose domain is NOT in the allowlist (an empty allowlist
// means every link is disallowed). Subdomains of an allowlisted domain are allowed.
export function hasUnallowedLink(content: string, allowlist: string): boolean {
  const urls = content.match(URL_REGEX);
  if (!urls) return false;
  const allowed = allowlist
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  for (const url of urls) {
    const domain = domainOf(url);
    if (!domain) continue;
    const ok = allowed.some((a) => domain === a || domain.endsWith(`.${a}`));
    if (!ok) return true;
  }
  return false;
}

// A high floor so short shouted acronym lists (GPIO, UART, I2C, SPI…) common in a firmware
// community don't trip it — only a genuinely long, mostly-uppercase message does.
export function isCapsSpam(content: string): boolean {
  const letters = content.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 24) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.7;
}

// Content-based checks — pure, so they run identically on a new OR an edited message. Returns
// a short violation label, or null. `massMention` is the gateway's real @everyone/@here PING
// flag (not a text match). Flood + duplicate are stateful and handled in the listener.
export function checkContent(
  content: string,
  ctx: { mentionCount: number; massMention: boolean },
  rules: ContentRules,
): string | null {
  if (rules.mentionLimit > 0 && ctx.mentionCount > rules.mentionLimit) return "excessive mentions";
  if (rules.massMention && ctx.massMention) return "@everyone / @here";
  if (rules.invites && INVITE_REGEX.test(content)) return "invite link";
  if (rules.wordBlocklist.trim()) {
    const hit = matchBlocklist(parseBlocklist(rules.wordBlocklist, { wholeWord: true }), [content]);
    if (hit) return `blocked term (${hit})`;
  }
  if (rules.links && hasUnallowedLink(content, rules.linkAllowlist)) return "external link";
  if (rules.caps && isCapsSpam(content)) return "excessive caps";
  return null;
}

// ── Escalation ladder ───────────────────────────────────────────────────────
// A punishment tier: apply `type` once a user reaches `at` violations. `rank` is fixed by
// severity (timeout < kick < ban) so the ladder is ordered independently of the thresholds.
export interface Tier {
  type: "timeout" | "kick" | "ban";
  at: number;
  rank: number;
}

export interface EscalationDecision {
  action: Tier | null; // the single tier to apply now, or null for warn-only
  // Suppress the "your message was removed" DM: true whenever we act OR we're inside the
  // post-action cooldown (so a burst doesn't spam the user after they've already been punished).
  suppressWarnDm: boolean;
}

// Decide the SINGLE escalation action for one violation. Pure + deterministic so the async
// wrapper (perm checks, Discord calls, DMs) stays thin and this can be exhaustively tested.
//
// Two guarantees the live bug reports demanded:
//   1. One tier at a time — a hard burst that jumps the count can never skip a tier (e.g. go
//      straight to kick from zero). We climb at most one enabled tier above what's already been
//      applied, and re-apply the top tier for repeat offenders.
//   2. One action per burst — a message SENT within cooldownMs of the last action (or before it,
//      a straggler from the same burst) takes no new action. Keying off the message's send time,
//      not our processing time, means a slow-to-drain backlog can't leak a second action.
export function decideEscalation(opts: {
  count: number; // violations in the memory window, INCLUDING the one being handled
  tiers: Tier[]; // enabled tiers, in ascending severity (rank) order
  appliedRank: number; // highest tier rank already applied in the window (0 = none)
  lastActionAt: number; // ms timestamp of the most recent action in the window (0 = none)
  messageSentAt: number; // when the offending message was SENT (message.createdTimestamp)
  cooldownMs: number;
}): EscalationDecision {
  const { count, tiers, appliedRank, lastActionAt, messageSentAt, cooldownMs } = opts;
  if (tiers.length === 0) return { action: null, suppressWarnDm: false };

  // One action per burst, measured by SEND time: a message sent within cooldownMs after the last
  // action — or before it (a straggler) — takes no new action and stays quiet (already punished).
  if (lastActionAt > 0 && messageSentAt - lastActionAt < cooldownMs) return { action: null, suppressWarnDm: true };

  // Highest enabled tier the count qualifies for; -1 if still below the lowest threshold.
  let targetPos = -1;
  for (let i = 0; i < tiers.length; i++) if (count >= (tiers[i]?.at ?? Infinity)) targetPos = i;
  if (targetPos < 0) return { action: null, suppressWarnDm: false };

  // Highest enabled tier at or below what's already been applied.
  let appliedPos = -1;
  for (let i = 0; i < tiers.length; i++) if ((tiers[i]?.rank ?? Infinity) <= appliedRank) appliedPos = i;

  // Ratchet: climb at most one enabled tier past what's applied (never skip UP), but never drop
  // below it either. If older warns aged out so the count only qualifies for a milder tier
  // (targetPos < appliedPos), re-apply the top tier already reached rather than downgrading — a
  // repeat offender within the window is re-punished at their highest tier, not let off lighter.
  const applyPos = Math.min(appliedPos + 1, Math.max(targetPos, appliedPos));
  const action = tiers[applyPos] ?? null;
  return { action, suppressWarnDm: action !== null };
}
