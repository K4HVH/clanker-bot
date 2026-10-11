import { PermissionFlagsBits } from "discord.js";

export type PermissionName = keyof typeof PermissionFlagsBits;

// One name per bit. discord.js keeps a deprecated alias beside its replacement (ManageEmojisAndStickers
// and ManageGuildExpressions are one bit); the later name is the current one.
const NAMES = (() => {
  const byBit = new Map<bigint, PermissionName>();
  for (const name of Object.keys(PermissionFlagsBits) as PermissionName[]) byBit.set(PermissionFlagsBits[name], name);
  return (Object.keys(PermissionFlagsBits) as PermissionName[]).filter((n) => byBit.get(PermissionFlagsBits[n]) === n);
})();

export const isPermissionName = (name: string): name is PermissionName => name in PermissionFlagsBits;

export const toBits = (names: readonly PermissionName[]): bigint =>
  names.reduce((acc, n) => acc | PermissionFlagsBits[n], 0n);

// Every bit discord.js has a name for. Discord still reports bits for features it retired; a spec
// can't name those, so plans keep whatever the live server has in them.
export const NAMED: bigint = toBits(Object.keys(PermissionFlagsBits) as PermissionName[]);

export const keepUnnamed = (wanted: bigint, live: bigint): bigint => wanted | (live & ~NAMED);

// Every name whose bit is set, in discord.js's order.
export const toNames = (bits: bigint): PermissionName[] =>
  NAMES.filter((n) => (bits & PermissionFlagsBits[n]) !== 0n);

export interface AllowDeny {
  allow: bigint;
  deny: bigint;
}

// Whether a permission overwrite change lets a role do something it couldn't before: a bit newly
// allowed, or a deny lifted (which hands the decision back to the role's permissions).
export function widens(before: AllowDeny | null, after: AllowDeny): boolean {
  const was = before ?? { allow: 0n, deny: 0n };
  return (after.allow & ~was.allow) !== 0n || (was.deny & ~after.deny) !== 0n;
}

// A permission as Discord's menus name it: "SendMessages" -> "Send Messages".
export const prettyPermission = (name: string): string =>
  name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");

export const permissionDiff = (from: bigint, to: bigint): string =>
  [...toNames(to & ~from).map((n) => `+${prettyPermission(n)}`), ...toNames(from & ~to).map((n) => `-${prettyPermission(n)}`)].join(" ");
