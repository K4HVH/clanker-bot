import { expect, test } from "bun:test";
import type { CheckPolicy } from "../../src/lib/ticket-check";
import {
  buildQuiz,
  CHECK_CATEGORIES,
  gateDecision,
  GENERATORS,
  makeRng,
  parseCategories,
} from "../../src/lib/ticket-check";

test("makeRng is deterministic per seed and stays in [0,1)", () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  const first = [a(), a(), a(), a()];
  expect(first).toEqual([b(), b(), b(), b()]);
  for (const v of first) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

test("makeRng diverges on a different seed", () => {
  const a = makeRng(1);
  const b = makeRng(2);
  expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
});

// ── Shared invariants, run over every registered generator ───────────────────

const SEEDS = 2000;

test("every generator emits four distinct, button-sized choices with a valid key", () => {
  for (const gen of GENERATORS) {
    for (let seed = 0; seed < SEEDS; seed++) {
      const q = gen.generate(makeRng(seed));
      const where = `${gen.id} seed ${seed}`;
      expect(q.prompt.trim().length, where).toBeGreaterThan(0);
      expect(q.choices.length, where).toBe(4);
      expect(new Set(q.choices).size, where).toBe(4);
      expect(q.answerIndex, where).toBeGreaterThanOrEqual(0);
      expect(q.answerIndex, where).toBeLessThan(4);
      for (const choice of q.choices) {
        expect(choice.trim().length, where).toBeGreaterThan(0);
        expect(choice.length, where).toBeLessThanOrEqual(80); // Discord button label cap
      }
    }
  }
});

// If the key sat in the same slot every time, "always click the first button" would
// beat the gate outright.
test("every generator spreads the answer across all four slots", () => {
  for (const gen of GENERATORS) {
    const slots = new Map([0, 1, 2, 3].map((i) => [i, 0]));
    for (let seed = 0; seed < 400; seed++) {
      const { answerIndex } = gen.generate(makeRng(seed));
      slots.set(answerIndex, slots.get(answerIndex)! + 1);
    }
    for (const count of slots.values()) expect(count, gen.id).toBeGreaterThan(400 / 8);
  }
});

// ── seq ─────────────────────────────────────────────────────────────────────

// Rules a reader could plausibly apply, each needing enough shown terms to be worth
// considering. The generated sequence has to be consistent with exactly one prediction:
// if two rules fit the shown terms and disagree on the next one, the question is unfair
// however "correct" its own key is.
function seqPredictions(terms: number[]): number[] {
  const out: number[] = [];
  const n = terms.length;
  const diffs = terms.slice(1).map((t, i) => t - terms[i]!);
  const last = terms[n - 1]!;
  if (n >= 3 && diffs.every((d) => d === diffs[0])) out.push(last + diffs[0]!);
  if (n >= 3 && terms.every((t) => t !== 0)) {
    const ratios = terms.slice(1).map((t, i) => t / terms[i]!);
    if (ratios.every((r) => r === ratios[0])) out.push(last * ratios[0]!);
  }
  if (n >= 4) {
    const second = diffs.slice(1).map((d, i) => d - diffs[i]!);
    if (second.length >= 2 && second.every((s) => s === second[0]) && second[0] !== 0) {
      out.push(last + diffs[diffs.length - 1]! + second[0]!);
    }
  }
  if (n >= 6) {
    const evens = terms.filter((_, i) => i % 2 === 0);
    const odds = terms.filter((_, i) => i % 2 === 1);
    const step = (xs: number[]) => {
      const ds = xs.slice(1).map((x, i) => x - xs[i]!);
      return ds.every((d) => d === ds[0]) ? ds[0]! : null;
    };
    const [se, so] = [step(evens), step(odds)];
    if (se !== null && so !== null && se !== so) {
      const source = n % 2 === 0 ? evens : odds;
      out.push(source[source.length - 1]! + (n % 2 === 0 ? se : so));
    }
  }
  return out;
}

test("seq: the key is the only continuation the shown terms support", () => {
  const seq = GENERATORS.find((g) => g.id === "seq")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = seq.generate(makeRng(seed));
    const terms = [...q.prompt.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
    const predictions = seqPredictions(terms);
    const where = `seed ${seed}: ${q.prompt}`;
    expect(predictions.length, where).toBeGreaterThan(0);
    expect(new Set(predictions).size, where).toBe(1); // no ambiguity
    expect(Number(q.choices[q.answerIndex]), where).toBe(predictions[0]!);
  }
});

// ── inverse-rate / set-overlap ──────────────────────────────────────────────

// Both re-derive the answer straight from the numbers in the prompt, so a generator
// that keys the wrong value cannot agree with its own question.
const numbersIn = (prompt: string) => [...prompt.matchAll(/\d+/g)].map((m) => Number(m[0]));

test("inverse-rate: the key is the inverse-proportion answer, always whole", () => {
  const gen = GENERATORS.find((g) => g.id === "inverse-rate")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const [workers, minutes, then] = numbersIn(q.prompt);
    const where = `seed ${seed}: ${q.prompt}`;
    expect(workers, where).toBeDefined();
    const expected = (workers! * minutes!) / then!;
    expect(Number.isInteger(expected), where).toBe(true);
    expect(Number(q.choices[q.answerIndex]), where).toBe(expected);
    // The whole point of the question: the direct-proportion answer must be wrong.
    expect(expected, where).not.toBe((minutes! * then!) / workers!);
  }
});

