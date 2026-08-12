import { expect, test } from "bun:test";
import {
  beginClose,
  countOpenTicketsByUser,
  createTicket,
  firstOpenTicketByUser,
  getTicketByChannel,
  getTicketByNumber,
  listOpenTickets,
  setTicketHold,
  setTicketTranscript,
} from "../../src/db/tickets";
import { makeTestDb } from "../helpers/db";

test("getTicketByNumber finds a ticket (incl. closed) for transcript retrieval", () => {
  const db = makeTestDb();
  createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "help" });
  createTicket(db, { guildId: "other", channelId: "c9", openerId: "u", subject: "elsewhere" });

  // Scoped per guild: #1 in "g" is not #1 in "other".
  expect(getTicketByNumber(db, "g", 1)?.channelId).toBe("c1");
  expect(getTicketByNumber(db, "g", 2)).toBeUndefined();

  // Still retrievable after close, with its saved transcript.
  beginClose(db, "c1", "mod", null, 1);
  setTicketTranscript(db, "c1", "the whole conversation");
  const closed = getTicketByNumber(db, "g", 1);
  expect(closed?.status).toBe("closed");
  expect(closed?.transcript).toBe("the whole conversation");
});

test("ticket numbers increment per guild; close is atomic and persists a transcript", () => {
  const db = makeTestDb();
  const a = createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "help" });
  const b = createTicket(db, { guildId: "g", channelId: "c2", openerId: "u", subject: "more" });
  expect(a.ticketNumber).toBe(1);
  expect(b.ticketNumber).toBe(2);
  expect(getTicketByChannel(db, "c1")?.status).toBe("open");

  // beginClose claims the close exactly once: a concurrent second trigger loses.
  expect(beginClose(db, "c1", "mod", "done", 999)).toBe(true);
  expect(beginClose(db, "c1", "mod2", "again", 1000)).toBe(false);
  setTicketTranscript(db, "c1", "hello world");

  const closed = getTicketByChannel(db, "c1");
  expect(closed?.status).toBe("closed");
  expect(closed?.transcript).toBe("hello world");
  expect(closed?.closedBy).toBe("mod");
  expect(closed?.closeReason).toBe("done");
});

test("auto-close hold is off by default, toggles, and is inert once closed", () => {
  const db = makeTestDb();
  createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "slow burner" });
  expect(getTicketByChannel(db, "c1")?.autoCloseHold).toBe(0);

  setTicketHold(db, "c1", true);
  expect(getTicketByChannel(db, "c1")?.autoCloseHold).toBe(1);
  setTicketHold(db, "c1", false);
  expect(getTicketByChannel(db, "c1")?.autoCloseHold).toBe(0);

  // A closed ticket can't be held: the row is finished.
  setTicketHold(db, "c1", true);
  beginClose(db, "c1", "mod", null, 1);
  setTicketHold(db, "c1", false);
  expect(getTicketByChannel(db, "c1")?.autoCloseHold).toBe(1);
});

test("the auto-close claim loses to a hold applied since the scan read the row", () => {
  const db = makeTestDb();
  createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "waiting on a part" });

  // The inactivity scan works from a snapshot, then does slow per-ticket archiving: staff
  // can hold a ticket in the gap. The auto-close claim must lose that race...
  setTicketHold(db, "c1", true);
  expect(beginClose(db, "c1", "bot", "Auto-closed after 24h of inactivity", 5, { unlessHeld: true })).toBe(false);
  expect(getTicketByChannel(db, "c1")?.status).toBe("open");

  // ...while a deliberate close still goes through: a hold isn't a lock.
  expect(beginClose(db, "c1", "mod", "done", 6)).toBe(true);
  expect(getTicketByChannel(db, "c1")?.status).toBe("closed");
});

test("a ticket can be opened with no subject", () => {
  const db = makeTestDb();
  const t = createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "" });
  expect(t.subject).toBe("");
  expect(getTicketByChannel(db, "c1")?.subject).toBe("");
});

test("open-ticket queries: count, first, list", () => {
  const db = makeTestDb();
  createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "one" });
  createTicket(db, { guildId: "g", channelId: "c2", openerId: "u", subject: "two" });
  createTicket(db, { guildId: "g", channelId: "c3", openerId: "other", subject: "x" });

  expect(countOpenTicketsByUser(db, "g", "u")).toBe(2);
  expect(firstOpenTicketByUser(db, "g", "u")?.channelId).toBe("c1");
  expect(listOpenTickets(db)).toHaveLength(3);

  beginClose(db, "c1", "u", null, 1);
  expect(countOpenTicketsByUser(db, "g", "u")).toBe(1);
  expect(firstOpenTicketByUser(db, "g", "u")?.channelId).toBe("c2");
});
