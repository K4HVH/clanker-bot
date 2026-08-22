// The ticket intelligence check: a short multiple-choice test generated fresh every
// time, so there is no question bank to maintain and no answer key to screenshot into
// general chat. Pure logic (no discord.js), which is what lets the tests re-derive
// every answer from the prompt text the way a member would read it.

// A seeded PRNG (mulberry32). Production seeds from crypto; tests pin the seed so a
// generator that is wrong about its own answer fails reproducibly rather than one run
// in fifty. Math.random is deliberately not used: an unseedable generator can only be
// tested by trusting it.
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CheckCategory = "reasoning";

// The one category that ships. Domain-specific sets (electronics, ESP32, comprehension)
// and any harder tier arrive as new entries here, which is why there is no difficulty
// knob: five calibrated variants of every generator would be five times the content for
// a dial that gets set once.
export const CHECK_CATEGORIES = ["reasoning"] as const satisfies readonly CheckCategory[];

export interface CheckQuestion {
  category: CheckCategory;
  generatorId: string;
  prompt: string;
  choices: string[];
  // Index into `choices`. Shuffled per question: a fixed slot would make "always click
  // the first button" a winning strategy.
  answerIndex: number;
}

export interface Generator {
  id: string;
  category: CheckCategory;
  generate(rng: Rng): CheckQuestion;
}

// ── Generator helpers ───────────────────────────────────────────────────────

function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[randInt(rng, 0, xs.length - 1)]!;
}

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Build the finished question: dedupe the distractors, drop any that collided with the
// answer, and shuffle. Every generator hands over MORE distractors than it needs, since
// a collision is a normal outcome of the arithmetic, not an error.
function assemble(
  rng: Rng,
  gen: { id: string; category: CheckCategory },
  prompt: string,
  correct: string,
  wrong: string[],
): CheckQuestion {
  const distinct = [...new Set(wrong)].filter((w) => w !== correct).slice(0, 3);
  if (distinct.length < 3) {
    throw new Error(`${gen.id}: only ${distinct.length} usable distractors for "${correct}"`);
  }
  const choices = shuffle(rng, [correct, ...distinct]);
  return {
    category: gen.category,
    generatorId: gen.id,
    prompt,
    choices,
    answerIndex: choices.indexOf(correct),
  };
}

// Numeric answers pad from near-misses so a generator can never run short of options:
// an off-by-one is exactly the mistake a rushed reader makes anyway.
function assembleNumeric(
  rng: Rng,
  gen: { id: string; category: CheckCategory },
  prompt: string,
  correct: number,
  wrong: number[],
): CheckQuestion {
  const padded = [...wrong, correct + 1, correct - 1, correct + 2, correct - 2];
  return assemble(rng, gen, prompt, String(correct), padded.map(String));
}

// ── seq: continue the sequence ──────────────────────────────────────────────

