import { expect, test } from "bun:test";
import type { CaseRecord } from "../../src/db/cases";
import { buildCaseEmbed, buildMemberJoinEmbed } from "../../src/lib/modlog";

const record: CaseRecord = {
  id: 1,
  guildId: "g1",
  caseNumber: 7,
  userId: "u1",
  moderatorId: "m1",
  type: "ban",
  reason: "spam",
  meta: null,
  createdAt: 1_700_000_000_000,
};

test("case embed shows number, type, and fields", () => {
  const data = buildCaseEmbed(record).data;
  expect(data.title).toBe("Case #7 · BAN");
  const fieldNames = (data.fields ?? []).map((f) => f.name);
  expect(fieldNames).toEqual(["User", "Moderator", "Reason"]);
  expect((data.fields ?? [])[2]?.value).toBe("spam");
});

test("member join embed references the user", () => {
  const data = buildMemberJoinEmbed({ userId: "u9", createdAt: 1_700_000_000_000 }).data;
  expect(data.title).toBe("Member joined");
  expect((data.fields ?? [])[0]?.value).toContain("u9");
});
