import { expect, test } from "bun:test";
import type { CaseRecord } from "../../src/db/cases";
import type { Guild } from "discord.js";
import type { AppContext } from "../../src/core/context";
import { CONFIG_KEYS } from "../../src/lib/config";
import {
  buildCaseEmbed,
  buildMemberJoinEmbed,
  buildMemberLeaveEmbed,
  logMemberEvent,
} from "../../src/lib/modlog";
import { silentContext } from "../helpers/fakes";

function fieldsOf(embed: { data: { fields?: { name: string; value: string }[] } }) {
  return Object.fromEntries((embed.data.fields ?? []).map((f) => [f.name, f.value]));
}

const record: CaseRecord = {
  id: 1,
  guildId: "g1",
  caseNumber: 7,
  userId: "u1",
  moderatorId: "m1",
  type: "ban",
  reason: "spam",
  createdAt: 1_700_000_000_000,
};

test("action embed shows the action (no case number), type, and fields", () => {
  const data = buildCaseEmbed(record).data;
  expect(data.title).toBe("🔨 Ban");
  const fieldNames = (data.fields ?? []).map((f) => f.name);
  expect(fieldNames).toEqual(["User", "Moderator", "Reason"]);
  expect((data.fields ?? [])[2]?.value).toBe("spam");
});

test("member join embed references the user", () => {
  const data = buildMemberJoinEmbed({ userId: "u9", createdAt: 1_700_000_000_000 }).data;
  expect(data.title).toBe("Member joined");
  expect((data.fields ?? [])[0]?.value).toContain("u9");
});

test("member leave embed reports tenure and the roles they held", () => {
  const fields = fieldsOf(
    buildMemberLeaveEmbed({
      userId: "u9",
      createdAt: 1_600_000_000_000,
      joinedAt: 1_700_000_000_000,
      leftAt: 1_700_000_000_000 + 3 * 86_400_000 + 4 * 3_600_000,
      roleIds: ["r1", "r2"],
    }),
  );
  expect(fields.User).toContain("u9");
  expect(fields["Account created"]).toBe("<t:1600000000:R>");
  expect(fields["Joined server"]).toBe("<t:1700000000:D>");
  expect(fields["Time in server"]).toBe("3 days, 4 hours");
  expect(fields["Roles held"]).toBe("<@&r1> <@&r2>");
});

test("member leave embed cannot state a tenure without both ends of it", () => {
  // Join known but the leave moment missing, or the reverse: neither yields a real span.
  const noLeft = fieldsOf(buildMemberLeaveEmbed({ userId: "u9", joinedAt: 1_700_000_000_000 }));
  expect(noLeft["Time in server"]).toBe("*unknown*");
  const noJoin = fieldsOf(buildMemberLeaveEmbed({ userId: "u9", leftAt: 1_700_000_000_000 }));
  expect(noJoin["Time in server"]).toBe("*unknown*");
});

test("member leave embed distinguishes no roles from unknown roles", () => {
  expect(fieldsOf(buildMemberLeaveEmbed({ userId: "u9", roleIds: [] }))["Roles held"]).toBe(
    "*none*",
  );
  // An uncached member: nothing was ever known about their roles or join date.
  const unknown = fieldsOf(buildMemberLeaveEmbed({ userId: "u9" }));
  expect(unknown["Roles held"]).toBe("*unknown*");
  expect(unknown["Joined server"]).toBe("*unknown*");
  expect(unknown["Time in server"]).toBe("*unknown*");
});

test("a configured log channel that cannot be posted to warns instead of dropping silently", async () => {
  const warnings: string[] = [];
  const ctx = silentContext();
  ctx.logger = { ...ctx.logger, warn: (msg: string) => warnings.push(msg) } as AppContext["logger"];
  ctx.config.set("g1", CONFIG_KEYS.memberLogChannelId, "c-log");
  const guild = {
    id: "g1",
    channels: {
      cache: new Map([
        ["c-log", { isTextBased: () => true, send: async () => Promise.reject(new Error("Missing Permissions")) }],
      ]),
    },
  } as unknown as Guild;

  await logMemberEvent(ctx, guild, buildMemberLeaveEmbed({ userId: "u9" }));
  expect(warnings).toEqual(["could not post to the log channel: dropped a log line"]);
});

test("an unset log channel stays silent: opting out is not a fault", async () => {
  const warnings: string[] = [];
  const ctx = silentContext();
  ctx.logger = { ...ctx.logger, warn: (msg: string) => warnings.push(msg) } as AppContext["logger"];
  const guild = { id: "g1", channels: { cache: new Map() } } as unknown as Guild;

  await logMemberEvent(ctx, guild, buildMemberLeaveEmbed({ userId: "u9" }));
  expect(warnings).toEqual([]);
});