// Each mode shows enough terms to pin down exactly one rule. Arithmetic runs to five
// terms so a constant difference is unmistakable; alternating needs six, or the two
// interleaved runs have too few points to be the reading a solver settles on.
const seq: Generator = {
  id: "seq",
  category: "reasoning",
  generate(rng) {
    const mode = pick(rng, ["arithmetic", "geometric", "second-difference", "alternating"] as const);
    let terms: number[];
    let next: number;
    let wrong: number[];

    if (mode === "arithmetic") {
      const step = pick(rng, [-12, -9, -7, -6, -4, -3, 3, 4, 6, 7, 9, 12]);
      const start = step > 0 ? randInt(rng, 1, 20) : randInt(rng, 60, 99);
      terms = Array.from({ length: 5 }, (_, i) => start + i * step);
      next = start + 5 * step;
      wrong = [next + step, next - step, next + 1, terms[4]! + 2 * step];
    } else if (mode === "geometric") {
      const ratio = pick(rng, [2, 3]);
      const start = randInt(rng, 2, ratio === 2 ? 7 : 4);
      terms = Array.from({ length: 4 }, (_, i) => start * ratio ** i);
      next = start * ratio ** 4;
      const last = terms[3]!;
      // The classic wrong turn is reading a geometric run as an arithmetic one.
      wrong = [last + (last - terms[2]!), next * ratio, last * (ratio + 1), next - last];
    } else if (mode === "second-difference") {
      const start = randInt(rng, 1, 9);
      const first = randInt(rng, 2, 6);
      const grow = randInt(rng, 2, 5);
      terms = [start];
      for (let i = 0; i < 4; i++) terms.push(terms[i]! + first + i * grow);
      const lastDiff = first + 3 * grow;
      next = terms[4]! + lastDiff + grow;
      // Forgetting that the gap itself grows is the mistake this mode is built around.
      wrong = [terms[4]! + lastDiff, next + grow, terms[4]! + first, next - grow];
    } else {
      const stepA = randInt(rng, 2, 6);
      let stepB = randInt(rng, 7, 12);
      if (stepB === stepA) stepB += 1;
      const startA = randInt(rng, 1, 9);
      let startB = randInt(rng, 10, 30);
      // If the two runs interleave into one constant difference the sequence is just
      // arithmetic, and the "correct" continuation stops being the only defensible one.
      if ((startB - startA) * 2 === stepA) startB += 1;
      terms = [startA, startB, startA + stepA, startB + stepB, startA + 2 * stepA, startB + 2 * stepB];
      next = startA + 3 * stepA;
      wrong = [startB + 3 * stepB, next + stepB, terms[5]! + stepA, next - stepA];
    }

    const prompt = `What comes next in this sequence?\n\n\`${terms.join(", ")}, ?\``;
    return assembleNumeric(rng, seq, prompt, next, wrong);
  },
};

// ── inverse-rate: more of them means less time, not more ────────────────────

// Built so the numbers stay whole: N workers at T minutes is N*M*k of work, which M
// workers clear in N*k. The distractor everyone reaches for is the direct proportion.
const RATE_JOBS = [
  { actor: "pumps", task: "drain the tank" },
  { actor: "printers", task: "finish a print run" },
  { actor: "machines", task: "cut one batch of panels" },
  { actor: "packers", task: "pack a pallet" },
] as const;

const inverseRate: Generator = {
  id: "inverse-rate",
  category: "reasoning",
  generate(rng) {
    const job = pick(rng, RATE_JOBS);
    const workers = randInt(rng, 2, 9);
    let then = randInt(rng, 2, 9);
    if (then === workers) then = then === 9 ? 2 : then + 1;
    const k = randInt(rng, 1, 6);
    const minutes = then * k;
    const answer = workers * k;

    const direct = (minutes * then) / workers; // reading it as a direct proportion
    const wrong = [
      Number.isInteger(direct) ? direct : minutes + (then - workers),
      minutes,
      answer + k,
      answer - k,
    ];
    const prompt =
      `It takes ${workers} identical ${job.actor} ${minutes} minutes to ${job.task}. ` +
      `Working at the same rate, how long would ${then} of them take? Answer in minutes.`;
    return assembleNumeric(rng, inverseRate, prompt, answer, wrong);
  },
};

// ── set-overlap: inclusion-exclusion ────────────────────────────────────────

// Each pair carries its own closing clause so the verb agrees with the two it describes.
const OVERLAP_PAIRS = [
  {
    where: "a repair night",
    a: "brought a multimeter",
    b: "brought a soldering iron",
    all: "Everyone brought at least one of the two.",
  },
  {
    where: "a workshop",
    a: "had used a scope before",
    b: "had written firmware before",
    all: "Everyone had done at least one of the two.",
  },
  {
    where: "a club meet",
    a: "own a printer",
    b: "own a laser cutter",
    all: "Everyone owns at least one of the two.",
  },
] as const;

