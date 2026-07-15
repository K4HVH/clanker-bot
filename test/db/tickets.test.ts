import { expect, test } from "bun:test";
import {
  claimTicket,
  closeTicket,
  countOpenTicketsByUser,
  createTicket,
  firstOpenTicketByUser,
  getTicketByChannel,
  listOpenTickets,
} from "../../src/db/tickets";
import { makeTestDb } from "../helpers/db";

test("ticket numbers increment per guild and close persists a transcript", () => {
  const db = makeTestDb();
  const a = createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "help" });
  const b = createTicket(db, { guildId: "g", channelId: "c2", openerId: "u", subject: "more" });
  expect(a.ticketNumber).toBe(1);
  expect(b.ticketNumber).toBe(2);
  expect(getTicketByChannel(db, "c1")?.status).toBe("open");
  closeTicket(db, "c1", { transcript: "hello world", closedBy: "mod", reason: "done", closedAt: 999 });
  const closed = getTicketByChannel(db, "c1");
  expect(closed?.status).toBe("closed");
  expect(closed?.transcript).toBe("hello world");
  expect(closed?.closedBy).toBe("mod");
  expect(closed?.closeReason).toBe("done");
});

test("open-ticket queries: count, first, list, and claim", () => {
  const db = makeTestDb();
  createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "one" });
  createTicket(db, { guildId: "g", channelId: "c2", openerId: "u", subject: "two" });
  createTicket(db, { guildId: "g", channelId: "c3", openerId: "other", subject: "x" });

  expect(countOpenTicketsByUser(db, "g", "u")).toBe(2);
  expect(firstOpenTicketByUser(db, "g", "u")?.channelId).toBe("c1");
  expect(listOpenTickets(db)).toHaveLength(3);

  claimTicket(db, "c1", "staff");
  expect(getTicketByChannel(db, "c1")?.claimedBy).toBe("staff");

  // A closed ticket drops out of the open-count.
  closeTicket(db, "c1", { transcript: "t", closedBy: "u", reason: null, closedAt: 1 });
  expect(countOpenTicketsByUser(db, "g", "u")).toBe(1);
  expect(firstOpenTicketByUser(db, "g", "u")?.channelId).toBe("c2");
});
