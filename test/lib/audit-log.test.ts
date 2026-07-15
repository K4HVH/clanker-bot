import { AuditLogEvent, type GuildAuditLogsEntry } from "discord.js";
import { expect, test } from "bun:test";
import { planAuditEntry, removalTargetId } from "../../src/lib/audit-log";
import { CONFIG_KEYS } from "../../src/lib/config";

const BOT = "bot-1";

type Over = Partial<Pick<GuildAuditLogsEntry, "action" | "executorId" | "targetId" | "reason">> & {
  changes?: Array<{ key: string; old?: unknown; new?: unknown }>;
};

function entry(over: Over): GuildAuditLogsEntry {
  return {
    action: AuditLogEvent.MemberBanAdd,
    executorId: "mod-1",
    targetId: "user-9",
    reason: null,
    changes: [],
    ...over,
  } as unknown as GuildAuditLogsEntry;
}

test("planAuditEntry drops the bot's own actions (already logged as cases)", () => {
  expect(planAuditEntry(entry({ executorId: BOT }), BOT)).toBeNull();
});

test("planAuditEntry: ban/kick → mod-log and flag the removed member for leave-dedup", () => {
  const ban = planAuditEntry(entry({ action: AuditLogEvent.MemberBanAdd }), BOT);
  expect(ban?.destination).toBe("mod");
  expect(ban?.toggle).toBe(CONFIG_KEYS.logModActions);
  expect(ban?.removedMemberId).toBe("user-9");

  const kick = planAuditEntry(entry({ action: AuditLogEvent.MemberKick }), BOT);
  expect(kick?.removedMemberId).toBe("user-9");

  const unban = planAuditEntry(entry({ action: AuditLogEvent.MemberBanRemove }), BOT);
  expect(unban?.destination).toBe("mod");
  expect(unban?.removedMemberId).toBeUndefined();
});

test("planAuditEntry: timeouts detected via communication_disabled_until, else ignored", () => {
  const timedOut = planAuditEntry(
    entry({
      action: AuditLogEvent.MemberUpdate,
      changes: [{ key: "communication_disabled_until", new: "2030-01-01T00:00:00Z" }],
    }),
    BOT,
  );
  expect(timedOut?.destination).toBe("mod");
  expect(timedOut?.toggle).toBe(CONFIG_KEYS.logModActions);

  const otherEdit = planAuditEntry(
    entry({ action: AuditLogEvent.MemberUpdate, changes: [{ key: "nick", new: "x" }] }),
    BOT,
  );
  expect(otherEdit).toBeNull();
});

test("planAuditEntry: role update reads $add/$remove → member-log", () => {
  const roles = planAuditEntry(
    entry({ action: AuditLogEvent.MemberRoleUpdate, changes: [{ key: "$add", new: [{ id: "role-1" }] }] }),
    BOT,
  );
  expect(roles?.destination).toBe("member");
  expect(roles?.toggle).toBe(CONFIG_KEYS.logMemberEvents);

  const noChange = planAuditEntry(entry({ action: AuditLogEvent.MemberRoleUpdate, changes: [] }), BOT);
  expect(noChange).toBeNull();
});

test("planAuditEntry: server structure changes → member-log under logServerEvents", () => {
  const chan = planAuditEntry(entry({ action: AuditLogEvent.ChannelCreate, targetId: "chan-1" }), BOT);
  expect(chan?.destination).toBe("member");
  expect(chan?.toggle).toBe(CONFIG_KEYS.logServerEvents);
});

test("planAuditEntry: a deleted channel/role shows its captured name, not a #unknown mention", () => {
  const del = planAuditEntry(
    entry({ action: AuditLogEvent.ChannelDelete, targetId: "c1", changes: [{ key: "name", old: "general" }] }),
    BOT,
  );
  const field = del?.embed.data.fields?.find((f) => f.name === "Channel");
  expect(field?.value).toContain("general");
  expect(field?.value).not.toContain("<#"); // no dead mention

  // A CREATE still mentions the (existing) channel.
  const created = planAuditEntry(entry({ action: AuditLogEvent.ChannelCreate, targetId: "c2" }), BOT);
  expect(created?.embed.data.fields?.find((f) => f.name === "Channel")?.value).toContain("<#c2>");
});

test("planAuditEntry: unmapped actions are ignored", () => {
  expect(planAuditEntry(entry({ action: AuditLogEvent.MessagePin }), BOT)).toBeNull();
});

test("removalTargetId identifies ban/kick targets (regardless of executor) for leave-dedup", () => {
  // Set even for the bot's own removal, so its spurious "left" gets suppressed too.
  expect(removalTargetId(entry({ action: AuditLogEvent.MemberBanAdd, executorId: BOT }))).toBe("user-9");
  expect(removalTargetId(entry({ action: AuditLogEvent.MemberKick }))).toBe("user-9");
  expect(removalTargetId(entry({ action: AuditLogEvent.MemberBanRemove }))).toBeNull();
  expect(removalTargetId(entry({ action: AuditLogEvent.ChannelDelete }))).toBeNull();
});

test("planAuditEntry: a cleared timeout (null or past) still routes to mod-log", () => {
  const cleared = planAuditEntry(
    entry({ action: AuditLogEvent.MemberUpdate, changes: [{ key: "communication_disabled_until", new: null }] }),
    BOT,
  );
  expect(cleared?.destination).toBe("mod");
  expect(cleared?.toggle).toBe(CONFIG_KEYS.logModActions);
});
