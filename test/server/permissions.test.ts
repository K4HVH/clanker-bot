import { expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { toBits, toNames, widens } from "../../src/server/permissions";

const V = PermissionFlagsBits.ViewChannel;
const S = PermissionFlagsBits.SendMessages;

test("names become bits and back", () => {
  expect(toBits(["ViewChannel", "SendMessages"])).toBe(V | S);
  expect(toNames(V | S)).toEqual(["ViewChannel", "SendMessages"]);
  expect(toBits([])).toBe(0n);
});

test("removing a deny widens", () => {
  expect(widens({ allow: 0n, deny: V }, { allow: 0n, deny: 0n })).toBe(true);
});

test("a new allow widens", () => {
  expect(widens(null, { allow: V, deny: 0n })).toBe(true);
  expect(widens({ allow: 0n, deny: 0n }, { allow: S, deny: 0n })).toBe(true);
});

test("turning an allow into a deny narrows", () => {
  expect(widens({ allow: V, deny: 0n }, { allow: 0n, deny: V })).toBe(false);
  expect(widens(null, { allow: 0n, deny: V })).toBe(false);
});

test("an aliased bit is named once, by its current name", () => {
  expect(toNames(PermissionFlagsBits.ManageGuildExpressions)).toEqual(["ManageGuildExpressions"]);
});