test("set-overlap: the key is inclusion-exclusion and the figures are consistent", () => {
  const gen = GENERATORS.find((g) => g.id === "set-overlap")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const [total, first, second] = numbersIn(q.prompt);
    const where = `seed ${seed}: ${q.prompt}`;
    const both = first! + second! - total!;
    expect(both, where).toBeGreaterThan(0);
    expect(both, where).toBeLessThanOrEqual(Math.min(first!, second!));
    expect(first!, where).toBeLessThan(total!);
    expect(second!, where).toBeLessThan(total!);
    expect(Number(q.choices[q.answerIndex]), where).toBe(both);
  }
});

// ── syllogism ───────────────────────────────────────────────────────────────

// Re-derives the conclusion from the two premises as parsed off the prompt, so the
// generator and the test never share a view of which form was rolled.
function syllogismAnswer(prompt: string): string {
  const lines = prompt.split("\n").map((l) => l.trim());
  const rule = lines.find((l) => l.startsWith("Every"))!.match(/^Every (\w+) is a (\w+)\.$/)!;
  const [, sub, sup] = rule;
  const fact = lines
    .map((l) => l.match(/^(\w+) is (not )?a (\w+)\.$/))
    .find((m) => m !== null && m[1] !== "Every")!;
  const [, who, negated, term] = fact;
  const no = negated !== undefined;
  if (term === sup && no) return `${who} is not a ${sub}.`; // modus tollens
  if (term === sub && !no) return `${who} is a ${sup}.`; // modus ponens
  if (term === sup && !no) return `Nothing follows about whether ${who} is a ${sub}.`;
  return `Nothing follows about whether ${who} is a ${sup}.`;
}

test("syllogism: the key is the conclusion the premises actually license", () => {
  const gen = GENERATORS.find((g) => g.id === "syllogism")!;
  let nothingFollows = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const expected = syllogismAnswer(q.prompt);
    expect(q.choices[q.answerIndex], `seed ${seed}: ${q.prompt}`).toBe(expected);
    if (expected.startsWith("Nothing")) nothingFollows++;
  }
  // "Nothing follows" is offered every time, so if it were usually right, always picking
  // it would beat the question without reading it.
  expect(nothingFollows / SEEDS).toBeLessThan(0.4);
});

// ── ordering ────────────────────────────────────────────────────────────────