const setOverlap: Generator = {
  id: "set-overlap",
  category: "reasoning",
  generate(rng) {
    const pair = pick(rng, OVERLAP_PAIRS);
    const both = randInt(rng, 2, 8);
    const onlyA = randInt(rng, 3, 12);
    const onlyB = randInt(rng, 3, 12);
    const total = both + onlyA + onlyB;
    const a = both + onlyA;
    const b = both + onlyB;

    // Adding the two groups and forgetting the overlap is the whole failure mode.
    const wrong = [a + b, total - a, total - b, Math.abs(a - b)];
    const prompt =
      `Of ${total} people at ${pair.where}, ${a} ${pair.a} and ${b} ${pair.b}. ` +
      `${pair.all} How many are in both groups?`;
    return assembleNumeric(rng, setOverlap, prompt, both, wrong);
  },
};

// ── syllogism: what actually follows ────────────────────────────────────────

// All the category nouns start with a consonant, so every sentence takes "a" and the
// article never gives away which noun the question turns on.
const CATEGORY_PAIRS = [
  { sub: "sparrow", sup: "bird" },
  { sub: "pine", sup: "tree" },
  { sub: "hammer", sup: "tool" },
  { sub: "novel", sup: "book" },
  { sub: "salmon", sup: "fish" },
  { sub: "terrier", sup: "dog" },
  { sub: "sedan", sup: "car" },
  { sub: "ruby", sup: "gemstone" },
] as const;
const SUBJECT_NAMES = ["Kit", "Sam", "Alex", "Jo", "Max", "Nico", "Pat", "Lee"] as const;

// Two valid forms and two invalid ones, drawn 2:1 in favour of the valid pair. An even
// split would make "nothing follows" right half the time, and picking it blind would
// beat the question without reading the premises.
const SYLLOGISM_FORMS = ["tollens", "ponens", "tollens", "ponens", "affirming", "denying"] as const;

const syllogism: Generator = {
  id: "syllogism",
  category: "reasoning",
  generate(rng) {
    const { sub, sup } = pick(rng, CATEGORY_PAIRS);
    const who = pick(rng, SUBJECT_NAMES);
    const form = pick(rng, SYLLOGISM_FORMS);

    const isSub = `${who} is a ${sub}.`;
    const notSub = `${who} is not a ${sub}.`;
    const isSup = `${who} is a ${sup}.`;
    const notSup = `${who} is not a ${sup}.`;
    const openSub = `Nothing follows about whether ${who} is a ${sub}.`;
    const openSup = `Nothing follows about whether ${who} is a ${sup}.`;
    // Reading "every sub is a sup" backwards is the other classic slip, so it is on
    // offer every time.
    const converse = `Every ${sup} is a ${sub}.`;

    const cases = {
      tollens: { premise: notSup, correct: notSub, wrong: [isSub, openSub, converse] },
      ponens: { premise: isSub, correct: isSup, wrong: [notSup, openSup, converse] },
      affirming: { premise: isSup, correct: openSub, wrong: [isSub, notSub, converse] },
      denying: { premise: notSub, correct: openSup, wrong: [isSup, notSup, converse] },
    } as const;
    const { premise, correct, wrong } = cases[form];

    const prompt = `Every ${sub} is a ${sup}.\n${premise}\n\nWhich of these follows?`;
    return assemble(rng, syllogism, prompt, correct, [...wrong]);
  },
};

// ── ordering: a chain of comparisons ────────────────────────────────────────

