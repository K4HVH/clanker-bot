import { expect, test } from "bun:test";
import type { CaseRecord } from "../../src/db/cases";
import { buildCaseEmbed, buildMemberJoinEmbed, buildMemberLeaveEmbed } from "../../src/lib/modlog";

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
      roleIds: ["r1", "r2"],
    }),
  );
  expect(fields.User).toContain("u9");
  expect(fields["Account created"]).toBe("<t:1600000000:R>");
  expect(fields["Joined server"]).toBe("<t:1700000000:D> (<t:1700000000:R>)");
  expect(fields["Roles held"]).toBe("<@&r1> <@&r2>");
});

test("member leave embed distinguishes no roles from unknown roles", () => {
  expect(fieldsOf(buildMemberLeaveEmbed({ userId: "u9", roleIds: [] }))["Roles held"]).toBe(
    "*none*",
  );
  // An uncached member: nothing was ever known about their roles or join date.
  const unknown = fieldsOf(buildMemberLeaveEmbed({ userId: "u9" }));
  expect(unknown["Roles held"]).toBe("*unknown*");
  expect(unknown["Joined server"]).toBe("*unknown*");
});
