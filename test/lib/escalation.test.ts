import { expect, test } from "bun:test";
import { escalationActionFor } from "../../src/lib/escalation";

test("maps score bands to actions", () => {
  expect(escalationActionFor(0)).toBeNull();
  expect(escalationActionFor(2)).toBeNull();
  expect(escalationActionFor(3)).toEqual({ type: "timeout", durationMs: 3_600_000 });
  expect(escalationActionFor(5)).toEqual({ type: "timeout", durationMs: 86_400_000 });
  expect(escalationActionFor(8)).toEqual({ type: "kick" });
  expect(escalationActionFor(12)).toEqual({ type: "ban" });
});
