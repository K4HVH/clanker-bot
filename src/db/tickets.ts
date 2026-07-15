import { type BotDatabase, many, one, run, runChanges } from "../db/index";

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
  claimedBy: string | null;
  lastActivityAt: number | null;
  closedBy: string | null;
  closeReason: string | null;
}

const COLUMNS = `id, guild_id AS guildId, ticket_number AS ticketNumber, channel_id AS channelId,
  opener_id AS openerId, subject, status, transcript, created_at AS createdAt, closed_at AS closedAt,
  claimed_by AS claimedBy, last_activity_at AS lastActivityAt, closed_by AS closedBy,
  close_reason AS closeReason`;

export function createTicket(
  db: BotDatabase,
  input: { guildId: string; channelId: string; openerId: string; subject: string },
): TicketRecord {
  const insert = db.transaction((i: typeof input): TicketRecord => {
    const now = Date.now();
    const row = one<{ max: number | null }>(
      db,
      "SELECT MAX(ticket_number) AS max FROM tickets WHERE guild_id = ?",
      i.guildId,
    );
    const nextNumber = (row?.max ?? 0) + 1;
    const created = one<TicketRecord>(
      db,
      `INSERT INTO tickets (guild_id, ticket_number, channel_id, opener_id, subject, status, transcript, created_at, closed_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL, ?) RETURNING ${COLUMNS}`,
      i.guildId,
      nextNumber,
      i.channelId,
      i.openerId,
      i.subject,
      now,
      now,
    );
    if (!created) throw new Error("failed to insert ticket");
    return created;
  });
  return insert(input);
}

export function getTicketByChannel(db: BotDatabase, channelId: string): TicketRecord | undefined {
  return one<TicketRecord>(db, `SELECT ${COLUMNS} FROM tickets WHERE channel_id = ?`, channelId);
}

export function countOpenTicketsByUser(
  db: BotDatabase,
  guildId: string,
  openerId: string,
): number {
  return (
    one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = 'open'",
      guildId,
      openerId,
    )?.n ?? 0
  );
}

export function firstOpenTicketByUser(
  db: BotDatabase,
  guildId: string,
  openerId: string,
): TicketRecord | undefined {
  return one<TicketRecord>(
    db,
    `SELECT ${COLUMNS} FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = 'open'
     ORDER BY ticket_number ASC LIMIT 1`,
    guildId,
    openerId,
  );
}

export function listOpenTickets(db: BotDatabase): TicketRecord[] {
  return many<TicketRecord>(db, `SELECT ${COLUMNS} FROM tickets WHERE status = 'open'`);
}

// Update the last-activity clock (only for open tickets, so a closed one is inert).
export function touchTicketActivity(db: BotDatabase, channelId: string, at: number): void {
  run(
    db,
    "UPDATE tickets SET last_activity_at = ? WHERE channel_id = ? AND status = 'open'",
    at,
    channelId,
  );
}

export function claimTicket(db: BotDatabase, channelId: string, staffId: string): void {
  run(db, "UPDATE tickets SET claimed_by = ? WHERE channel_id = ?", staffId, channelId);
}

// Atomically claim the close: flips status to 'closed' only if it's still 'open',
// returning true for the caller that won. This serializes concurrent close triggers
// (button / command / auto-close) so only one archives + deletes. The transcript is
// filled in afterwards via setTicketTranscript once it's built.
export function beginClose(
  db: BotDatabase,
  channelId: string,
  closedBy: string,
  reason: string | null,
  closedAt: number,
): boolean {
  return (
    runChanges(
      db,
      `UPDATE tickets SET status = 'closed', closed_by = ?, close_reason = ?, closed_at = ?
       WHERE channel_id = ? AND status = 'open'`,
      closedBy,
      reason,
      closedAt,
      channelId,
    ) > 0
  );
}

export function setTicketTranscript(db: BotDatabase, channelId: string, transcript: string): void {
  run(db, "UPDATE tickets SET transcript = ? WHERE channel_id = ?", transcript, channelId);
}
