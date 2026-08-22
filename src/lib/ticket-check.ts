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

export type CheckCategory = "reasoning" | "english";

// The one category that ships. Domain-specific sets (electronics, ESP32, comprehension)
// and any harder tier arrive as new entries here, which is why there is no difficulty
// knob: five calibrated variants of every generator would be five times the content for
// a dial that gets set once.
export const CHECK_CATEGORIES = ["reasoning", "english"] as const satisfies readonly CheckCategory[];

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
  { actor: "painters", task: "paint the hall" },
  { actor: "cleaners", task: "clean the office" },
  { actor: "bakers", task: "fill the order" },
  { actor: "printers", task: "finish the print run" },
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
    where: "a club night",
    a: "brought an umbrella",
    b: "brought a coat",
    all: "Everyone brought at least one of the two.",
  },
  {
    where: "a reunion",
    a: "had lived abroad",
    b: "had learned to drive",
    all: "Everyone had done at least one of the two.",
  },
  {
    where: "a village fair",
    a: "own a dog",
    b: "own a cat",
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
  "every winter morning starts colder than the last one did",
  "please check whether the back door locked before leaving",
  "a quiet street looks completely different after heavy rain",
  "we should measure twice before cutting anything at all",
  "nobody reads instructions until something goes badly wrong",
  "several small mistakes compound into one very confusing muddle",
  "keep spare batteries somewhere obvious inside the kitchen drawer",
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
    // Prices in fives, so each row's storage-per-pound is a division worth attempting
    // rather than long division against the clock.
    const winnerPrice = randInt(rng, 3, 4) * 5;
    // The top spender buys the most storage outright despite a worse rate, so "biggest
    // number in the storage column" is a trap rather than a shortcut.
    const spenderPrice = randInt(rng, 2 * winnerPrice / 5 + 1, 2 * winnerPrice / 5 + 4) * 5;
    const midPrice = randInt(rng, winnerPrice / 5 + 1, spenderPrice / 5 - 1) * 5;
    const cheapPrice = randInt(rng, 1, winnerPrice / 5 - 1) * 5;

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
const STOCK_ITEMS = ["mugs", "plates", "books", "jars", "tins"] as const;

const multiStep: Generator = {
  id: "multi-step",
  category: "reasoning",
  generate(rng) {
    const item = pick(rng, STOCK_ITEMS);
    // Multiples of ten and five throughout: the question is whether you halve what is on
    // the shelf AFTER the delivery, not whether you can subtract 7 from 63 under a clock.
    const start = randInt(rng, 3, 8) * 10;
    const soldFives = randInt(rng, 1, Math.floor(start / 20));
    const sold = soldFives * 5;
    // What is left has to halve cleanly, and start is already even, so the delivery takes
    // the same parity as the sale: both odd multiples of five, or both even.
    const delivered = (randInt(rng, 1, 3) * 2 - (soldFives % 2)) * 5;
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

// ── english: can they read an instruction and write a sentence ───────────────
//
// Tickets are answered in English by a couple of people, so a request nobody can act on
// costs more time than it saves. These test the English actually needed to do that: read
// a rule and act on it, and put a sentence together. They are frames rather than
// arithmetic, so correctness lives in the data below and the tests check it holds.

// Agreement: one verb form fits the subject, the rest do not. The predicate travels with
// the verb set so every option is a real sentence apart from the grammar being tested.
// The wrong forms sit close in length to the right one, so the shortest or longest option
// is no guide to which it is. "had" and the like are left out on purpose: they would make
// a perfectly correct sentence and there would be two right answers.
const AGREEMENT_SETS = [
  { singular: "is", plural: "are", others: ["be", "am"], tail: ["on the table.", "in the drawer.", "still missing."] },
  { singular: "was", plural: "were", others: ["been", "is"], tail: ["there yesterday.", "in the drawer.", "missing all week."] },
  { singular: "has", plural: "have", others: ["haves", "having"], tail: ["arrived.", "gone missing.", "turned up again."] },
  { singular: "does", plural: "do", others: ["doing", "done"], tail: ["not fit.", "not belong here."] },
] as const;
const AGREEMENT_SUBJECTS = [
  { singular: "The parcel", plural: "The parcels" },
  { singular: "This box", plural: "These boxes" },
  { singular: "My key", plural: "My keys" },
  { singular: "That letter", plural: "Those letters" },
] as const;

const agreement: Generator = {
  id: "agreement",
  category: "english",
  generate(rng) {
    const set = pick(rng, AGREEMENT_SETS);
    const subject = pick(rng, AGREEMENT_SUBJECTS);
    const tail = pick(rng, set.tail);
    const plural = rng() < 0.5;
    const noun = plural ? subject.plural : subject.singular;
    const right = plural ? set.plural : set.singular;
    const wrongVerb = plural ? set.singular : set.plural;

    const sentence = (verb: string) => `${noun} ${verb} ${tail}`;
    return assemble(rng, agreement, "Which sentence is written correctly?", sentence(right), [
      sentence(wrongVerb),
      ...set.others.map(sentence),
    ]);
  },
};

// Word choice: the confusions that make a ticket unreadable, each with its own set of
// look-alikes rather than random words, so the wrong options are the ones people reach for.
const WORD_FRAMES = [
  { text: "Check ___ spelling before you post it.", correct: "your", wrong: ["you're", "yours", "your's"] },
  { text: "___ going to need more detail than that.", correct: "You're", wrong: ["Your", "Yours", "Youre"] },
  { text: "The shop lost ___ licence last year.", correct: "its", wrong: ["it's", "its'", "their"] },
  { text: "___ been like this since Tuesday.", correct: "It's", wrong: ["Its", "Its'", "It"] },
  { text: "Put the key back where ___ was.", correct: "it", wrong: ["its", "it's", "they"] },
  { text: "The forms are over ___ on the desk.", correct: "there", wrong: ["their", "they're", "theirs"] },
  { text: "___ all saying exactly the same thing.", correct: "They're", wrong: ["Their", "There", "Theirs"] },
  { text: "This one costs more ___ the old one.", correct: "than", wrong: ["then", "that", "as"] },
  { text: "Read it first, ___ decide what to do.", correct: "then", wrong: ["than", "when", "so"] },
  { text: "The weather will ___ the results.", correct: "affect", wrong: ["effect", "affects", "affected"] },
  { text: "I have ___ that three times already.", correct: "tried", wrong: ["try", "trying", "tryed"] },
  { text: "The handle has ___ loose again.", correct: "come", wrong: ["came", "coming", "comed"] },
  { text: "Nothing has ___ since last week.", correct: "changed", wrong: ["change", "changing", "changen"] },
  { text: "I should have ___ the notice first.", correct: "read", wrong: ["readed", "reading", "reads"] },
] as const;

const wordChoice: Generator = {
  id: "word-choice",
  category: "english",
  generate(rng) {
    const frame = pick(rng, WORD_FRAMES);
    const prompt = `Which word completes this sentence?\n\n\`${frame.text}\``;
    return assemble(rng, wordChoice, prompt, frame.correct, [...frame.wrong]);
  },
};

// Meaning: a rule, and what it actually tells you to do. This is the one that matters for
// support, since every instruction in the pinned posts is a sentence like these.
const MEANING_FRAMES = [
  {
    rule: "Do not open the {thing} while the machine is running.",
    correct: "Stop the machine running before opening the {thing}.",
    wrong: [
      "Open the {thing} first, then start the machine up.",
      "The {thing} must never be opened at all.",
      "The machine has to be running when the {thing} opens.",
    ],
    slots: ["lid", "panel", "hatch", "side door"],
  },
  {
    rule: "You only need the {thing} if the room did not come with one.",
    correct: "A room that already came with one needs no {thing}.",
    wrong: [
      "Every room needs a {thing} brought into it regardless.",
      "No room needs a {thing} brought into it.",
      "A room that came with one still needs a spare {thing}.",
    ],
    slots: ["kettle", "heater", "lamp"],
  },
  {
    rule: "Send the whole file unless it has your password in it.",
    correct: "Send the whole file, unless your password is in it.",
    wrong: [
      "Send the whole file even when your password is in it.",
      "Never send the file, password in it or not.",
      "Send the file only when your password is in it.",
    ],
    slots: [],
  },
  {
    rule: "The {thing} fits every model except the first one.",
    correct: "It fits all of the models but the very first.",
    wrong: [
      "It fits the first model and none of the rest.",
      "It fits none of the models at all.",
      "It fits every model that came before this one.",
    ],
    slots: ["charger", "cover", "stand"],
  },
  {
    rule: "Restart it before asking, unless it will not turn on.",
    correct: "Restart first, unless the thing is completely dead.",
    wrong: [
      "Restart first, whatever state the thing is in now.",
      "Never restart it before asking about a problem.",
      "Restart only the ones that will not turn on now.",
    ],
    slots: [],
  },
] as const;

const meaning: Generator = {
  id: "meaning",
  category: "english",
  generate(rng) {
    const frame = pick(rng, MEANING_FRAMES);
    const thing = frame.slots.length ? pick(rng, frame.slots) : "";
    const fill = (text: string) => text.replace(/\{thing\}/g, thing);
    const prompt = `What does this tell you to do?\n\n\`${fill(frame.rule)}\``;
    return assemble(rng, meaning, prompt, fill(frame.correct), frame.wrong.map(fill));
  },
};

// Spelling: the one English check nothing but knowing the word will get you through.
// Every option is the same word, so length, wordiness and plausibility are all useless.
// No misspelling here is a real word in its own right, or there would be two answers.
const SPELLING_WORDS = [
  { correct: "receive", wrong: ["recieve", "receeve", "reciave"] },
  { correct: "separate", wrong: ["seperate", "seperete", "sepparate"] },
  { correct: "definitely", wrong: ["definately", "definetly", "definitley"] },
  { correct: "occurred", wrong: ["occured", "ocurred", "occurrd"] },
  { correct: "necessary", wrong: ["neccessary", "necesary", "neccesary"] },
  { correct: "until", wrong: ["untill", "untl", "unitl"] },
  { correct: "believe", wrong: ["beleive", "belive", "beleve"] },
  { correct: "calendar", wrong: ["calender", "calandar", "calendor"] },
  { correct: "probably", wrong: ["probaly", "probbably", "probablly"] },
  { correct: "especially", wrong: ["expecially", "especialy", "escpecially"] },
  { correct: "length", wrong: ["lenght", "lengh", "lenthg"] },
  { correct: "successful", wrong: ["succesful", "successfull", "sucessful"] },
  { correct: "immediately", wrong: ["immediatly", "imediately", "immediatley"] },
  { correct: "environment", wrong: ["enviroment", "envirnoment", "environmnet"] },
  { correct: "argument", wrong: ["arguement", "arguemnt", "argumnet"] },
  { correct: "beginning", wrong: ["begining", "beginnning", "begginning"] },
] as const;

const spelling: Generator = {
  id: "spelling",
  category: "english",
  generate(rng) {
    const word = pick(rng, SPELLING_WORDS);
    return assemble(rng, spelling, "Which of these is spelled correctly?", word.correct, [
      ...word.wrong,
    ]);
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
  agreement,
  wordChoice,
  meaning,
  spelling,
];

// ── Quiz assembly ───────────────────────────────────────────────────────────

// Read the guild's category list, as the picker stores it or as it was typed in before
// the picker existed. Picking none must not silently disable the gate, so an empty or
// entirely unrecognised list falls back to every category rather than none.
export function parseCategories(raw: string[] | string | undefined): CheckCategory[] {
  const known = new Set<string>(CHECK_CATEGORIES);
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(/[,\n]/);
  const wanted = parts
    .map((s) => s.trim().toLowerCase())
    .filter((s) => known.has(s)) as CheckCategory[];
  return wanted.length > 0 ? [...new Set(wanted)] : [...CHECK_CATEGORIES];
}

// Draw `count` questions, each from a different family, so one quiz cannot ask the same
// shape twice. Asking for more than there are families repeats rather than returning
// short: the config bound is the guard, not this.
//
// Categories take turns rather than sharing one pool. Reasoning has twice the families
// English does, so a straight draw would leave a three-question check with no English in
// it about a third of the time, and a category that is on should actually turn up.
export function buildQuiz(count: number, categories: CheckCategory[], rng: Rng): CheckQuestion[] {
  const bags = new Map<CheckCategory, Generator[]>();
  const live = shuffle(
    rng,
    categories.filter((c) => GENERATORS.some((g) => g.category === c)),
  );
  const order = live.length > 0 ? live : [...CHECK_CATEGORIES];

  const out: CheckQuestion[] = [];
  for (let i = 0; i < count; i++) {
    const category = order[i % order.length]!;
    let bag = bags.get(category);
    if (!bag || bag.length === 0) {
      bag = shuffle(rng, GENERATORS.filter((g) => g.category === category));
      bags.set(category, bag);
    }
    out.push(bag.pop()!.generate(rng));
  }
  return out;
}

// ── Gate ────────────────────────────────────────────────────────────────────

// The guild's check settings, read once per gate evaluation. `required` is already
// clamped to `questions` by the time it gets here.
export interface CheckPolicy {
  enabled: boolean;
  categories: CheckCategory[];
  questions: number;
  required: number;
  seconds: number;
  passDays: number;
  cooldownMinutes: number;
  exemptStaff: boolean;
  exemptRoles: string[];
  // Shown above the first question only. Empty means the generated line stands alone.
  introText: string;
}

// What a member's past attempts amount to. Owned here rather than in the db layer
// because the gate is what gives the three fields their meaning.
export interface CheckResult {
  passedAt: number | null;
  failedAt: number | null;
  // Consecutive failures, reset by a pass. The mod-log reports it, so it has to mean
  // "keeps failing" rather than "has ever failed".
  fails: number;
}

export type GateDecision =
  | { kind: "allow"; reason: "disabled" | "exempt" | "recent-pass" }
  | { kind: "cooldown"; until: number }
  | { kind: "challenge" };

// Decide whether this member has to sit the check. Order matters: a live pass is
// honoured before a live cooldown, which can only happen if an admin shortened the pass
// window since, and bouncing someone who demonstrably passed would be the wrong call.
export function gateDecision(
  policy: CheckPolicy,
  input: {
    isStaff: boolean;
    roleIds: string[];
    result?: CheckResult | undefined;
    now: number;
  },
): GateDecision {
  if (!policy.enabled) return { kind: "allow", reason: "disabled" };
  if (policy.exemptStaff && input.isStaff) return { kind: "allow", reason: "exempt" };
  if (input.roleIds.some((id) => policy.exemptRoles.includes(id))) {
    return { kind: "allow", reason: "exempt" };
  }

  const { passedAt, failedAt } = input.result ?? { passedAt: null, failedAt: null };
  if (policy.passDays > 0 && passedAt !== null) {
    if (input.now - passedAt < policy.passDays * 86_400_000) {
      return { kind: "allow", reason: "recent-pass" };
    }
  }
  if (failedAt !== null) {
    const until = failedAt + policy.cooldownMinutes * 60_000;
    if (input.now < until) return { kind: "cooldown", until };
  }
  return { kind: "challenge" };
}
