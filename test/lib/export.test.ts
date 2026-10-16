import { expect, test } from "bun:test";
import { run } from "../../src/db/index";
import { collectIn, memberRows } from "../../src/lib/export";
import type { ScanChannel, ScanMessage } from "../../src/lib/forget";
import { silentContext } from "../helpers/fakes";

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function seed() {
  const { db } = silentContext();
  for (const user of ["u1", "u2"]) {
    run(db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('g', ?, ?, 'mod9', 'warn', 'spam', ?)", user === "u1" ? 1 : 2, user, NOW);
    run(
      db,
      "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, transcript, created_at, closed_at, closed_by, close_reason) VALUES ('g', ?, ?, ?, 'help', 'closed', 'u1: hi', ?, ?, 'mod9', 'solved')",
      user === "u1" ? 1 : 2,
      `c-${user}`,
      user,
      NOW,
      NOW + 1000,
    );
    run(db, "INSERT INTO ticket_check_results (guild_id, user_id, passed_at, fails) VALUES ('g', ?, ?, 0)", user, NOW);
    run(db, "INSERT INTO verification_challenges (guild_id, user_id, code, expires_at, attempts) VALUES ('g', ?, 'ABC', ?, 2)", user, NOW + 60_000);
  }
  run(db, "INSERT INTO scheduled_actions (guild_id, type, user_id, reason, run_at, created_at) VALUES ('g', 'unban', 'u1', 'temp ban', ?, ?)", NOW + 86_400_000, NOW);
  return db;
}

test("a member's copy holds their rows and only theirs, without who acted on them or the captcha's answer", () => {
  const rows = memberRows(seed(), "g", "u1");
  expect(rows).toEqual({
    cases: [{ number: 1, type: "warn", reason: "spam", at: iso(NOW) }],
    tickets: [{ number: 1, subject: "help", status: "closed", opened: iso(NOW), closed: iso(NOW + 1000), closeReason: "solved", transcript: "u1: hi" }],
    ticketChecks: [{ passed: iso(NOW), failed: null, failsInARow: 0 }],
    captcha: [{ expires: iso(NOW + 60_000), wrongGuesses: 2 }],
    scheduled: [{ action: "unban", reason: "temp ban", at: iso(NOW + 86_400_000) }],
  });
  expect(JSON.stringify(rows)).not.toContain("mod9");
  expect(JSON.stringify(rows)).not.toContain("ABC");
});

test("the bot's posts naming them are collected, not deleted, back to the oldest kept", async () => {
  const msgs: ScanMessage[] = [
    { id: "300", authorId: "bot", text: "Member left: u1" },
    { id: "200", authorId: "someone", text: "u1" },
    { id: "150", authorId: "bot", text: "Member joined: u2" },
    { id: "100", authorId: "bot", text: "Warned u1" },
  ];
  let removed = 0;
  const channel: ScanChannel = {
    label: "#logs",
    fetchBefore: async (before) => msgs.filter((m) => before === undefined || BigInt(m.id) < BigInt(before)),
    remove: async () => void removed++,
  };
  const broken: ScanChannel = { label: "#gone", fetchBefore: async () => Promise.reject(new Error("no access")), remove: async () => {} };
  const got = await collectIn([channel, broken], "bot", (m) => m.text.includes("u1"), "120");
  expect(got.posts.map((p) => [p.channel, p.id, p.text])).toEqual([["#logs", "300", "Member left: u1"]]);
  expect(got.unreachable).toEqual(["#gone"]);
  expect(removed).toBe(0);
});
