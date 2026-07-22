import { expect, test } from "bun:test";
import {
  bumpSignatureHit,
  evictOldest,
  getSignature,
  hasSignature,
  loadSignatures,
  pruneExpiredSignatures,
  removeSignature,
  upsertSignature,
} from "../../src/db/scam-signature";
import { makeTestDb } from "../helpers/db";

const T = 1_000_000;

test("upsert + hasSignature roundtrip per kind, guild-scoped", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "evil.xyz", source: "honeypot" }, T);
  upsertSignature(db, { guildId: "g", kind: "sha256", value: "abc123", source: "honeypot" }, T);
  upsertSignature(db, { guildId: "g", kind: "triple", value: "1000:800:600", source: "honeypot" }, T);
  expect(hasSignature(db, "g", "domain", "evil.xyz", T)).toBe(true);
  expect(hasSignature(db, "g", "sha256", "abc123", T)).toBe(true);
  expect(hasSignature(db, "g", "triple", "1000:800:600", T)).toBe(true);
  expect(hasSignature(db, "g", "domain", "good.com", T)).toBe(false);
  expect(hasSignature(db, "other", "domain", "evil.xyz", T)).toBe(false);
});

test("loadSignatures groups by kind and excludes expired", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "evil.xyz", source: "honeypot", expiresAt: T + 1000 }, T);
  upsertSignature(db, { guildId: "g", kind: "domain", value: "old.xyz", source: "honeypot", expiresAt: T - 1 }, T);
  upsertSignature(db, { guildId: "g", kind: "sha256", value: "deadbeef", source: "honeypot" }, T);
  const sets = loadSignatures(db, "g", T);
  expect(sets.domain.has("evil.xyz")).toBe(true);
  expect(sets.domain.has("old.xyz")).toBe(false); // expired
  expect(sets.sha256.has("deadbeef")).toBe(true);
});

test("upsert conflict bumps hits and refreshes last_seen, keeps first_seen", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "evil.xyz", source: "honeypot" }, T);
  upsertSignature(db, { guildId: "g", kind: "domain", value: "evil.xyz", source: "manual" }, T + 500);
  const row = getSignature(db, "g", "domain", "evil.xyz");
  expect(row?.hits).toBe(1); // 0 on insert, +1 on the conflicting re-seed
  expect(row?.lastSeen).toBe(T + 500);
  expect(row?.firstSeen).toBe(T);
});

test("bumpSignatureHit increments hits and last_seen", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "evil.xyz", source: "honeypot" }, T);
  bumpSignatureHit(db, "g", "domain", "evil.xyz", T + 100);
  const row = getSignature(db, "g", "domain", "evil.xyz");
  expect(row?.hits).toBe(1);
  expect(row?.lastSeen).toBe(T + 100);
});

test("pruneExpiredSignatures removes only expired (null = never)", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "keep.xyz", source: "honeypot", expiresAt: T + 1000 }, T);
  upsertSignature(db, { guildId: "g", kind: "domain", value: "gone.xyz", source: "honeypot", expiresAt: T - 1 }, T);
  upsertSignature(db, { guildId: "g", kind: "domain", value: "forever.xyz", source: "feed", expiresAt: null }, T);
  expect(pruneExpiredSignatures(db, T)).toBe(1);
  expect(hasSignature(db, "g", "domain", "keep.xyz", T)).toBe(true);
  expect(hasSignature(db, "g", "domain", "forever.xyz", T)).toBe(true);
  expect(getSignature(db, "g", "domain", "gone.xyz")).toBeUndefined();
});

test("evictOldest keeps the newest by last_seen", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "a", source: "honeypot" }, T);
  upsertSignature(db, { guildId: "g", kind: "domain", value: "b", source: "honeypot" }, T + 100);
  upsertSignature(db, { guildId: "g", kind: "domain", value: "c", source: "honeypot" }, T + 200);
  expect(evictOldest(db, "g", "domain", 2)).toBe(1); // drops the oldest, "a"
  expect(hasSignature(db, "g", "domain", "a", T + 300)).toBe(false);
  expect(hasSignature(db, "g", "domain", "b", T + 300)).toBe(true);
  expect(hasSignature(db, "g", "domain", "c", T + 300)).toBe(true);
});

test("removeSignature deletes a specific entry", () => {
  const db = makeTestDb();
  upsertSignature(db, { guildId: "g", kind: "domain", value: "evil.xyz", source: "honeypot" }, T);
  expect(removeSignature(db, "g", "domain", "evil.xyz")).toBe(1);
  expect(hasSignature(db, "g", "domain", "evil.xyz", T)).toBe(false);
});
