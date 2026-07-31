import { expect, test } from "bun:test";
import {
  beginClose,
  countOpenTicketsByUser,
  createTicket,
  firstOpenTicketByUser,
  getTicketByChannel,
  getTicketByNumber,
  listOpenTickets,
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
