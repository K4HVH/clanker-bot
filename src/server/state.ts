import { type BotDatabase, many, one, run } from "../db/index";

export type StateKind = "role" | "channel" | "automod" | "post" | "asset" | "backup";

// `${kind}:${key}` -> Discord id (for an asset, the applied file's hash).
export type State = Map<string, string>;

export const stateKey = (kind: StateKind, key: string): string => `${kind}:${key}`;

export function loadState(db: BotDatabase, guildId: string): State {
  const rows = many<{ kind: string; key: string; id: string }>(
    db,
    "SELECT kind, key, discord_id AS id FROM server_state WHERE guild_id = ?",
    guildId,
  );
  return new Map(rows.map((r) => [`${r.kind}:${r.key}`, r.id]));
}

export function putState(db: BotDatabase, guildId: string, kind: StateKind, key: string, id: string): void {
  run(
    db,
    `INSERT INTO server_state (guild_id, kind, key, discord_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, kind, key) DO UPDATE SET discord_id = excluded.discord_id`,
    guildId,
    kind,
    key,
    id,
  );
}

export function dropState(db: BotDatabase, guildId: string, kind: StateKind, key: string): void {
  run(db, "DELETE FROM server_state WHERE guild_id = ? AND kind = ? AND key = ?", guildId, kind, key);
}

export function getSpecName(db: BotDatabase, guildId: string): string | undefined {
  return one<{ spec: string }>(db, "SELECT spec FROM server_meta WHERE guild_id = ?", guildId)?.spec;
}

export function setSpecName(db: BotDatabase, guildId: string, spec: string): void {
  run(
    db,
    `INSERT INTO server_meta (guild_id, spec) VALUES (?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET spec = excluded.spec`,
    guildId,
    spec,
  );
}

export function markApplied(db: BotDatabase, guildId: string, at: number): void {
  run(db, "UPDATE server_meta SET applied_at = ? WHERE guild_id = ?", at, guildId);
}