const ORDER_TRAITS = [
  { more: "taller", less: "shorter", most: "tallest" },
  { more: "older", less: "younger", most: "oldest" },
  { more: "faster", less: "slower", most: "fastest" },
] as const;
const ORDER_LEAST = { tallest: "shortest", oldest: "youngest", fastest: "slowest" } as const;
const ORDER_NAMES = ["Ana", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Ines"] as const;

const ordering: Generator = {
  id: "ordering",
  category: "reasoning",
  generate(rng) {
    const trait = pick(rng, ORDER_TRAITS);
    const names = shuffle(rng, [...ORDER_NAMES]).slice(0, 4);

    // Only neighbouring pairs are stated, so the chain is the one order that fits, but
    // the statements are shuffled and half of them are phrased the other way round:
    // the work is assembling them, not reading one sentence.
    const statements = shuffle(
      rng,
      names.slice(0, 3).map((name, i) => {
        const lower = names[i + 1]!;
        return rng() < 0.5
          ? `${name} is ${trait.more} than ${lower}.`
          : `${lower} is ${trait.less} than ${name}.`;
      }),
    );

    const asked = pick(rng, ["most", "least", "second"] as const);
    const question =
      asked === "most"
        ? `Who is the ${trait.most}?`
        : asked === "least"
          ? `Who is the ${ORDER_LEAST[trait.most]}?`
          : `Who is second ${trait.most}?`;
    const correct = asked === "most" ? names[0]! : asked === "least" ? names[3]! : names[1]!;

    const prompt = `${statements.join("\n")}\n\n${question}`;
    return assemble(rng, ordering, prompt, correct, names.filter((n) => n !== correct));
  },
};

// ── word-index: read the instruction, then count ────────────────────────────

// No digits anywhere in a sentence, so the two indices are the only numbers in the
// prompt and nothing in the text can be mistaken for them.
const SENTENCES = [
  "the quick brown fox jumps over that lazy dog",
  "every solder joint needs heat before the wire moves",
  "please check whether your board still boots after flashing",
  "a broken cable looks exactly like working firmware from outside",
  "we should measure twice before cutting any panel again",
  "nobody reads manuals until something starts smoking on their desk",
  "several small mistakes compound into one very confusing failure",
  "keep spare fuses somewhere obvious inside your toolbox drawer",
] as const;

const wordIndex: Generator = {
  id: "word-index",
  category: "reasoning",
  generate(rng) {
    const sentence = pick(rng, SENTENCES);
    const words = sentence.split(" ");
    // Only words long enough to have an interesting interior are worth pointing at.
    const candidates = words.map((w, i) => ({ w, i })).filter(({ w }) => w.length >= 5);
    const chosen = pick(rng, candidates);
    const wordNo = chosen.i + 1;
    const letterNo = randInt(rng, 2, Math.min(chosen.w.length, 6));
    const correct = chosen.w[letterNo - 1]!;

    // Off-by-one on either axis first, then any other letter in the sentence, so there
    // are always three distinct wrong letters however short the word is.
    const neighbours = [
      chosen.w[letterNo - 2],
      chosen.w[letterNo],
      words[chosen.i - 1]?.[letterNo - 1],
      words[chosen.i + 1]?.[letterNo - 1],
    ];
    const filler = shuffle(rng, [...new Set(sentence.replace(/ /g, ""))]);
    const wrong = [...neighbours, ...filler].filter((c): c is string => c !== undefined);

    const prompt =
      `In the sentence below, what is letter ${letterNo} of word ${wordNo}?` +
      ` Count from the left, starting at one.\n\n\`${sentence}\``;
    return assemble(rng, wordIndex, prompt, correct, wrong);
  },
};

// ── table-lookup: read a table, then divide ─────────────────────────────────

const PLAN_NAMES = ["Bronze", "Silver", "Copper", "Slate", "Amber", "Cobalt", "Onyx"] as const;

// The table is built so the two answers you can reach without dividing are both wrong:
// the winner is never the cheapest row, and never the one with the largest storage.
const tableLookup: Generator = {
  id: "table-lookup",
  category: "reasoning",
  generate(rng) {
    const names = shuffle(rng, [...PLAN_NAMES]).slice(0, 4);
    const best = pick(rng, [14, 16, 18]);
    const winnerPrice = randInt(rng, 12, 20);
    // The top spender buys the most storage outright despite a worse rate, so "biggest
    // number in the storage column" is a trap rather than a shortcut.
    const spenderPrice = randInt(rng, 2 * winnerPrice + 4, 2 * winnerPrice + 20);
    const midPrice = randInt(rng, winnerPrice + 2, spenderPrice - 2);
    const cheapPrice = randInt(rng, 6, winnerPrice - 3);

    const rows = [
      { name: names[0]!, price: winnerPrice, rate: best },
      { name: names[1]!, price: spenderPrice, rate: best - 4 },
      { name: names[2]!, price: midPrice, rate: best - 6 },
      { name: names[3]!, price: cheapPrice, rate: best - 8 },
    ].map((r) => ({ name: r.name, price: r.price, storage: r.price * r.rate }));

    const table = [
      "Plan    Price  Storage",
      ...shuffle(rng, rows).map(
        (r) => `${r.name.padEnd(8)}${String(r.price).padStart(5)}${String(r.storage).padStart(9)}`,
      ),
    ].join("\n");
    const prompt =
      "```\n" +
      `${table}\n` +
      "```\n" +
      "Which plan gives the most storage for each pound spent?";
    return assemble(
      rng,
      tableLookup,
      prompt,
      rows[0]!.name,
      rows.slice(1).map((r) => r.name),
    );
  },
};

// ── multi-step: the last step changes what you are halving ──────────────────

// One shape, fully parameterised. The procedure is the thing being tested, so seeing
// it twice is no more of a leak than seeing long division twice.
const STOCK_ITEMS = ["boards", "enclosures", "spools", "relays", "sensors"] as const;

const multiStep: Generator = {
  id: "multi-step",
  category: "reasoning",
  generate(rng) {
    const item = pick(rng, STOCK_ITEMS);
    const start = randInt(rng, 30, 90);
    const sold = randInt(rng, 5, Math.floor(start / 3));
    let delivered = randInt(rng, 4, 30);
    if ((start - sold + delivered) % 2 !== 0) delivered += 1;
    const left = (start - sold + delivered) / 2;

    const wrong = [
      start - sold + delivered, // never halved
      Math.round((start - sold) / 2) + delivered, // halved before the delivery landed
      Math.round(start / 2) - sold + delivered, // halved the opening stock
      left + sold,
    ];
    const prompt =
      `A shelf holds ${start} ${item}. After ${sold} are sold, a delivery of ${delivered} arrives. ` +
      `Half of the ${item} now on the shelf are sold. How many are left on it?`;
    return assembleNumeric(rng, multiStep, prompt, left, wrong);
  },
};

export const GENERATORS: Generator[] = [
  seq,
  inverseRate,
  setOverlap,
  syllogism,
  ordering,
  wordIndex,
  tableLookup,
  multiStep,
];

// ── Quiz assembly ───────────────────────────────────────────────────────────

// Read the guild's category list. A typo must not silently disable the gate, so an
// empty or entirely unrecognised list falls back to every category rather than none.
export function parseCategories(raw: string): CheckCategory[] {
  const known = new Set<string>(CHECK_CATEGORIES);
  const wanted = raw
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => known.has(s)) as CheckCategory[];
  return wanted.length > 0 ? [...new Set(wanted)] : [...CHECK_CATEGORIES];
}

// Draw `count` questions, each from a different family, so one quiz cannot ask the same
// shape twice. Asking for more than there are families repeats rather than returning
// short: the config bound is the guard, not this.
export function buildQuiz(count: number, categories: CheckCategory[], rng: Rng): CheckQuestion[] {
  const allowed = GENERATORS.filter((g) => categories.includes(g.category));
  const pool = allowed.length > 0 ? allowed : GENERATORS;
  const out: CheckQuestion[] = [];
  let bag: Generator[] = [];
  for (let i = 0; i < count; i++) {
    if (bag.length === 0) bag = shuffle(rng, pool);
    out.push(bag.pop()!.generate(rng));
  }
  return out;
}
