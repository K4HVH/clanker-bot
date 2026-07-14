import { type BotDatabase, one, run } from "../db/index";

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

const COLUMNS = `id, guild_id AS guildId, ticket_number AS ticketNumber, channel_id AS channelId,
  opener_id AS openerId, subject, status, transcript, created_at AS createdAt, closed_at AS closedAt`;

export function createTicket(
  db: BotDatabase,
  input: { guildId: string; channelId: string; openerId: string; subject: string },
): TicketRecord {
  const insert = db.transaction((i: typeof input): TicketRecord => {
    const row = one<{ max: number | null }>(
      db,
      "SELECT MAX(ticket_number) AS max FROM tickets WHERE guild_id = ?",
      i.guildId,
    );
    const nextNumber = (row?.max ?? 0) + 1;
    const created = one<TicketRecord>(
      db,
      `INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, transcript, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL) RETURNING ${COLUMNS}`,
      i.guildId,
      nextNumber,
      i.channelId,
      i.openerId,
      i.subject,
      Date.now(),
    );
    if (!created) throw new Error("failed to insert ticket");
    return created;
  });
  return insert(input);
}

export function getTicketByChannel(db: BotDatabase, channelId: string): TicketRecord | undefined {
  return one<TicketRecord>(db, `SELECT ${COLUMNS} FROM tickets WHERE channel_id = ?`, channelId);
}

export function closeTicket(
  db: BotDatabase,
  channelId: string,
  transcript: string,
  closedAt: number,
): void {
  run(
    db,
    "UPDATE tickets SET status = 'closed', transcript = ?, closed_at = ? WHERE channel_id = ?",
    transcript,
    closedAt,
    channelId,
  );
}
