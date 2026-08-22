import { beforeEach, expect, test } from "bun:test";
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  ModalSubmitInteraction,
  User,
} from "discord.js";
import { ComponentRouter } from "../../../src/core/component-router";
import type { AppContext } from "../../../src/core/context";
import { getCheckResult, recordCheckFail, recordCheckPass } from "../../../src/db/ticket-check";
import { ticketsModule } from "../../../src/modules/tickets";
import { CONFIG_KEYS } from "../../../src/lib/config";
import type { CheckQuestion } from "../../../src/lib/ticket-check";
import {
  answerSession,
  clearCheckSession,
  type Continuation,
  gateTicket,
  takePassNote,
  dropSession,
  getSession,
  newSession,
  putSession,
  readPolicy,
  sessionFor,
  sweepSessions,
} from "../../../src/modules/tickets/check";
import { silentContext } from "../../helpers/fakes";

test("readPolicy comes back with the registry defaults", () => {
  const ctx = silentContext();
  expect(readPolicy(ctx, "g")).toEqual({
    enabled: false,
    categories: ["reasoning", "english"],
    questions: 3,
    required: 3,
    seconds: 180,
    passDays: 30,
    cooldownMinutes: 30,
    exemptStaff: true,
    exemptRoles: [],
    introText:
      "You need to pass a short intelligence check before you can open a ticket. Tickets are handled by a small team, so they're kept for the problems that need one. Read each question carefully.",
  });
});

// An empty default would mean every guild that never touches this setting shows people a
// bare question with no word about why they are being asked anything.
test("the intro text ships with something to say", () => {
  expect(readPolicy(silentContext(), "g").introText.trim().length).toBeGreaterThan(0);
});

test("readPolicy reads the category list, falling back when it is nonsense", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.ticketCheckCategories, ["electronics"]);
  expect(readPolicy(ctx, "g").categories).toEqual(["reasoning", "english"]);
  ctx.config.set("g", CONFIG_KEYS.ticketCheckCategories, ["english"]);
  expect(readPolicy(ctx, "g").categories).toEqual(["english"]);
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
  // You only have a check open if the guild has the feature on.
  ctx.config.set("g", CONFIG_KEYS.ticketCheckEnabled, true);
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

// Resolves per id, so the member running a staff command is not mistaken for the member
// it is being run ON. "staff" always holds Manage Server; the flag covers everyone else.
function stubGuild(opts: { manageGuild?: boolean; roles?: string[] } = {}): Guild {
  return {
    id: GUILD_ID,
    members: {
      fetch: async (id: string) => ({
        id,
        permissions: { has: () => id === "staff" || (opts.manageGuild ?? false) },
        roles: { cache: new Map((id === USER.id ? (opts.roles ?? []) : []).map((r) => [r, {}])) },
      }),
    },
  } as unknown as Guild;
}

function gatedContext(): AppContext {
  const ctx = silentContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckEnabled, true);
  return ctx;
}

const PANEL: Continuation = { kind: "panel" };

// The session store is module state, and a check now RESUMES rather than being replaced,
// so one test's abandoned quiz would otherwise be handed to the next.
beforeEach(() => {
  const live = sessionFor(GUILD_ID, USER.id);
  if (live) dropSession(live.token);
});

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

// ── the subject modal, and which message it is allowed to touch ─────────────

function fakeModal(customId: string) {
  const calls: string[] = [];
  const guild = {
    id: GUILD_ID,
    name: "Test",
    roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" } },
    client: { user: { id: "bot" } },
    // Creation failing is fine here: the assertion is about how the interaction was
    // answered, not about the ticket itself.
    channels: {
      create: async () => {
        throw new Error("no channels in a test");
      },
    },
  };
  const interaction = {
    customId,
    guild,
    user: USER,
    replied: false,
    deferred: false,
    fields: { fields: new Map() },
    isButton: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    deferReply: async () => void calls.push("deferReply"),
    deferUpdate: async () => void calls.push("deferUpdate"),
    editReply: async () => void calls.push("editReply"),
  };
  return { interaction, calls };
}

const route = async (customId: string) => {
  const { interaction, calls } = fakeModal(customId);
  const router = new ComponentRouter(ticketsModule.components ?? [], silentContext());
  await router.handle(interaction as unknown as ModalSubmitInteraction);
  return calls;
};

// A modal opened from ANY message component arrives with that component's message
// attached, so the panel button's modal carries the PUBLIC panel message. Answering it
// with an update would rewrite the panel itself and leave the server with no button.
test("the panel's subject modal replies, and never edits the panel message", async () => {
  const calls = await route("ticket_modal");
  expect(calls).toContain("deferReply");
  expect(calls).not.toContain("deferUpdate");
});

