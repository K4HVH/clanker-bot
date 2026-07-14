import { expect, test } from "bun:test";
import { type ActionableInput, checkActionable } from "../../src/lib/moderation";

const base: ActionableInput = {
  actorId: "actor",
  targetId: "target",
  botId: "bot",
  guildOwnerId: "owner",
  actorHighestRole: 5,
  targetHighestRole: 2,
  botHighestRole: 6,
  targetIsMember: true,
};

test("allows a valid action", () => {
  expect(checkActionable(base)).toEqual({ ok: true });
});

test("blocks self, bot, and owner targets", () => {
  expect(checkActionable({ ...base, targetId: "actor" }).ok).toBe(false);
  expect(checkActionable({ ...base, targetId: "bot" }).ok).toBe(false);
  expect(checkActionable({ ...base, targetId: "owner" }).ok).toBe(false);
});

test("blocks targets with equal/higher role than the actor or bot", () => {
  expect(checkActionable({ ...base, targetHighestRole: 5 }).ok).toBe(false);
  expect(checkActionable({ ...base, targetHighestRole: 7, actorHighestRole: 8 }).ok).toBe(false);
});

test("skips role checks for non-members (e.g. ban by ID)", () => {
  expect(checkActionable({ ...base, targetIsMember: false, targetHighestRole: 99 })).toEqual({
    ok: true,
  });
});
