import { type BotDatabase, many, one, run, runChanges } from "../db/index";

export interface TicketRecord {
  id: number;
  guildId: string;
  ticketNumber: number;
  channelId: string;
  openerId: string;
  // May be empty: opening a ticket without saying why is allowed.
  subject: string;
  status: string;
  transcript: string | null;
  createdAt: number;
  closedAt: number | null;
  lastActivityAt: number | null;
  closedBy: string | null;
  closeReason: string | null;
  // 1 while this ticket is exempt from the inactivity auto-close (SQLite has no bool).
  autoCloseHold: number;
}

const COLUMNS = `id, guild_id AS guildId, ticket_number AS ticketNumber, channel_id AS channelId,
  opener_id AS openerId, subject, status, transcript, created_at AS createdAt, closed_at AS closedAt,
  last_activity_at AS lastActivityAt, closed_by AS closedBy, close_reason AS closeReason,
  auto_close_hold AS autoCloseHold`;

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

// Look a ticket up by its per-guild number (for retrieving a closed ticket's transcript,
// after its channel is gone).
export function getTicketByNumber(
  db: BotDatabase,
  guildId: string,
  ticketNumber: number,
): TicketRecord | undefined {
  return one<TicketRecord>(
    db,
    `SELECT ${COLUMNS} FROM tickets WHERE guild_id = ? AND ticket_number = ?`,
    guildId,
    ticketNumber,
  );
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

// Hold a ticket open: while set, the inactivity scan skips it entirely (no warning,
// no auto-close). Only meaningful while open, so a closed row is left alone.
export function setTicketHold(db: BotDatabase, channelId: string, hold: boolean): boolean {
  return (
    runChanges(
      db,
      "UPDATE tickets SET auto_close_hold = ? WHERE channel_id = ? AND status = 'open'",
      hold ? 1 : 0,
      channelId,
    ) > 0
  );
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
  // Set by the inactivity auto-close only: it decides from a snapshot of the open
  // tickets and then does slow per-ticket work, so staff can hold a ticket open in the
  // window between that read and this claim. Testing the flag HERE, inside the same
  // conditional UPDATE, is what makes the hold beat that race. A manual close ignores
  // the flag: holding a ticket open shouldn't stop anyone closing it deliberately.
  opts: { unlessHeld?: boolean } = {},
): boolean {
  return (
    runChanges(
      db,
      `UPDATE tickets SET status = 'closed', closed_by = ?, close_reason = ?, closed_at = ?
       WHERE channel_id = ? AND status = 'open'${opts.unlessHeld ? " AND auto_close_hold = 0" : ""}`,
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
