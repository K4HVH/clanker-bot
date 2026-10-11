// Pure decision logic for the verification flow, extracted so it can be
// unit-tested without a live Discord gateway.

export type ChallengeMode = "reuse" | "rotate" | "new";

// Decide what to do with a user's captcha challenge on a fresh render request.
//  - reuse : a live code exists and we're just re-displaying it (e.g. the panel
//            button after an on-join DM), show the SAME code so either surface works.
//  - rotate: a live code exists but we want a fresh one within the SAME deadline
//            (a wrong guess, or "New Code"). Keeping expiresAt stable lets one
//            message collector cover the whole session without realignment.
//  - new   : no live challenge, start one with a fresh TTL.
export function challengeMode(
  existing: { expiresAt: number } | undefined,
  now: number,
  forceNew: boolean,
): ChallengeMode {
  const valid = existing !== undefined && existing.expiresAt > now;
  if (!valid) return "new";
  return forceNew ? "rotate" : "reuse";
}

// A human can't read a distorted, rotated captcha and type it back this fast, so
// a sub-threshold solve is a scripted-signup tell worth flagging.
export const FAST_SOLVE_MS = 1500;

export interface VerifyFlags {
  young: boolean;
  fast: boolean;
}

// Alt-detection signals to raise on a successful verify (owner chose the
// "aggressive" posture). `flagYoungDays === 0` disables the young-account flag.
export function verifyFlags(ageDays: number, flagYoungDays: number, solveMs: number): VerifyFlags {
  return {
    young: flagYoungDays > 0 && ageDays < flagYoungDays,
    fast: solveMs >= 0 && solveMs < FAST_SOLVE_MS,
  };
}

// The captcha alphabet: single source of truth, shared with the renderer.
export const CAPTCHA_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ3479";
const CHARSET_SET = new Set(CAPTCHA_CHARSET);

// Only treat a message as a captcha guess if it's the right length and made only
// of code characters. Ordinary chat ("hello?", "gotcha") is left alone, so it isn't
// deleted or counted as a failed attempt.
export function isCodeShaped(entered: string, codeLength: number): boolean {
  if (entered.length !== codeLength) return false;
  for (const ch of entered) if (!CHARSET_SET.has(ch)) return false;
  return true;
}

// A member interaction's `roles` is a GuildMemberRoleManager (cached member) or a
// raw string[] (uncached API member); check the verified role against either shape.
export function memberHasRole(
  roles: { cache: { has(id: string): boolean } } | string[] | null | undefined,
  roleId: string,
): boolean {
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return roles.cache.has(roleId);
}

// What a member sees once the captcha is solved; it names where to go next when that's set.
export function verifiedText(welcomeChannelId?: string): string {
  return welcomeChannelId ? `✅ You're verified. Welcome! Start in <#${welcomeChannelId}>.` : "✅ You're verified. Welcome!";
}