test("ordering: the statements pin down one order and the key matches it", () => {
  const gen = GENERATORS.find((g) => g.id === "ordering")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const where = `seed ${seed}: ${q.prompt}`;
    // Each statement is "X is <more> than Y"; build the strict order from the chain.
    const above = new Map<string, string>();
    const below = new Map<string, string>();
    for (const line of q.prompt.split("\n")) {
      const m = line.trim().match(/^(\w+) is (\w+) than (\w+)\.$/);
      if (!m) continue;
      const [, left, comparative, right] = m;
      const flipped = /^(shorter|younger|slower)$/.test(comparative!);
      const [top, bottom] = flipped ? [right!, left!] : [left!, right!];
      above.set(bottom, top);
      below.set(top, bottom);
    }
    const first = [...below.keys()].find((k) => !above.has(k))!;
    const order = [first];
    while (below.has(order[order.length - 1]!)) order.push(below.get(order[order.length - 1]!)!);
    expect(new Set(order).size, where).toBe(order.length);
    expect(order.length, where).toBeGreaterThanOrEqual(4); // every name is placed

    const asked = q.prompt.split("\n").pop()!;
    const rank = asked.includes("second")
      ? 1
      : /shortest|youngest|slowest/.test(asked)
        ? order.length - 1
        : 0;
    expect(q.choices[q.answerIndex], `${where} :: ${order.join(">")}`).toBe(order[rank]!);
  }
});

// ── word-index / table-lookup / multi-step ──────────────────────────────────

