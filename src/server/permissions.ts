import { PermissionFlagsBits } from "discord.js";

export type PermissionName = keyof typeof PermissionFlagsBits;

const NAMES = Object.keys(PermissionFlagsBits) as PermissionName[];

export const isPermissionName = (name: string): name is PermissionName => name in PermissionFlagsBits;

export const toBits = (names: readonly PermissionName[]): bigint =>
  names.reduce((acc, n) => acc | PermissionFlagsBits[n], 0n);

// Every name whose bit is set, in discord.js's order. Two names share no bit, so this round-trips.
export const toNames = (bits: bigint): PermissionName[] =>
  NAMES.filter((n) => (bits & PermissionFlagsBits[n]) !== 0n);

export interface AllowDeny {
  allow: bigint;
  deny: bigint;
}

// Whether a permission overwrite change lets a role do something it couldn't before: a bit newly
// allowed, or a deny lifted (which hands the decision back to the role's own permissions).
export function widens(before: AllowDeny | null, after: AllowDeny): boolean {
  const was = before ?? { allow: 0n, deny: 0n };
  return (after.allow & ~was.allow) !== 0n || (was.deny & ~after.deny) !== 0n;
}