test("the modal off a passed check updates its own ephemeral question message", async () => {
  const calls = await route("ticket_modal:check");
  expect(calls).toContain("deferUpdate");
  expect(calls).not.toContain("deferReply");
});

// ── end to end, through the real button handler ─────────────────────────────

const LOG_CHANNEL_ID = "c-log";

function journeyContext(questions: number) {
  const ctx = gatedContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckQuestions, questions);
  ctx.config.set(GUILD_ID, CONFIG_KEYS.modLogChannelId, LOG_CHANNEL_ID);
  return ctx;
}

// biome-ignore lint: the fakes stand in for untyped Discord API JSON
function journeyGuild(logged: any[]): Guild {
  const base = stubGuild() as unknown as Record<string, unknown>;
  return {
    ...base,
    channels: {
      fetch: async () => ({ isTextBased: () => true, send: async (p: unknown) => logged.push(p) }),
    },
  } as unknown as Guild;
}

// biome-ignore lint: the fakes stand in for untyped Discord API JSON
function clicker(ctx: AppContext, guild: Guild, seen: any) {
  const router = new ComponentRouter(ticketsModule.components ?? [], ctx);
  return async (customId: string) => {
    const interaction = {
      customId,
      guild,
      user: USER,
      replied: false,
      deferred: false,
      isButton: () => true,
      isModalSubmit: () => false,
      // biome-ignore lint: see above
      update: async (p: any) => void seen.updates.push(p),
      deferUpdate: async () => void seen.updates.push("deferUpdate"),
      // biome-ignore lint: see above
      showModal: async (m: any) => void seen.modals.push(m.data?.custom_id ?? m.toJSON().custom_id),
      editReply: async () => {},
      reply: async () => {},
    };
    await router.handle(interaction as unknown as ButtonInteraction);
  };
}

const tokenOf = (reply: unknown) =>
  JSON.stringify(reply).match(/ticket_check:([0-9a-f]+):/)![1]!;

