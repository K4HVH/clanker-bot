import { expect, test } from "bun:test";
import {
  clearCases,
  countAutomodViolations,
  createCase,
  listAutomodActions,
  listCasesByUser,
} from "../../src/db/cases";
import { makeTestDb } from "../helpers/db";

test("clearCases: automodOnly deletes only bot warns; full deletes everything for the user", () => {
  const db = makeTestDb();
  const BOT = "bot";
  const seed = () => {
    createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "warn", reason: "Automod: x" });
    createCase(db, { guildId: "g", userId: "u", moderatorId: "human", type: "warn", reason: "manual" });
    createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "ban", reason: "auto ban" });
    createCase(db, { guildId: "g", userId: "other", moderatorId: BOT, type: "warn", reason: "Automod: z" });
  };

  seed();
  expect(clearCases(db, "g", "u", { automodOnly: true, botId: BOT })).toBe(1); // just the bot warn
  expect(listCasesByUser(db, "g", "u").length).toBe(2); // manual warn + ban remain
  expect(listCasesByUser(db, "g", "other").length).toBe(1); // untouched

  seed(); // now u has 3 again (+ the 2 that survived)
  const before = listCasesByUser(db, "g", "u").length;
  expect(before).toBeGreaterThan(0);
  expect(clearCases(db, "g", "u", { automodOnly: false, botId: BOT })).toBe(before); // full wipe
  expect(listCasesByUser(db, "g", "u").length).toBe(0);
});

test("countAutomodViolations counts only bot-authored warns for the user", () => {
  const db = makeTestDb();
  const BOT = "bot";
  // Two automod warns (bot-authored) + a manual warn (human) + a bot ban (not a warn).
  createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "warn", reason: "Automod: x" });
  createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "warn", reason: "Automod: y" });
  createCase(db, { guildId: "g", userId: "u", moderatorId: "human", type: "warn", reason: "manual" });
  createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "ban", reason: "auto ban" });
  // A different user's automod warn must not count.
  createCase(db, { guildId: "g", userId: "other", moderatorId: BOT, type: "warn", reason: "Automod: z" });

  expect(countAutomodViolations(db, "g", "u", BOT, 0)).toBe(2);
  // A cutoff in the future excludes everything.
  expect(countAutomodViolations(db, "g", "u", BOT, Date.now() + 60_000)).toBe(0);
});

test("listAutomodActions returns only bot-authored punitive actions in the window", () => {
  const db = makeTestDb();
  const BOT = "bot";
  createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "warn", reason: "Automod: x" }); // not punitive
  createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "timeout", reason: "auto" });
  createCase(db, { guildId: "g", userId: "u", moderatorId: BOT, type: "kick", reason: "auto" });
  createCase(db, { guildId: "g", userId: "u", moderatorId: "human", type: "ban", reason: "manual" }); // not bot
  createCase(db, { guildId: "g", userId: "other", moderatorId: BOT, type: "ban", reason: "auto" }); // other user

  const actions = listAutomodActions(db, "g", "u", BOT, 0);
  expect(actions.map((a) => a.type).sort()).toEqual(["kick", "timeout"]);
  expect(actions.every((a) => typeof a.createdAt === "number")).toBe(true);
  // A future cutoff excludes everything.
  expect(listAutomodActions(db, "g", "u", BOT, Date.now() + 60_000)).toEqual([]);
});

test("case numbers increment sequentially per guild", () => {
  const db = makeTestDb();
  const a = createCase(db, {
    guildId: "g1",
    userId: "u1",
    moderatorId: "m",
    type: "warn",
    reason: "r",
  });
  const b = createCase(db, {
    guildId: "g1",
    userId: "u2",
    moderatorId: "m",
    type: "warn",
    reason: "r",
  });
  expect(a.caseNumber).toBe(1);
  expect(b.caseNumber).toBe(2);
});

test("case numbering is isolated per guild", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "r" });
  const other = createCase(db, {
    guildId: "g2",
    userId: "u1",
    moderatorId: "m",
    type: "warn",
    reason: "r",
  });
  expect(other.caseNumber).toBe(1);
});

test("history lists a user's actions newest first", () => {
  const db = makeTestDb();
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "warn", reason: "one" });
  createCase(db, { guildId: "g1", userId: "u1", moderatorId: "m", type: "note", reason: "two" });
  const list = listCasesByUser(db, "g1", "u1");
  expect(list.map((c) => c.reason)).toEqual(["two", "one"]);
  expect(list.map((c) => c.caseNumber)).toEqual([2, 1]);
});
