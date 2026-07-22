import { expect, test } from "bun:test";
import { attachmentTriple, isSeedableDomain, parseDomainList } from "../../src/lib/scam-seed";

test("isSeedableDomain: a normal scam domain is seedable", () => {
  expect(isSeedableDomain("mrbeast-drop.xyz", [])).toBe(true);
  expect(isSeedableDomain("claim-nitro.gift", [])).toBe(true);
});

test("isSeedableDomain: never seed safe domains or their subdomains", () => {
  expect(isSeedableDomain("discord.com", [])).toBe(false);
  expect(isSeedableDomain("cdn.discordapp.com", [])).toBe(false);
  expect(isSeedableDomain("github.com", [])).toBe(false);
  expect(isSeedableDomain("docs.espressif.com", [])).toBe(false);
});

test("isSeedableDomain: never seed allowlisted domains", () => {
  expect(isSeedableDomain("mycommunity.dev", ["mycommunity.dev"])).toBe(false);
  expect(isSeedableDomain("sub.mycommunity.dev", ["mycommunity.dev"])).toBe(false);
});

test("isSeedableDomain: never seed a shared-hosting apex, but a full subdomain is fine", () => {
  expect(isSeedableDomain("vercel.app", [])).toBe(false); // would block all of Vercel
  expect(isSeedableDomain("pages.dev", [])).toBe(false);
  expect(isSeedableDomain("scam-proj.vercel.app", [])).toBe(true); // the specific scam site
});

test("isSeedableDomain: rejects non-domains", () => {
  expect(isSeedableDomain("notadomain", [])).toBe(false);
  expect(isSeedableDomain("", [])).toBe(false);
});

test("attachmentTriple: only images (with dimensions) get a fingerprint", () => {
  expect(attachmentTriple(12345, 800, 600)).toBe("12345:800:600");
  expect(attachmentTriple(9999, null, null)).toBeNull(); // e.g. a .zip
  expect(attachmentTriple(9999, 800, null)).toBeNull();
});

test("parseDomainList: splits, trims, lowercases, strips www", () => {
  expect(parseDomainList("GitHub.com, www.YouTube.com\nespressif.com")).toEqual([
    "github.com",
    "youtube.com",
    "espressif.com",
  ]);
  expect(parseDomainList("")).toEqual([]);
});
