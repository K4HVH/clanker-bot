// Moderation action enums shared across guards, the honeypot, and automod's scam rules. One place
// for the choice lists shown in /config and the safe parsers that read them back (a corrupt or
// legacy stored value must fall back to "off", never be trusted as-is).

export type GuardAction = "off" | "flag" | "kick" | "ban";

// Confirmed-bad detections (scam signature match, cross-channel spray). "delete" removes the
// offending content without punishing the user; timeout/kick/ban also penalise.
export type ScamAction = "off" | "flag" | "delete" | "timeout" | "kick" | "ban";

export const GUARD_ACTIONS: { value: GuardAction; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "flag", label: "Flag (alert only)" },
  { value: "kick", label: "Kick" },
  { value: "ban", label: "Ban" },
];

export const SCAM_ACTIONS: { value: ScamAction; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "flag", label: "Flag (alert only)" },
  { value: "delete", label: "Delete (no penalty)" },
  { value: "timeout", label: "Timeout" },
  { value: "kick", label: "Kick" },
  { value: "ban", label: "Ban" },
];

export function parseGuardAction(v: unknown): GuardAction {
  return v === "flag" || v === "kick" || v === "ban" ? v : "off";
}

export function parseScamAction(v: unknown): ScamAction {
  return v === "flag" || v === "delete" || v === "timeout" || v === "kick" || v === "ban" ? v : "off";
}

const RANK: Record<GuardAction, number> = { off: 0, flag: 1, kick: 2, ban: 3 };

// The stronger of two guard actions (ban > kick > flag > off), so several tripped signals collapse
// to the harshest one.
export function strongerAction(a: GuardAction, b: GuardAction): GuardAction {
  return RANK[a] >= RANK[b] ? a : b;
}
