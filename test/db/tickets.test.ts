import { expect, test } from "bun:test";
import {
  closeTicket,
  createTicket,
  getTicketByChannel,
} from "../../src/db/tickets";
import { makeTestDb } from "../helpers/db";

test("ticket numbers increment per guild and close persists a transcript", () => {
  const db = makeTestDb();
  const a = createTicket(db, { guildId: "g", channelId: "c1", openerId: "u", subject: "help" });
  const b = createTicket(db, { guildId: "g", channelId: "c2", openerId: "u", subject: "more" });
  expect(a.ticketNumber).toBe(1);
  expect(b.ticketNumber).toBe(2);
  expect(getTicketByChannel(db, "c1")?.status).toBe("open");
  closeTicket(db, "c1", "hello world", 999);
  const closed = getTicketByChannel(db, "c1");
  expect(closed?.status).toBe("closed");
  expect(closed?.transcript).toBe("hello world");
});
