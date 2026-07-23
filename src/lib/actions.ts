// Moderation action enums shared across guards, automod, the honeypot, and anti-scam — one place
// for the choice lists shown in /config and the safe parsers that read them back (a corrupt or
// legacy stored value must fall back to "off", never be trusted as-is).

export type GuardAction = "off" | "flag" | "kick" | "ban";
export type SprayAction = "off" | "flag" | "timeout" | "kick" | "ban";
export type BlocklistAction = "off" | "flag" | "delete" | "ban";

export const GUARD_ACTIONS: { value: GuardAction; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "flag", label: "Flag (alert only)" },
  { value: "kick", label: "Kick" },
  { value: "ban", label: "Ban" },
];

export const SPRAY_ACTIONS: { value: SprayAction; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "flag", label: "Flag (alert only)" },
  { value: "timeout", label: "Timeout" },
  { value: "kick", label: "Kick" },
  { value: "ban", label: "Ban" },
];

export const BLOCKLIST_ACTIONS: { value: BlocklistAction; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "flag", label: "Flag (alert only)" },
  { value: "delete", label: "Delete + record violation" },
  { value: "ban", label: "Ban" },
];

export function parseGuardAction(v: unknown): GuardAction {
  return v === "flag" || v === "kick" || v === "ban" ? v : "off";
}

export function parseSprayAction(v: unknown): SprayAction {
  return v === "flag" || v === "timeout" || v === "kick" || v === "ban" ? v : "off";
}

export function parseBlocklistAction(v: unknown): BlocklistAction {
  return v === "flag" || v === "delete" || v === "ban" ? v : "off";
}

const RANK: Record<GuardAction, number> = { off: 0, flag: 1, kick: 2, ban: 3 };

// The stronger of two guard actions (ban > kick > flag > off), so several tripped signals collapse
// to the harshest one.
export function strongerAction(a: GuardAction, b: GuardAction): GuardAction {
  return RANK[a] >= RANK[b] ? a : b;
}
