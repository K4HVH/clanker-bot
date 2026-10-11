import { expect, test } from "bun:test";
import { run } from "../../src/db/index";
import { forgetIn, forgetRows, type ScanChannel, type ScanMessage } from "../../src/lib/forget";
import { silentContext } from "../helpers/fakes";

const NOW = 1_800_000_000_000;

function seed() {
  const { db } = silentContext();
  for (const user of ["u1", "u2"]) {
    run(db, "INSERT INTO cases (guild_id, case_number, user_id, moderator_id, type, reason, created_at) VALUES ('g', ?, ?, 'm', 'warn', 'r', ?)", user === "u1" ? 1 : 2, user, NOW);
    run(db, "INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, created_at) VALUES ('g', ?, ?, ?, 's', 'closed', ?)", user === "u1" ? 1 : 2, `c-${user}`, user, NOW);
    run(db, "INSERT INTO ticket_check_results (guild_id, user_id, passed_at, fails) VALUES ('g', ?, ?, 0)", user, NOW);
    run(db, "INSERT INTO verification_challenges (guild_id, user_id, code, expires_at) VALUES ('g', ?, 'ABC', ?)", user, NOW + 60_000);
  }
  run(db, "INSERT INTO scheduled_actions (guild_id, type, user_id, run_at, created_at) VALUES ('g', 'unban', 'u1', ?, ?)", NOW + 86_400_000, NOW);
  run(db, "INSERT INTO scheduled_actions (guild_id, type, user_id, run_at, created_at) VALUES ('g', 'unban', 'u1', ?, ?)", NOW - 1000, NOW);
  const caseId = (db.query("SELECT id FROM cases WHERE user_id = 'u1'").get() as { id: number }).id;
  run(db, "INSERT INTO scam_signature (guild_id, kind, value, source, case_id, first_seen, last_seen) VALUES ('g', 'domain', 'scam.example', 'honeypot', ?, ?, ?)", caseId, NOW, NOW);
  return db;
}

test("everything held on one member goes, and only theirs", () => {
  const db = seed();
  expect(forgetRows(db, "g", "u1", NOW)).toEqual({ cases: 1, tickets: 1, checks: 1, challenges: 1, scheduled: 1, signatures: 1 });
  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
  expect(count("SELECT COUNT(*) AS n FROM cases WHERE user_id = 'u1'")).toBe(0);
  expect(count("SELECT COUNT(*) AS n FROM cases WHERE user_id = 'u2'")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM tickets WHERE opener_id = 'u2'")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM ticket_check_results WHERE user_id = 'u2'")).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM verification_challenges WHERE user_id = 'u2'")).toBe(1);
  // The pending unban stays until it lifts the ban; the one already past is gone.
  expect(db.query("SELECT run_at FROM scheduled_actions WHERE user_id = 'u1'").all()).toEqual([{ run_at: NOW + 86_400_000 }]);
  expect(db.query("SELECT case_id, value FROM scam_signature").all()).toEqual([{ case_id: null, value: "scam.example" }]);
});

function channel(label: string, messages: ScanMessage[], broken = false): ScanChannel & { removed: string[] } {
  const removed: string[] = [];
  return {
    label,
    removed,
    async fetchBefore(before, limit) {
      if (broken) throw new Error("Missing Access");
      const live = messages.filter((m) => !removed.includes(m.id));
      const older = before === undefined ? live : live.filter((m) => BigInt(m.id) < BigInt(before));
      return older.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, limit);
    },
    async remove(id) {
      removed.push(id);
    },
  };
}

test("the bot's posts naming the member are deleted across pages", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: String(1000 + i), authorId: "bot", text: i % 2 ? "User (u1)" : "User (u2)" }));
  const logs = channel("#logs", [...many, { id: "5", authorId: "someone", text: "u1 said hi" }]);
  const result = await forgetIn([logs], "bot", (m) => m.text.includes("u1"));
  expect(result).toEqual({ deleted: 75, unreachable: [] });
  expect(logs.removed).not.toContain("5");
});

test("a channel that can't be read is reported, the rest still run", async () => {
  const dm = channel("DMs", [], true);
  const logs = channel("#logs", [{ id: "10", authorId: "bot", text: "(u1)" }]);
  expect(await forgetIn([dm, logs], "bot", () => true)).toEqual({ deleted: 1, unreachable: ["DMs"] });
});

test("the bot's deletions are marked so the member log doesn't echo them", async () => {
  const { scanOf } = await import("../../src/lib/forget");
  const { suppressedDeletions } = await import("../../src/lib/log-suppress");
  const ch = scanOf("#logs", { messages: { fetch: async () => new Map(), delete: async () => {} } });
  await ch.remove("777");
  expect(suppressedDeletions.has("777")).toBe(true);
});
