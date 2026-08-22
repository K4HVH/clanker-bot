import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type InteractionReplyOptions,
  MessageFlags,
  type User,
} from "discord.js";
import type { AppContext } from "../../core/context";
import type { ComponentHandler } from "../../core/module";
import { getCheckResult, recordCheckFail, recordCheckPass } from "../../db/ticket-check";
import { CONFIG_KEYS, parseRoleIds } from "../../lib/config";
import { userValue } from "../../lib/modlog";
import {
  buildQuiz,
  CHECK_CATEGORIES,
  type CheckPolicy,
  type CheckQuestion,
  gateDecision,
  makeRng,
  type Rng,
} from "../../lib/ticket-check";
import { isTicketStaff, sendToModLog, subjectModal } from "./shared";

const K = CONFIG_KEYS;

// Read the guild's check settings. `required` is clamped to `questions` here rather than
// validated in the panel: they are two independent knobs, and "get 5 of 3 right" would be
// a gate nobody could pass.
export function readPolicy(ctx: AppContext, guildId: string): CheckPolicy {
  const cfg = ctx.config;
  const questions = cfg.getEffective<number>(guildId, K.ticketCheckQuestions);
  return {
    enabled: cfg.getEffective<boolean>(guildId, K.ticketCheckEnabled),
    categories: [...CHECK_CATEGORIES],
    questions,
    required: Math.min(cfg.getEffective<number>(guildId, K.ticketCheckRequired), questions),
    seconds: cfg.getEffective<number>(guildId, K.ticketCheckSeconds),
    passDays: cfg.getEffective<number>(guildId, K.ticketCheckPassDays),
    cooldownMinutes: cfg.getEffective<number>(guildId, K.ticketCheckCooldownMinutes),
    exemptStaff: cfg.getEffective<boolean>(guildId, K.ticketCheckExemptStaff),
    exemptRoles: parseRoleIds(cfg.getEffective<string>(guildId, K.ticketCheckExemptRoles)),
  };
}

// ── Sessions ────────────────────────────────────────────────────────────────

// What to do once the member passes. The panel button has to end in the subject modal
// (it never collected one), while /ticket open already has the subject in hand.
export type Continuation = { kind: "panel" } | { kind: "command"; subject: string };

export interface Session {
  token: string;
  guildId: string;
  userId: string;
  questions: CheckQuestion[];
  // What they picked, in order, for the mod-log report on a failure.
  answers: number[];
  current: number;
  correct: number;
  startedAt: number;
  deadline: number;
  continuation: Continuation;
}

// In memory only. A restart drops any half-finished check, which costs the member one
// click; persisting them would mean reviving a quiz whose message is already gone.
const sessions = new Map<string, Session>();

// A passed check that has not yet turned into a ticket, so the mod-log entry for the
// open can report how the member did. Consumed by the open, swept if they never finish.
interface PassNote {
  correct: number;
  total: number;
  elapsedMs: number;
  at: number;
}
const passNotes = new Map<string, PassNote>();
const PASS_NOTE_TTL_MS = 15 * 60_000;

export function newSession(input: {
  guildId: string;
  userId: string;
  questions: CheckQuestion[];
  seconds: number;
  continuation: Continuation;
  now: number;
}): Session {
  return {
    // Random per session, so the buttons on a stale ephemeral message cannot be replayed
    // into a later check.
    token: randomBytes(8).toString("hex"),
    guildId: input.guildId,
    userId: input.userId,
    questions: input.questions,
    answers: [],
    current: 0,
    correct: 0,
    startedAt: input.now,
    deadline: input.now + input.seconds * 1000,
    continuation: input.continuation,
  };
}

// One live check per member: starting another retires the old one, so an abandoned
// half-answered quiz can't be finished alongside a fresh one.
export function putSession(session: Session): void {
  for (const [token, live] of sessions) {
    if (live.guildId === session.guildId && live.userId === session.userId) sessions.delete(token);
  }
  sessions.set(session.token, session);
}

export function getSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function dropSession(token: string): void {
  sessions.delete(token);
}

// Abandoned checks are never answered, so nothing else would ever remove them. Called
// from the ticket module's existing five-minute scan rather than a timer of its own.
//
// Running out of time counts as a failure, deliberately: otherwise "open the panel, read
// the questions, walk away, click again" hands out fresh questions at no cost, and the
// cooldown that is supposed to make guessing expensive never applies.
export function sweepSessions(ctx: AppContext, now: number): void {
  for (const [token, session] of sessions) {
    if (session.deadline > now) continue;
    sessions.delete(token);
    recordCheckFail(ctx.db, session.guildId, session.userId, now);
  }
  // A member who passed and then walked away from the subject modal leaves a note
  // behind that nothing else would ever collect.
  for (const [key, note] of passNotes) {
    if (now - note.at > PASS_NOTE_TTL_MS) passNotes.delete(key);
  }
}

