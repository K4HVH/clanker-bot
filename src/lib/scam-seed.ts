// Pure helpers for deciding what may be promoted into the scam-signature blocklist. Kept separate
// from Discord/DB so the promotion guards can be unit-tested. A wrong entry here auto-fires on
// innocent members.

// Legit domains that must never be seeded, even when a scam message quotes them as decoration
// (scam text routinely includes discord.gg / discord.com). A host matches if it equals the entry
// or is a subdomain of it.
const SAFE_DOMAINS = [
  "discord.com", "discordapp.com", "discord.gg", "discord.new", "discordapp.net", "discordstatus.com",
  "cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com",
  "github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org",
  "google.com", "youtube.com", "youtu.be", "wikipedia.org", "stackoverflow.com",
  "espressif.com", "platformio.org", "esphome.io", "arduino.cc", "wokwi.com", "jlcpcb.com", "pcbway.com",
  "reddit.com", "twitter.com", "x.com", "imgur.com", "pastebin.com",
];

// Public suffixes / shared-hosting apexes that must never be seeded on their own, since seeding one
// would block every site on that host. We always store the FULL hostname, so a scam on shared
// hosting (scam.vercel.app) is still seedable; only the bare apex is refused.
const NEVER_SEED_EXACT = new Set([
  "vercel.app", "pages.dev", "web.app", "firebaseapp.com", "netlify.app", "github.io", "glitch.me",
  "repl.co", "replit.app", "r2.dev", "workers.dev", "000webhostapp.com", "herokuapp.com",
  "surge.sh", "onrender.com", "fly.dev", "gitbook.io", "notion.site", "weebly.com", "wixsite.com",
]);

function matchesList(host: string, list: Iterable<string>): boolean {
  for (const d of list) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}

// Whether a hostname may be promoted into the blocklist. Rejects non-domains, safe domains and
// their subdomains, allowlisted domains, and bare shared-hosting/public-suffix apexes.
export function isSeedableDomain(host: string, allowlist: string[]): boolean {
  if (!host || !host.includes(".")) return false;
  if (NEVER_SEED_EXACT.has(host)) return false;
  if (matchesList(host, SAFE_DOMAINS)) return false;
  if (matchesList(host, allowlist)) return false;
  return true;
}

// The image fingerprint stored/checked as a cheap pre-filter. Only images (with real dimensions)
// get one. A non-image attachment (.zip, .bin) returns null and is never fingerprinted.
export function attachmentTriple(size: number, width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  return `${size}:${width}:${height}`;
}