test("word-index: the key is the letter the prompt points at", () => {
  const gen = GENERATORS.find((g) => g.id === "word-index")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const where = `seed ${seed}: ${q.prompt}`;
    const [letterNo, wordNo] = numbersIn(q.prompt);
    const sentence = q.prompt.match(/`([^`]+)`/)![1]!;
    const word = sentence.split(" ")[wordNo! - 1]!;
    expect(word, where).toBeDefined();
    expect(word.length, where).toBeGreaterThanOrEqual(letterNo!);
    expect(q.choices[q.answerIndex], where).toBe(word[letterNo! - 1]!);
  }
});

test("table-lookup: the key is the best ratio, and never the lazy row", () => {
  const gen = GENERATORS.find((g) => g.id === "table-lookup")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const where = `seed ${seed}: ${q.prompt}`;
    const rows = [...q.prompt.matchAll(/^(\w+) +(\d+) +(\d+)$/gm)].map((m) => ({
      name: m[1]!,
      price: Number(m[2]),
      storage: Number(m[3]),
    }));
    expect(rows.length, where).toBe(4);
    const ratio = (r: (typeof rows)[number]) => r.storage / r.price;
    const best = [...rows].sort((a, b) => ratio(b) - ratio(a));
    expect(ratio(best[0]!), where).toBeGreaterThan(ratio(best[1]!)); // one clear winner
    expect(q.choices[q.answerIndex], where).toBe(best[0]!.name);
    // Neither "cheapest" nor "biggest number" can be right, or the table is decoration.
    const cheapest = [...rows].sort((a, b) => a.price - b.price)[0]!;
    const biggest = [...rows].sort((a, b) => b.storage - a.storage)[0]!;
    expect(best[0]!.name, where).not.toBe(cheapest.name);
    expect(best[0]!.name, where).not.toBe(biggest.name);
  }
});

test("multi-step: the key survives every step, in order", () => {
  const gen = GENERATORS.find((g) => g.id === "multi-step")!;
  for (let seed = 0; seed < SEEDS; seed++) {
    const q = gen.generate(makeRng(seed));
    const where = `seed ${seed}: ${q.prompt}`;
    const [start, sold, delivered] = numbersIn(q.prompt);
    const left = (start! - sold! + delivered!) / 2;
    expect(Number.isInteger(left), where).toBe(true);
    expect(sold!, where).toBeLessThan(start!);
    expect(Number(q.choices[q.answerIndex]), where).toBe(left);
    // The trap only works if skipping the last step lands on a different number.
    expect(left, where).not.toBe(start! - sold! + delivered!);
  }
});

// ── quiz assembly ───────────────────────────────────────────────────────────

test("buildQuiz returns the asked-for count without repeating a family", () => {
  const quiz = buildQuiz(3, ["reasoning"], makeRng(7));
  expect(quiz.length).toBe(3);
  expect(new Set(quiz.map((q) => q.generatorId)).size).toBe(3);
});

test("buildQuiz varies which families come up", () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 50; seed++) {
    for (const q of buildQuiz(3, ["reasoning"], makeRng(seed))) seen.add(q.generatorId);
  }
  expect(seen.size).toBe(GENERATORS.length);
});

test("parseCategories keeps known ids and falls back when none survive", () => {
  expect(parseCategories("reasoning")).toEqual(["reasoning"]);
  expect(parseCategories(" REASONING , nonsense ")).toEqual(["reasoning"]);
  // A typo must not quietly switch the gate off: every category is better than none.
  expect(parseCategories("")).toEqual([...CHECK_CATEGORIES]);
  expect(parseCategories("nonsense")).toEqual([...CHECK_CATEGORIES]);
});

test("buildQuiz only draws from the categories it is given", () => {
  const quiz = buildQuiz(5, ["reasoning"], makeRng(3));
  for (const q of quiz) expect(q.category).toBe("reasoning");
});


// ── gate decision ───────────────────────────────────────────────────────────

const POLICY: CheckPolicy = {
  enabled: true,
  categories: ["reasoning"],
  questions: 3,
  required: 3,
  seconds: 180,
  passDays: 30,
  cooldownMinutes: 30,
  exemptStaff: true,
  exemptRoles: [],
  introText: "",
};
const NOW = 1_000_000_000;
const DAY = 86_400_000;
const decide = (policy: Partial<CheckPolicy>, input: Partial<Parameters<typeof gateDecision>[1]>) =>
  gateDecision({ ...POLICY, ...policy }, { isStaff: false, roleIds: [], now: NOW, ...input });

test("gate is open while the feature is off", () => {
  expect(decide({ enabled: false }, {})).toEqual({ kind: "allow", reason: "disabled" });
});

test("gate exempts staff only while that is switched on", () => {
  expect(decide({}, { isStaff: true })).toEqual({ kind: "allow", reason: "exempt" });
  expect(decide({ exemptStaff: false }, { isStaff: true })).toEqual({ kind: "challenge" });
});

test("gate exempts the configured roles", () => {
  expect(decide({ exemptRoles: ["r1"] }, { roleIds: ["r9", "r1"] })).toEqual({
    kind: "allow",
    reason: "exempt",
  });
  expect(decide({ exemptRoles: ["r1"] }, { roleIds: ["r9"] })).toEqual({ kind: "challenge" });
});

test("a pass stays good until its window runs out", () => {
  const passed = (ago: number) => ({ result: { passedAt: NOW - ago, failedAt: null, fails: 0 } });
  expect(decide({}, passed(29 * DAY))).toEqual({ kind: "allow", reason: "recent-pass" });
  expect(decide({}, passed(31 * DAY))).toEqual({ kind: "challenge" });
  // Zero days means every ticket is gated, however recently they passed.
  expect(decide({ passDays: 0 }, passed(1000))).toEqual({ kind: "challenge" });
});

test("a failure blocks until the cooldown lifts", () => {
  const failed = (ago: number) => ({ result: { passedAt: null, failedAt: NOW - ago, fails: 1 } });
  expect(decide({}, failed(10 * 60_000))).toEqual({
    kind: "cooldown",
    until: NOW - 10 * 60_000 + 30 * 60_000,
  });
  expect(decide({}, failed(31 * 60_000))).toEqual({ kind: "challenge" });
});

// Someone who passed recently cannot also be inside a cooldown unless an admin shortened
// the pass window under them, and in that case the pass is the fairer of the two.
test("a live pass beats a live cooldown", () => {
  expect(decide({}, { result: { passedAt: NOW - 1000, failedAt: NOW - 1000, fails: 1 } })).toEqual({
    kind: "allow",
    reason: "recent-pass",
  });
});

test("a member with no history is challenged", () => {
  expect(decide({}, {})).toEqual({ kind: "challenge" });
});