export type AnswerOutcome =
  | { kind: "next" }
  | { kind: "passed"; correct: number; elapsedMs: number }
  | { kind: "failed"; correct: number; reason: "wrong" | "expired" }
  | { kind: "stale" };

// Advance the check by one answer. Mutates the session, which is the live record of the
// attempt; the caller decides what to show and whether to record the result.
export function answerSession(
  session: Session,
  questionIndex: number,
  choice: number,
  required: number,
  now: number,
): AnswerOutcome {
  if (now >= session.deadline) {
    return { kind: "failed", correct: session.correct, reason: "expired" };
  }
  // The buttons on an already-answered message stay clickable until Discord repaints it.
  if (questionIndex !== session.current) return { kind: "stale" };

  const question = session.questions[questionIndex]!;
  session.answers.push(choice);
  if (choice === question.answerIndex) session.correct++;
  session.current++;

  const remaining = session.questions.length - session.current;
  // Asking the rest once the pass mark is out of reach wastes both sides' time.
  if (session.correct + remaining < required) {
    return { kind: "failed", correct: session.correct, reason: "wrong" };
  }
  if (remaining > 0) return { kind: "next" };
  return session.correct >= required
    ? { kind: "passed", correct: session.correct, elapsedMs: now - session.startedAt }
    : { kind: "failed", correct: session.correct, reason: "wrong" };
}

// ── Discord flow ────────────────────────────────────────────────────────────

export function takePassNote(guildId: string, userId: string): PassNote | undefined {
  const key = `${guildId}:${userId}`;
  const note = passNotes.get(key);
  passNotes.delete(key);
  return note;
}

function cryptoRng(): Rng {
  return makeRng(randomBytes(4).readUInt32BE(0));
}

function failText(ctx: AppContext, guildId: string): string {
  return ctx.config.getEffective<string>(guildId, K.ticketCheckFailText);
}

function retryLine(until: number): string {
  return `-# You can try again <t:${Math.floor(until / 1000)}:R>.`;
}

