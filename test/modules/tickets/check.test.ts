import { expect, test } from "bun:test";
import type { Guild, User } from "discord.js";
import type { AppContext } from "../../../src/core/context";
import { getCheckResult, recordCheckFail, recordCheckPass } from "../../../src/db/ticket-check";
import { CONFIG_KEYS } from "../../../src/lib/config";
import type { CheckQuestion } from "../../../src/lib/ticket-check";
import {
  answerSession,
  type Continuation,
  gateTicket,
  dropSession,
  getSession,
  newSession,
  putSession,
  readPolicy,
  sweepSessions,
} from "../../../src/modules/tickets/check";
import { silentContext } from "../../helpers/fakes";

test("readPolicy comes back with the registry defaults", () => {
  const ctx = silentContext();
  expect(readPolicy(ctx, "g")).toEqual({
    enabled: false,
    categories: ["reasoning"],
    questions: 3,
    required: 3,
    seconds: 180,
    passDays: 30,
    cooldownMinutes: 30,
    exemptStaff: true,
    exemptRoles: [],
  });
});

// Two independent knobs can be set to contradict each other, and "must get 5 of 3 right"
// is a gate nobody can pass. Clamping beats rejecting: the guild still gets a check.
test("readPolicy clamps the pass mark to the number of questions asked", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.ticketCheckQuestions, 2);
  ctx.config.set("g", CONFIG_KEYS.ticketCheckRequired, 5);
  expect(readPolicy(ctx, "g").required).toBe(2);
});

test("readPolicy keeps only real role IDs from the exempt list", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.ticketCheckExemptRoles, "123456789012345678, nope\n987654321098765432");
  expect(readPolicy(ctx, "g").exemptRoles).toEqual(["123456789012345678", "987654321098765432"]);
});


// ── session state machine ───────────────────────────────────────────────────

const question = (answerIndex: number): CheckQuestion => ({
  category: "reasoning",
  generatorId: "stub",
  prompt: "p",
  choices: ["a", "b", "c", "d"],
  answerIndex,
});

const NOW = 5_000_000;
const session = (answers: number[], seconds = 180) =>
  newSession({
    guildId: "g",
    userId: "u",
    questions: answers.map(question),
    seconds,
    continuation: { kind: "panel" },
    now: NOW,
  });

test("a right answer moves on to the next question", () => {
  const s = session([1, 2, 3]);
  expect(answerSession(s, 0, 1, 2, NOW + 1000)).toEqual({ kind: "next" });
  expect(s.current).toBe(1);
  expect(s.correct).toBe(1);
});

test("clearing the last question passes, with the score and how long it took", () => {
  const s = session([1, 2]);
  answerSession(s, 0, 1, 2, NOW + 1000);
  expect(answerSession(s, 1, 2, 2, NOW + 4000)).toEqual({
    kind: "passed",
    correct: 2,
    elapsedMs: 4000,
  });
});

// Asking the rest of the questions once the pass mark is out of reach wastes
// everyone's time, so a hopeless run ends where it goes wrong.
test("a run that can no longer reach the pass mark ends at once", () => {
  const s = session([1, 2, 3]);
  expect(answerSession(s, 0, 0, 3, NOW + 1000)).toEqual({ kind: "failed", correct: 0, reason: "wrong" });
});

test("a wrong answer that still leaves the mark reachable carries on", () => {
  const s = session([1, 2, 3]);
  expect(answerSession(s, 0, 0, 2, NOW + 1000)).toEqual({ kind: "next" });
  expect(s.correct).toBe(0);
});

test("the last answer decides it when the mark is still live", () => {
  const s = session([1, 2, 3]);
  answerSession(s, 0, 0, 2, NOW + 1000); // wrong, 2 of the remaining 2 now needed
  answerSession(s, 1, 2, 2, NOW + 2000); // right
  expect(answerSession(s, 2, 0, 2, NOW + 3000)).toEqual({
    kind: "failed",
    correct: 1,
    reason: "wrong",
  });
});

// The buttons on an already-answered message stay clickable until Discord repaints it.
test("clicking a question that has already been answered does nothing", () => {
  const s = session([1, 2, 3]);
  answerSession(s, 0, 1, 2, NOW + 1000);
  expect(answerSession(s, 0, 1, 2, NOW + 1100)).toEqual({ kind: "stale" });
  expect(s.current).toBe(1);
});

