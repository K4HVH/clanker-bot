import { expect, test } from "bun:test";
import {
  checkContent,
  type ContentRules,
  decideEscalation,
  hasUnallowedLink,
  isCapsSpam,
  type Tier,
} from "../../src/lib/automod";

const base: ContentRules = {
  invites: false,
  links: false,
  linkAllowlist: "",
  wordBlocklist: "",
  mentionLimit: 0,
  massMention: false,
  caps: false,
};
const noCtx = { mentionCount: 0, massMention: false };

test("invites: catches multiple hosts, only when enabled", () => {
  const on: ContentRules = { ...base, invites: true };
  expect(checkContent("join discord.gg/abc123", noCtx, on)).toBe("invite link");
  expect(checkContent("https://discord.com/invite/xyz", noCtx, on)).toBe("invite link");
  expect(checkContent("dsc.gg/coolserver", noCtx, on)).toBe("invite link");
  expect(checkContent("discord.gg/abc", noCtx, base)).toBeNull(); // disabled
});

test("mentions: limit (0=off) and @everyone/@here via the ping flag", () => {
  expect(checkContent("hi", { mentionCount: 6, massMention: false }, { ...base, mentionLimit: 5 })).toBe(
    "excessive mentions",
  );
  expect(checkContent("hi", { mentionCount: 6, massMention: false }, { ...base, mentionLimit: 0 })).toBeNull();
  // Uses the real ping flag, not text — "@everyone" in a code block (flag false) is NOT flagged.
  expect(checkContent("real ping", { mentionCount: 0, massMention: true }, { ...base, massMention: true })).toBe(
    "@everyone / @here",
  );
  expect(
    checkContent("`@everyone` in code", { mentionCount: 0, massMention: false }, { ...base, massMention: true }),
  ).toBeNull();
});

test("word blocklist: whole-word (no Scunthorpe) + /regex/", () => {
  const on: ContentRules = { ...base, wordBlocklist: "ass\n/free ?nitro/" };
  expect(checkContent("what an ASS you are", noCtx, on)).toContain("blocked term"); // whole word
  expect(checkContent("this is a class assignment", noCtx, on)).toBeNull(); // NOT "class"/"assignment"
  expect(checkContent("get free nitro now", noCtx, on)).toContain("blocked term");
});

test("links: blocked unless the domain is allowlisted (subdomains, www, trailing dot ok)", () => {
  const on: ContentRules = { ...base, links: true, linkAllowlist: "github.com, docs.espressif.com" };
  expect(checkContent("see https://evil.example/x", noCtx, on)).toBe("external link");
  expect(checkContent("repo https://github.com/a/b", noCtx, on)).toBeNull();
  expect(checkContent("https://api.github.com/x", noCtx, on)).toBeNull(); // subdomain
  expect(checkContent("visit https://github.com.", noCtx, on)).toBeNull(); // trailing dot
});

test("hasUnallowedLink normalizes www + punctuation; caps has a high floor", () => {
  expect(hasUnallowedLink("no links here", "")).toBe(false);
  expect(hasUnallowedLink("https://x.com", "")).toBe(true); // empty allowlist blocks all
  expect(hasUnallowedLink("https://x.com", "x.com")).toBe(false);
  expect(hasUnallowedLink("go to www.github.com now", "github.com")).toBe(false); // www stripped
  expect(hasUnallowedLink("go to www.evil.com now", "github.com")).toBe(true);

  expect(isCapsSpam("THIS IS COMPLETELY UNACCEPTABLE BEHAVIOUR")).toBe(true);
  expect(isCapsSpam("GPIO UART I2C SPI ADC")).toBe(false); // short acronym list — under the floor
  expect(isCapsSpam("normal message")).toBe(false);
});

// ── decideEscalation ─────────────────────────────────────────────────────────
const TIMEOUT: Tier = { type: "timeout", at: 3, rank: 1 };
const KICK: Tier = { type: "kick", at: 5, rank: 2 };
const BAN: Tier = { type: "ban", at: 8, rank: 3 };
const LADDER: Tier[] = [TIMEOUT, KICK, BAN];
const NOW = 1_000_000; // stands in for the offending message's send time
const COOLDOWN = 5_000;

function decide(count: number, appliedRank: number, lastActionAt: number, tiers = LADDER) {
  return decideEscalation({ count, tiers, appliedRank, lastActionAt, messageSentAt: NOW, cooldownMs: COOLDOWN });
}

test("escalation: below the lowest threshold is warn-only and shows the removal DM", () => {
  const d = decide(2, 0, 0);
  expect(d.action).toBeNull();
  expect(d.suppressWarnDm).toBe(false);
});

test("escalation: a clean user hitting the timeout threshold is timed out", () => {
  const d = decide(3, 0, 0);
  expect(d.action?.type).toBe("timeout");
  expect(d.suppressWarnDm).toBe(true);
});

test("escalation: a hard burst can NOT skip a tier — count jumping past kick/ban still only times out", () => {
  // The reported bug: spamming hard enough jumped straight to kick from zero.
  expect(decide(9, 0, 0).action?.type).toBe("timeout"); // count past the BAN threshold, applied=0
  expect(decide(5, 0, 0).action?.type).toBe("timeout"); // count at the KICK threshold, applied=0
});

test("escalation: only one action per burst — within cooldown it stays quiet", () => {
  const d = decide(9, 1 /* already timed out */, NOW - 1_000 /* 1s ago */);
  expect(d.action).toBeNull();
  expect(d.suppressWarnDm).toBe(true); // suppress the removal DM too, so a burst isn't noisy
});

test("escalation: a straggler sent BEFORE the action (processed late) takes no new action", () => {
  // messageSentAt (NOW) is earlier than lastActionAt — i.e. this queued message predates the
  // action that already fired. It must not push the ladder further, no matter how late we drain it.
  const actionAfterThisMessage = NOW + 10_000;
  const d = decide(9, 1, actionAfterThisMessage);
  expect(d.action).toBeNull();
  expect(d.suppressWarnDm).toBe(true);
});

test("escalation: climbs one tier per burst once the cooldown passes", () => {
  const afterCooldown = NOW - COOLDOWN - 1;
  expect(decide(5, 1, afterCooldown).action?.type).toBe("kick"); // timeout→kick at the kick threshold
  expect(decide(8, 2, afterCooldown).action?.type).toBe("ban"); // kick→ban at the ban threshold
});

test("escalation: a repeat offender at the top enabled tier is re-punished, not left alone", () => {
  // Only timeout configured: after it expires and they spam again, they get timed out again.
  const onlyTimeout = [TIMEOUT];
  const d = decide(6, 1, NOW - COOLDOWN - 1, onlyTimeout);
  expect(d.action?.type).toBe("timeout");
});

test("escalation: a disabled middle tier steps to the next ENABLED tier, not a gap", () => {
  const timeoutThenBan = [TIMEOUT, BAN]; // kick disabled
  // Applied timeout, count well past ban threshold, cooldown passed → next enabled tier is ban.
  expect(decide(9, 1, NOW - COOLDOWN - 1, timeoutThenBan).action?.type).toBe("ban");
  // But from zero it still can't skip to ban — one step lands on timeout.
  expect(decide(9, 0, 0, timeoutThenBan).action?.type).toBe("timeout");
});

test("escalation: no tiers enabled is warn-only", () => {
  const d = decide(50, 0, 0, []);
  expect(d.action).toBeNull();
  expect(d.suppressWarnDm).toBe(false);
});
