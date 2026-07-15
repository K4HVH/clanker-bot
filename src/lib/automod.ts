import { matchBlocklist, parseBlocklist } from "./guards";

// Covers the common Discord invite hosts + a couple of shorteners. Allows optional spaces
// after the slash to catch light obfuscation like "discord.gg/ evil".
export const INVITE_REGEX =
  /(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.new|dsc\.gg|invite\.gg)\/\s*[a-z0-9-]+/i;

const URL_REGEX = /https?:\/\/[^\s]+/gi;
const MASS_MENTION_REGEX = /@(everyone|here)\b/i;

export interface ContentRules {
  invites: boolean;
  links: boolean;
  linkAllowlist: string;
  wordBlocklist: string;
  mentionLimit: number; // 0 = off
  massMention: boolean;
  caps: boolean;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
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
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const url of urls) {
    const domain = domainOf(url);
    if (!domain) continue;
    const ok = allowed.some((a) => domain === a || domain.endsWith(`.${a}`));
    if (!ok) return true;
  }
  return false;
}

export function isCapsSpam(content: string): boolean {
  const letters = content.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 10) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.7;
}

// Content-based checks — pure, so they run identically on a new OR an edited message. Returns
// a short violation label, or null. (Flood + duplicate are stateful and handled in the
// listener via trackers, not here.)
export function checkContent(
  content: string,
  ctx: { mentionCount: number },
  rules: ContentRules,
): string | null {
  if (rules.mentionLimit > 0 && ctx.mentionCount > rules.mentionLimit) return "excessive mentions";
  if (rules.massMention && MASS_MENTION_REGEX.test(content)) return "@everyone / @here";
  if (rules.invites && INVITE_REGEX.test(content)) return "invite link";
  if (rules.wordBlocklist.trim()) {
    const hit = matchBlocklist(parseBlocklist(rules.wordBlocklist), [content]);
    if (hit) return `blocked term (${hit})`;
  }
  if (rules.links && hasUnallowedLink(content, rules.linkAllowlist)) return "external link";
  if (rules.caps && isCapsSpam(content)) return "excessive caps";
  return null;
}