test("answering past the deadline fails as expired", () => {
  const s = session([1, 2], 60);
  expect(answerSession(s, 0, 1, 1, NOW + 61_000)).toEqual({
    kind: "failed",
    correct: 0,
    reason: "expired",
  });
});

// ── session store ───────────────────────────────────────────────────────────

test("a session is found by its token and only by its own owner", () => {
  const s = session([1]);
  putSession(s);
  expect(getSession(s.token)?.userId).toBe("u");
  dropSession(s.token);
  expect(getSession(s.token)).toBeUndefined();
});

test("starting a second check retires the first, so only one can be live", () => {
  const first = session([1]);
  putSession(first);
  const second = session([2]);
  putSession(second);
  expect(getSession(first.token)).toBeUndefined();
  expect(getSession(second.token)?.token).toBe(second.token);
  dropSession(second.token);
});

// Walking away has to cost the same as a wrong answer, or "open the panel, look at the
// questions, come back for a fresh set" is a free reroll.
test("an abandoned session is swept and counts as a failure", () => {
  const ctx = silentContext();
  const s = session([1], 60);
  putSession(s);
  sweepSessions(ctx, NOW + 59_000);
  expect(getSession(s.token)).toBeDefined();
  expect(getCheckResult(ctx.db, "g", "u")).toBeUndefined();

  sweepSessions(ctx, NOW + 61_000);
  expect(getSession(s.token)).toBeUndefined();
  expect(getCheckResult(ctx.db, "g", "u")).toEqual({
    passedAt: null,
    failedAt: NOW + 61_000,
    fails: 1,
  });
});

// ── gateTicket, against a stubbed guild ─────────────────────────────────────

const GUILD_ID = "g1";
const USER: User = { id: "u1", username: "kenny" } as unknown as User;

function stubGuild(opts: { manageGuild?: boolean; roles?: string[] } = {}): Guild {
  const member = {
    id: USER.id,
    permissions: { has: () => opts.manageGuild ?? false },
    roles: { cache: new Map((opts.roles ?? []).map((r) => [r, {}])) },
  };
  return {
    id: GUILD_ID,
    members: { fetch: async () => member },
  } as unknown as Guild;
}

function gatedContext(): AppContext {
  const ctx = silentContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckEnabled, true);
  return ctx;
}

const PANEL: Continuation = { kind: "panel" };

test("gateTicket lets everyone through while the check is off", async () => {
  const gate = await gateTicket(silentContext(), stubGuild(), USER, PANEL);
  expect(gate.kind).toBe("allow");
});

test("gateTicket answers a plain member with the first question", async () => {
  const gate = await gateTicket(gatedContext(), stubGuild(), USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected the member to be challenged");
  const json = JSON.stringify(gate.reply);
  expect(json).toContain("Question 1 of 3");
  // Four options, all tagged with the same session and question index.
  const ids = [...json.matchAll(/ticket_check:([0-9a-f]+):0:(\d)/g)];
  expect(ids.length).toBe(4);
  expect(new Set(ids.map((m) => m[1])).size).toBe(1);
  expect(ids.map((m) => m[2])).toEqual(["0", "1", "2", "3"]);
});

test("gateTicket exempts staff, unless the guild says otherwise", async () => {
  const ctx = gatedContext();
  expect((await gateTicket(ctx, stubGuild({ manageGuild: true }), USER, PANEL)).kind).toBe("allow");
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckExemptStaff, false);
  expect((await gateTicket(ctx, stubGuild({ manageGuild: true }), USER, PANEL)).kind).toBe("stop");
});

test("gateTicket exempts a configured role", async () => {
  const ctx = gatedContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckExemptRoles, "123456789012345678");
  const gate = await gateTicket(ctx, stubGuild({ roles: ["123456789012345678"] }), USER, PANEL);
  expect(gate.kind).toBe("allow");
});

test("gateTicket turns a live cooldown into a retry notice, not a question", async () => {
  const ctx = gatedContext();
  recordCheckFail(ctx.db, GUILD_ID, USER.id, Date.now());
  const gate = await gateTicket(ctx, stubGuild(), USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected the member to be held off");
  const json = JSON.stringify(gate.reply);
  expect(json).not.toContain("Question 1");
  expect(json).toContain("You can try again");
});

test("gateTicket lets a recent pass straight through", async () => {
  const ctx = gatedContext();
  recordCheckPass(ctx.db, GUILD_ID, USER.id, Date.now());
  expect((await gateTicket(ctx, stubGuild(), USER, PANEL)).kind).toBe("allow");
});
