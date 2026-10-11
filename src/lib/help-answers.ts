// Answers from the site's Help page for a new help post. The site publishes its search index; its Help
// entries are the answers. A post is matched on shared words, title first, with owners' own words for
// things mapped onto the site's (a "laggy" mouse is a "delayed" one).

export interface IndexEntry {
  path: string;
  title: string;
  kind: string;
  text: string;
  keywords?: string[];
}

export interface SiteIndex {
  entries: IndexEntry[];
}

export interface Answer {
  title: string;
  url: string;
}

const SITE = "https://medius.k4tech.net";

const STOP = new Set(
  "the a an and or but if so to of in on at by for with from into as is are was were be been being it its this that these those i im i'm me my we our you your he she they them their what which who how why when where can cant can't could would should will wont won't do does doesnt doesn't did didnt didn't not no yes just any anyone some get got have has had keep keeps make makes use using used one also still very really there here about after before then than too all every time times same need needs help please thanks hi hello hey guys guy bro anybody someone box makcu medius".split(
    " ",
  ),
);

// Owners' words for things, onto the words the Help page uses.
const SYNONYMS: [RegExp, string][] = [
  [/\b(bsod|blue[- ]?screen\w*|bluescreen\w*)\b/g, " blue-screens bsod "],
  [/\b(lag|laggy|lagging|delay|delayed|slow|sluggish|floaty)\b/g, " delayed "],
  [/\b125 ?hz\b|\b125\b/g, " 125 "],
  [/\b(ps4|ps5|playstation|xbox|gamepad|dualsense|controllers?)\b/g, " controller controllers "],
  [/\b(original|stock|factory|oem|revert|downgrade)\b/g, " stock "],
  [/\b(cheats?|programs?|apps?|scripts?|loaders?|software)\b/g, " software "],
  [/\b(find|finds|detect|detects|detected|detecting|see|sees|recogni[sz]e|recogni[sz]ed|shows? up)\b/g, " see "],
  [/\b(chrome|edge|brave|firefox|opera|safari|browsers?)\b/g, " browser "],
  [/\b(website|site|dashboard|web ?serial)\b/g, " dashboard computer "],
  [/\b(flash|flashing|flashed|installer|installing|setup|set up)\b/g, " install "],
  [/\b(kb|keyboards?)\b/g, " keyboard "],
  [/\b(mice|mouses?)\b/g, " mouse "],
  [/\b(same time|both|together|at once|hub)\b/g, " both one "],
  [/\b(free|cost|price|pay)\b/g, " free "],
  [/\b(drivers?)\b/g, " driver drivers "],
];

const stem = (w: string) => w.replace(/(?:ing|ed|es|s)$/, "");

function tokens(text: string): Set<string> {
  let t = ` ${text.toLowerCase()} `;
  for (const [re, to] of SYNONYMS) t = t.replace(re, to);
  return new Set(
    t
      .split(/[^a-z0-9'-]+/)
      .map((w) => w.replace(/^'+|'+$/g, ""))
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map(stem),
  );
}

// The Help page's answers: its entries less the topic headings ("#q-install").
const answers = (index: SiteIndex) =>
  index.entries.filter((e) => e.path.startsWith("/guide/help#") && !e.path.startsWith("/guide/help#q-"));

export function rankAnswers(index: SiteIndex, question: string, limit = 3): Answer[] {
  const asked = tokens(question);
  if (asked.size === 0) return [];
  const scored = answers(index)
    .map((e) => {
      const title = tokens(e.title);
      const body = tokens(`${e.text} ${(e.keywords ?? []).join(" ")}`);
      let score = 0;
      let hits = 0;
      for (const w of asked) {
        if (title.has(w)) {
          score += 3;
          hits++;
        } else if (body.has(w)) {
          score += 1;
          hits++;
        }
      }
      return { e, score, hits };
    })
    .filter((s) => s.score >= 3 && (s.hits >= 2 || s.score >= 6))
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title));
  return scored.slice(0, limit).map(({ e }) => ({ title: e.title, url: `${SITE}/guide/help/${e.path.slice("/guide/help#".length)}` }));
}

// Only the first link unfurls into the site's card; the rest are wrapped so the reply stays short.
export function formatAnswers(list: Answer[]): string {
  return ["These Help answers may cover it:", ...list.map((a, i) => `- ${a.title}: ${i === 0 ? a.url : `<${a.url}>`}`)].join("\n");
}

let cache: { url: string; at: number; index: SiteIndex | null } | null = null;
const CACHE_MS = 10 * 60_000;

// The site's index, read at most every ten minutes. Null when the site doesn't serve it (yet).
export async function siteIndex(url: string, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<SiteIndex | null> {
  if (cache && cache.url === url && now - cache.at < CACHE_MS) return cache.index;
  let index: SiteIndex | null = null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    const body = res.ok ? ((await res.json()) as unknown) : null;
    if (body && typeof body === "object" && Array.isArray((body as SiteIndex).entries)) index = body as SiteIndex;
  } catch {
    index = null;
  }
  cache = { url, at: now, index };
  return index;
}