// One question, with its four options as buttons. The custom id carries the session
// token and which question it belongs to, so a click on a message Discord has not
// repainted yet is recognised as stale instead of counting against the next question.
function questionBody(session: Session, policy: CheckPolicy) {
  const question = session.questions[session.current]!;
  const total = session.questions.length;
  const embed = new EmbedBuilder()
    .setColor(0x2980b9)
    .setTitle(`Question ${session.current + 1} of ${total}`)
    .setDescription(
      `${question.prompt}\n\n-# ${policy.required} of ${total} right opens a ticket. ` +
        `Time runs out <t:${Math.floor(session.deadline / 1000)}:R>.`,
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...question.choices.map((choice, index) =>
      new ButtonBuilder()
        .setCustomId(`ticket_check:${session.token}:${session.current}:${index}`)
        .setLabel(choice.slice(0, 80))
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: [row] };
}

function failBody(ctx: AppContext, guildId: string, scoreLine: string, until: number) {
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("No ticket opened")
    .setDescription(`${scoreLine}\n\n${failText(ctx, guildId)}\n\n${retryLine(until)}`);
  return { embeds: [embed], components: [] };
}

// What they picked against what was right, per question. Staff need this to tell a gate
// that is working from one that is bouncing people it shouldn't.
function answerBreakdown(session: Session): string {
  if (session.answers.length === 0) return "Nothing answered before the time ran out.";
  const lines = session.answers.map((choice, i) => {
    const question = session.questions[i]!;
    const chosen = question.choices[choice] ?? "?";
    const right = question.choices[question.answerIndex]!;
    const verdict = choice === question.answerIndex ? "✅" : `❌ (answer: ${right})`;
    return `${i + 1}. \`${question.generatorId}\` picked ${chosen} ${verdict}`;
  });
  const text = lines.join("\n");
  return text.length > 1024 ? `${text.slice(0, 1010)}\n…` : text;
}

async function logFailure(
  ctx: AppContext,
  guild: Guild,
  user: User,
  session: Session,
  outcome: { correct: number; reason: "wrong" | "expired" },
  until: number,
): Promise<void> {
  if (!ctx.config.getEffective<boolean>(guild.id, K.ticketCheckLogFailures)) return;
  const fails = getCheckResult(ctx.db, guild.id, user.id)?.fails ?? 1;
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Ticket check failed")
    .addFields(
      { name: "Member", value: userValue(user.id, user.username) },
      {
        name: "Score",
        value: `${outcome.correct}/${session.questions.length}${
          outcome.reason === "expired" ? " (ran out of time)" : ""
        }`,
      },
      { name: "Failures in a row", value: String(fails) },
      { name: "Can retry", value: `<t:${Math.floor(until / 1000)}:R>` },
      { name: "Answers", value: answerBreakdown(session) },
    )
    .setTimestamp(new Date());
  await sendToModLog(ctx, guild, { embeds: [embed] });
}

export type TicketGate = { kind: "allow" } | { kind: "stop"; reply: InteractionReplyOptions };

// The single entry point both ways into a ticket go through. Either the member may
// proceed, or the caller has an ephemeral reply to send: the first question, or a
// cooldown notice. Evaluated BEFORE any defer, so the panel button can still answer
// with a modal when the gate is open.
export async function gateTicket(
  ctx: AppContext,
  guild: Guild,
  user: User,
  continuation: Continuation,
): Promise<TicketGate> {
  // The common case is a guild with the check switched off, so settle that on one read
  // rather than loading the whole policy and fetching a member to throw both away.
  if (!ctx.config.getEffective<boolean>(guild.id, K.ticketCheckEnabled)) return { kind: "allow" };
  const policy = readPolicy(ctx, guild.id);

  const member = await guild.members.fetch(user.id).catch(() => null);
  const decision = gateDecision(policy, {
    isStaff: await isTicketStaff(guild, user.id, ctx),
    roleIds: member ? [...member.roles.cache.keys()] : [],
    result: getCheckResult(ctx.db, guild.id, user.id),
    now: Date.now(),
  });
  if (decision.kind === "allow") return { kind: "allow" };

  if (decision.kind === "cooldown") {
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("Not yet")
      .setDescription(`${failText(ctx, guild.id)}\n\n${retryLine(decision.until)}`);
    return { kind: "stop", reply: { embeds: [embed], flags: MessageFlags.Ephemeral } };
  }

  const session = newSession({
    guildId: guild.id,
    userId: user.id,
    questions: buildQuiz(policy.questions, policy.categories, cryptoRng()),
    seconds: policy.seconds,
    continuation,
    now: Date.now(),
  });
  putSession(session);
  return {
    kind: "stop",
    reply: { ...questionBody(session, policy), flags: MessageFlags.Ephemeral },
  };
}

// Opening a ticket is index.ts's job; the handler takes it as an argument so the two
// files stay out of each other's imports.
export type OpenTicket = (
  ctx: AppContext,
  guild: Guild,
  opener: User,
  subject: string,
  via: User | null,
) => Promise<{ ok: true; channelId: string } | { ok: false; message: string }>;

export function checkComponents(open: OpenTicket): ComponentHandler[] {
  const handler: ComponentHandler = {
    customId: "ticket_check",
    type: "button",
    match: "prefix",
    async handle(interaction, ctx) {
      const button = interaction as ButtonInteraction;
      const guild = button.guild;
      if (!guild) return;

      const [, token, questionIndex, choice] = button.customId.split(":");
      const session = token ? getSession(token) : undefined;
      // No session means a restart dropped it, or the sweep already wrote it off.
      if (!session || session.userId !== button.user.id) {
        await button.update({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("That check has expired")
              .setDescription("Open the ticket panel again when you have a minute to spare."),
          ],
          components: [],
        });
        return;
      }

      const policy = readPolicy(ctx, guild.id);
      const now = Date.now();
      const outcome = answerSession(
        session,
        Number(questionIndex),
        Number(choice),
        policy.required,
        now,
      );

      if (outcome.kind === "stale") {
        await button.deferUpdate();
        return;
      }
      if (outcome.kind === "next") {
        await button.update(questionBody(session, policy));
        return;
      }

      dropSession(session.token);

      if (outcome.kind === "failed") {
        recordCheckFail(ctx.db, guild.id, button.user.id, now);
        const until = now + policy.cooldownMinutes * 60_000;
        const lead = outcome.reason === "expired" ? "Time ran out. " : "";
        await button.update(
          failBody(
            ctx,
            guild.id,
            `${lead}You got **${outcome.correct} of ${session.questions.length}**.`,
            until,
          ),
        );
        await logFailure(ctx, guild, button.user, session, outcome, until);
        return;
      }

      // Passed. Recorded before the ticket exists, so a Discord failure while creating
      // the channel cannot cost them the pass they just earned.
      recordCheckPass(ctx.db, guild.id, button.user.id, now);
      passNotes.set(`${guild.id}:${button.user.id}`, {
        correct: outcome.correct,
        total: session.questions.length,
        elapsedMs: outcome.elapsedMs,
        at: now,
      });

      if (session.continuation.kind === "panel") {
        // The panel button never collected a subject, so the reward for the last right
        // answer is the modal. The question message stays put until the modal handler
        // edits it (it can, having been opened from a component).
        await button.showModal(subjectModal(true));
        return;
      }

      await button.update({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("Passed")
            .setDescription("Opening your ticket…"),
        ],
        components: [],
      });
      const result = await open(ctx, guild, button.user, session.continuation.subject, null);
      await button.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(result.ok ? 0x2ecc71 : 0xe74c3c)
            .setTitle(result.ok ? "Passed" : "No ticket opened")
            .setDescription(result.ok ? `Ticket opened: <#${result.channelId}>` : result.message),
        ],
      });
    },
  };
  return [handler];
}
