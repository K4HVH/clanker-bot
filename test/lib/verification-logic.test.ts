import { expect, test } from "bun:test";
import {
  challengeMode,
  FAST_SOLVE_MS,
  isCodeShaped,
  memberHasRole,
  verifyFlags,
} from "../../src/lib/verification-logic";

test("challengeMode starts a new challenge when none is live", () => {
  expect(challengeMode(undefined, 100, false)).toBe("new");
  expect(challengeMode({ expiresAt: 50 }, 100, false)).toBe("new"); // expired
  expect(challengeMode({ expiresAt: 50 }, 100, true)).toBe("new");
});

test("challengeMode reuses vs rotates a live challenge", () => {
  expect(challengeMode({ expiresAt: 200 }, 100, false)).toBe("reuse");
  expect(challengeMode({ expiresAt: 200 }, 100, true)).toBe("rotate");
});

test("verifyFlags raises young/fast per the aggressive posture", () => {
  expect(verifyFlags(3, 7, 5000)).toEqual({ young: true, fast: false });
  expect(verifyFlags(10, 7, 5000)).toEqual({ young: false, fast: false });
  expect(verifyFlags(2, 0, 5000)).toEqual({ young: false, fast: false }); // young flag off
  expect(verifyFlags(10, 7, 800)).toEqual({ young: false, fast: true });
  expect(verifyFlags(3, 7, FAST_SOLVE_MS - 1)).toEqual({ young: true, fast: true });
  expect(verifyFlags(3, 7, FAST_SOLVE_MS)).toEqual({ young: true, fast: false }); // boundary
});

test("isCodeShaped only accepts right-length code-charset strings", () => {
  expect(isCodeShaped("KMQ7RT", 6)).toBe(true);
  expect(isCodeShaped("HELLO", 6)).toBe(false); // wrong length
  expect(isCodeShaped("WHERE?", 6)).toBe(false); // punctuation → not a guess
  expect(isCodeShaped("HELLO THERE", 6)).toBe(false); // space + length
  expect(isCodeShaped("GOTCHA", 6)).toBe(false); // contains O (not in the code charset)
  expect(isCodeShaped("PLEASE", 6)).toBe(false); // contains L (not in the code charset)
  expect(isCodeShaped("", 6)).toBe(false);
  expect(isCodeShaped("ABCD", 4)).toBe(true);
});

test("memberHasRole handles both the manager and raw-array shapes", () => {
  expect(memberHasRole(["a", "b"], "b")).toBe(true);
  expect(memberHasRole(["a"], "b")).toBe(false);
  expect(memberHasRole({ cache: { has: (id) => id === "r" } }, "r")).toBe(true);
  expect(memberHasRole({ cache: { has: () => false } }, "r")).toBe(false);
  expect(memberHasRole(null, "r")).toBe(false);
  expect(memberHasRole(undefined, "r")).toBe(false);
});
