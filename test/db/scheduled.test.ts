import { expect, test } from "bun:test";
import {
  deleteScheduledAction,
  dueActions,
  scheduleAction,
} from "../../src/db/scheduled";
import { makeTestDb } from "../helpers/db";

test("dueActions returns only actions at or before now, oldest first", () => {
  const db = makeTestDb();
  scheduleAction(db, { guildId: "g", type: "unban", userId: "u1", runAt: 100 });
  scheduleAction(db, { guildId: "g", type: "unban", userId: "u2", runAt: 300 });
  const due = dueActions(db, 200);
  expect(due.map((a) => a.userId)).toEqual(["u1"]);
});

test("delete removes an action", () => {
  const db = makeTestDb();
  const a = scheduleAction(db, { guildId: "g", type: "unban", userId: "u", runAt: 1 });
  deleteScheduledAction(db, a.id);
  expect(dueActions(db, 10).length).toBe(0);
});
