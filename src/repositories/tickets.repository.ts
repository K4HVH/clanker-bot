import { eq, sql } from "drizzle-orm";
import type { BotDatabase } from "../db/client";
import { tickets } from "../db/schema";

export interface TicketRecord {
  id: number;
  guildId: string;
  ticketNumber: number;
  channelId: string;
  openerId: string;
  subject: string;
  status: string;
  transcript: string | null;
  createdAt: number;
  closedAt: number | null;
}

export function createTicket(
  db: BotDatabase,
  input: { guildId: string; channelId: string; openerId: string; subject: string },
): TicketRecord {
  return db.transaction((tx) => {
    const row = tx
      .select({ max: sql<number | null>`max(${tickets.ticketNumber})` })
      .from(tickets)
      .where(eq(tickets.guildId, input.guildId))
      .get();
    return tx
      .insert(tickets)
      .values({
        guildId: input.guildId,
        ticketNumber: (row?.max ?? 0) + 1,
        channelId: input.channelId,
        openerId: input.openerId,
        subject: input.subject,
        status: "open",
        transcript: null,
        createdAt: Date.now(),
        closedAt: null,
      })
      .returning()
      .get() as TicketRecord;
  });
}

export function getTicketByChannel(db: BotDatabase, channelId: string): TicketRecord | undefined {
  return db.select().from(tickets).where(eq(tickets.channelId, channelId)).get() as
    | TicketRecord
    | undefined;
}

export function closeTicket(
  db: BotDatabase,
  channelId: string,
  transcript: string,
  closedAt: number,
): void {
  db.update(tickets)
    .set({ status: "closed", transcript, closedAt })
    .where(eq(tickets.channelId, channelId))
    .run();
}
