import { type BotDatabase, many, one, run, runChanges } from "../db/index";

export type SignatureKind = "domain" | "sha256" | "triple";

export interface SignatureRow {
  guildId: string;
  kind: string;
  value: string;
  source: string;
  caseId: number | null;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  expiresAt: number | null;
}

const COLUMNS = `guild_id AS guildId, kind, value, source, case_id AS caseId, hits,
  first_seen AS firstSeen, last_seen AS lastSeen, expires_at AS expiresAt`;

export interface NewSignature {
  guildId: string;
  kind: SignatureKind;
  value: string;
  source: "honeypot" | "manual" | "feed";
  caseId?: number | null;
  expiresAt?: number | null; // absolute ms; null/undefined = never expires
}

// Insert a signature, or on a repeat of the same (guild, kind, value) bump its hit count and
// refresh last_seen + expiry (re-seeing a scam extends its life). first_seen is preserved.
export function upsertSignature(db: BotDatabase, input: NewSignature, now: number): void {
  run(
    db,
    `INSERT INTO scam_signature (guild_id, kind, value, source, case_id, hits, first_seen, last_seen, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (guild_id, kind, value) DO UPDATE SET
       hits = hits + 1,
       last_seen = excluded.last_seen,
       expires_at = excluded.expires_at,
       source = excluded.source`,
    input.guildId,
    input.kind,
    input.value,
    input.source,
    input.caseId ?? null,
    now,
    now,
    input.expiresAt ?? null,
  );
}

// True when a live (non-expired) signature exists. A read; the hot path uses loadSignatures.
export function hasSignature(
  db: BotDatabase,
  guildId: string,
  kind: SignatureKind,
  value: string,
  now: number,
): boolean {
  const row = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM scam_signature
     WHERE guild_id = ? AND kind = ? AND value = ? AND (expires_at IS NULL OR expires_at > ?)`,
    guildId,
    kind,
    value,
    now,
  );
  return (row?.n ?? 0) > 0;
}

export function getSignature(
  db: BotDatabase,
  guildId: string,
  kind: SignatureKind,
  value: string,
): SignatureRow | undefined {
  return one<SignatureRow>(
    db,
    `SELECT ${COLUMNS} FROM scam_signature WHERE guild_id = ? AND kind = ? AND value = ?`,
    guildId,
    kind,
    value,
  );
}

// All live signatures for a guild, grouped into sets by kind for O(1) membership checks. Loaded
// into memory at boot and refreshed on write; SQLite is persistence only.
export function loadSignatures(
  db: BotDatabase,
  guildId: string,
  now: number,
): { domain: Set<string>; sha256: Set<string>; triple: Set<string> } {
  const rows = many<{ kind: string; value: string }>(
    db,
    `SELECT kind, value FROM scam_signature
     WHERE guild_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    guildId,
    now,
  );
  const out = { domain: new Set<string>(), sha256: new Set<string>(), triple: new Set<string>() };
  for (const r of rows) {
    if (r.kind === "domain") out.domain.add(r.value);
    else if (r.kind === "sha256") out.sha256.add(r.value);
    else if (r.kind === "triple") out.triple.add(r.value);
  }
  return out;
}

// Record that a signature matched again (a later account posting the same scam).
export function bumpSignatureHit(
  db: BotDatabase,
  guildId: string,
  kind: SignatureKind,
  value: string,
  now: number,
): void {
  run(
    db,
    `UPDATE scam_signature SET hits = hits + 1, last_seen = ?
     WHERE guild_id = ? AND kind = ? AND value = ?`,
    now,
    guildId,
    kind,
    value,
  );
}

// Delete expired signatures. Returns the number removed. Run periodically on the scheduler tick.
export function pruneExpiredSignatures(db: BotDatabase, now: number): number {
  return runChanges(
    db,
    "DELETE FROM scam_signature WHERE expires_at IS NOT NULL AND expires_at <= ?",
    now,
  );
}

// Keep at most `max` signatures for a (guild, kind); evict the oldest by last_seen. Returns how
// many were removed. Bounds self-seeded growth.
export function evictOldest(
  db: BotDatabase,
  guildId: string,
  kind: SignatureKind,
  max: number,
): number {
  return runChanges(
    db,
    `DELETE FROM scam_signature
     WHERE guild_id = ? AND kind = ? AND value NOT IN (
       SELECT value FROM scam_signature WHERE guild_id = ? AND kind = ?
       ORDER BY last_seen DESC LIMIT ?
     )`,
    guildId,
    kind,
    guildId,
    kind,
    max,
  );
}

// Remove a specific signature (a moderator's "not a scam" correction). Returns rows deleted.
export function removeSignature(
  db: BotDatabase,
  guildId: string,
  kind: SignatureKind,
  value: string,
): number {
  return runChanges(
    db,
    "DELETE FROM scam_signature WHERE guild_id = ? AND kind = ? AND value = ?",
    guildId,
    kind,
    value,
  );
}