test("answering everything right ends at the subject modal, with the pass recorded", async () => {
  const ctx = journeyContext(2);
  const logged: unknown[] = [];
  const guild = journeyGuild(logged);
  const seen = { updates: [] as unknown[], modals: [] as string[] };
  const click = clicker(ctx, guild, seen);

  const gate = await gateTicket(ctx, guild, USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(gate.reply);

  for (let i = 0; i < 2; i++) {
    const live = getSession(token)!;
    const right = live.questions[live.current]!.answerIndex;
    await click(`ticket_check:${token}:${live.current}:${right}`);
  }

  // The last right answer is answered WITH the modal, so the panel's subject prompt is
  // the reward rather than a dead end.
  expect(seen.modals).toEqual(["ticket_modal:check"]);
  expect(getSession(token)).toBeUndefined();
  expect(getCheckResult(ctx.db, GUILD_ID, USER.id)?.passedAt).toBeGreaterThan(0);
  expect(takePassNote(GUILD_ID, USER.id)).toMatchObject({ correct: 2, total: 2 });
  expect(logged.length).toBe(0); // passing is not mod-log noise
});

test("getting one wrong ends the run, starts the cooldown and tells staff", async () => {
  const ctx = journeyContext(2);
  const logged: { embeds: { data: { title?: string; fields?: { name: string }[] } }[] }[] = [];
  const guild = journeyGuild(logged);
  const seen = { updates: [] as unknown[], modals: [] as string[] };
  const click = clicker(ctx, guild, seen);

  const gate = await gateTicket(ctx, guild, USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(gate.reply);

  const live = getSession(token)!;
  const wrong = (live.questions[0]!.answerIndex + 1) % 4;
  await click(`ticket_check:${token}:0:${wrong}`);

  // Both remaining answers are needed and one is already lost, so it stops here.
  expect(getSession(token)).toBeUndefined();
  expect(seen.modals).toEqual([]);
  expect(JSON.stringify(seen.updates)).toContain("public help channels");
  expect(getCheckResult(ctx.db, GUILD_ID, USER.id)).toMatchObject({ passedAt: null, fails: 1 });

  expect(logged.length).toBe(1);
  const embed = logged[0]!.embeds[0]!.data;
  expect(embed.title).toBe("Ticket check failed");
  expect(embed.fields?.map((f) => f.name)).toEqual([
    "Member",
    "Score",
    "Failures in a row",
    "Can retry",
    "Answers",
  ]);
});

test("failures stay out of the mod log when the guild turns that off", async () => {
  const ctx = journeyContext(2);
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckLogFailures, false);
  const logged: unknown[] = [];
  const guild = journeyGuild(logged);
  const click = clicker(ctx, guild, { updates: [], modals: [] });

  const gate = await gateTicket(ctx, guild, USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(gate.reply);
  const live = getSession(token)!;
  await click(`ticket_check:${token}:0:${(live.questions[0]!.answerIndex + 1) % 4}`);

  expect(getCheckResult(ctx.db, GUILD_ID, USER.id)?.fails).toBe(1); // still recorded
  expect(logged.length).toBe(0);
});

// Repeating it on every question would push the actual question down the message for no
// gain, so it introduces the check and then gets out of the way.
test("the intro text leads the first question only", async () => {
  const ctx = journeyContext(2);
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckIntroText, "Read the pinned FAQ first.");
  const guild = journeyGuild([]);
  const seen = { updates: [] as unknown[], modals: [] as string[] };
  const click = clicker(ctx, guild, seen);

  const gate = await gateTicket(ctx, guild, USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected a challenge");
  expect(JSON.stringify(gate.reply)).toContain("Read the pinned FAQ first.");

  const token = tokenOf(gate.reply);
  const live = getSession(token)!;
  await click(`ticket_check:${token}:0:${live.questions[0]!.answerIndex}`);
  expect(JSON.stringify(seen.updates)).toContain("Question 2 of 2");
  expect(JSON.stringify(seen.updates)).not.toContain("Read the pinned FAQ first.");
});

// ── you cannot shop for an easier question ──────────────────────────────────

// Clicking Open Ticket again used to build a whole new quiz and silently bin the old
// one, so anyone could keep rerolling until question one looked easy. Coming back has
// to return the question they already have, on the clock it already started.
test("clicking Open Ticket again resumes the same question, on the same clock", async () => {
  const ctx = gatedContext();
  const guild = stubGuild();
  const first = await gateTicket(ctx, guild, USER, PANEL);
  if (first.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(first.reply);
  // The four button labels are the question, in the order it was asked.
  const options = (reply: unknown) =>
    [...JSON.stringify(reply).matchAll(/"label":"(.*?)"/g)].map((m) => m[1]);

  const second = await gateTicket(ctx, guild, USER, PANEL);
  if (second.kind !== "stop") throw new Error("expected the same challenge back");
  expect(tokenOf(second.reply)).toBe(token);
  expect(options(second.reply)).toEqual(options(first.reply));
  // Said out loud, or getting the same question back reads as the bot being broken.
  expect(JSON.stringify(first.reply)).not.toContain("already started");
  expect(JSON.stringify(second.reply)).toContain("already started");
});

// The same applies across the two ways in: the command must not hand out a fresh quiz
// to someone who already has one open from the panel.
test("the slash command resumes a check started from the panel", async () => {
  const ctx = gatedContext();
  const guild = stubGuild();
  const started = await gateTicket(ctx, guild, USER, PANEL);
  if (started.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(started.reply);

  const viaCommand = await gateTicket(ctx, guild, USER, { kind: "command", subject: "x" });
  if (viaCommand.kind !== "stop") throw new Error("expected the same challenge back");
  expect(tokenOf(viaCommand.reply)).toBe(token);
  // The newest intent wins: passing should now open with the subject they just gave.
  expect(getSession(token)?.continuation).toEqual({ kind: "command", subject: "x" });
});

test("a check left to run out is settled on the next attempt, not reissued", async () => {
  const ctx = gatedContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckSeconds, 30);
  const guild = stubGuild();
  const started = await gateTicket(ctx, guild, USER, PANEL);
  if (started.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(started.reply);
  // Wind the deadline back rather than waiting out the clock.
  const live = getSession(token)!;
  live.deadline = Date.now() - 1;

  const again = await gateTicket(ctx, guild, USER, PANEL);
  if (again.kind !== "stop") throw new Error("expected to be held off");
  expect(JSON.stringify(again.reply)).not.toContain("Question 1");
  expect(JSON.stringify(again.reply)).toContain("You can try again");
  expect(getCheckResult(ctx.db, GUILD_ID, USER.id)).toMatchObject({ fails: 1 });
  expect(getSession(token)).toBeUndefined();
});

// ── /ticket check ───────────────────────────────────────────────────────────

async function runCheckCommand(
  ctx: AppContext,
  guild: Guild,
  target: User,
  pass: boolean | null,
): Promise<string> {
  let replied = "";
  const interaction = {
    guild,
    guildId: GUILD_ID,
    user: { id: "staff", username: "staff" },
    options: {
      getSubcommand: () => "check",
      getUser: () => target,
      getBoolean: () => pass,
    },
    memberPermissions: { has: () => true },
    reply: async (opts: { content: string }) => {
      replied = opts.content;
    },
  };
  const command = ticketsModule.commands![0]!;
  await command.execute(interaction as unknown as ChatInputCommandInteraction, ctx);
  return replied;
}

// Clearing someone's check used to leave the check they had OPEN untouched, so the next
// click resumed the same question and the reply's promise of a fresh one was a lie.
test("clearing a member's check also drops the one they have open", async () => {
  const ctx = gatedContext();
  const guild = stubGuild();
  const started = await gateTicket(ctx, guild, USER, PANEL);
  if (started.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(started.reply);

  const reply = await runCheckCommand(ctx, guild, USER, null);
  expect(reply).toContain("Cleared");
  expect(getSession(token)).toBeUndefined();

  const after = await gateTicket(ctx, guild, USER, PANEL);
  if (after.kind !== "stop") throw new Error("expected a fresh challenge");
  expect(tokenOf(after.reply)).not.toBe(token);
  expect(JSON.stringify(after.reply)).not.toContain("already started");
});

test("clearing a member's check lifts their cooldown", async () => {
  const ctx = gatedContext();
  const guild = stubGuild();
  recordCheckFail(ctx.db, GUILD_ID, USER.id, Date.now());
  await runCheckCommand(ctx, guild, USER, null);
  expect(getCheckResult(ctx.db, GUILD_ID, USER.id)).toBeUndefined();
  const after = await gateTicket(ctx, guild, USER, PANEL);
  if (after.kind !== "stop") throw new Error("expected a challenge, not a cooldown");
  expect(JSON.stringify(after.reply)).toContain("Question 1");
});

// Marking someone through while they have a check open has to retire it too, or the
// sweep charges them a failure for the quiz they were just excused from.
test("passing a member drops the check they were part way through", async () => {
  const ctx = gatedContext();
  const guild = stubGuild();
  const started = await gateTicket(ctx, guild, USER, PANEL);
  if (started.kind !== "stop") throw new Error("expected a challenge");
  const token = tokenOf(started.reply);

  const reply = await runCheckCommand(ctx, guild, USER, true);
  expect(reply).toContain("marked as passed");
  expect(getSession(token)).toBeUndefined();
  expect((await gateTicket(ctx, guild, USER, PANEL)).kind).toBe("allow");
});

// Switching the feature off must not keep charging people. Anyone mid-check when it is
// turned off would otherwise be recorded as having failed, and put on a cooldown waiting
// for them if it is ever switched back on.
test("a check swept after the feature is turned off costs nothing", () => {
  const ctx = gatedContext();
  const s = newSession({
    guildId: GUILD_ID,
    userId: USER.id,
    questions: [question(1)],
    seconds: 60,
    continuation: PANEL,
    now: NOW,
  });
  putSession(s);
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckEnabled, false);
  sweepSessions(ctx, NOW + 61_000);
  expect(getSession(s.token)).toBeUndefined();
  expect(getCheckResult(ctx.db, GUILD_ID, USER.id)).toBeUndefined();
});

// The config modal takes 4000 characters for a text setting, and Discord caps an embed
// description at 4096. Without clamping, a guild that pastes a long explanation into the
// intro makes the whole gate throw, and nobody can open a ticket at all.
test("a very long intro or failure text cannot break the check", async () => {
  const ctx = gatedContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckIntroText, "x".repeat(4000));
  ctx.config.set(GUILD_ID, CONFIG_KEYS.ticketCheckFailText, "y".repeat(4000));
  const guild = stubGuild();

  const gate = await gateTicket(ctx, guild, USER, PANEL);
  if (gate.kind !== "stop") throw new Error("expected a challenge");
  // biome-ignore lint: untyped Discord API JSON
  const question = (gate.reply as any).embeds[0].data.description as string;
  expect(question.length).toBeLessThanOrEqual(4096);
  expect(question).toContain("right opens a ticket"); // the question itself survives

  // And the same on the way out, where the failure text is just as long.
  recordCheckFail(ctx.db, GUILD_ID, USER.id, Date.now());
  clearCheckSession(GUILD_ID, USER.id);
  const cooled = await gateTicket(ctx, guild, USER, PANEL);
  if (cooled.kind !== "stop") throw new Error("expected a cooldown notice");
  // biome-ignore lint: untyped Discord API JSON
  const notice = (cooled.reply as any).embeds[0].data.description as string;
  expect(notice.length).toBeLessThanOrEqual(4096);
  expect(notice).toContain("You can try again");
});
