import { expect, test } from "bun:test";
import { createLogger } from "../../src/core/logger";

test("suppresses messages below the configured level", () => {
  const lines: string[] = [];
  const log = createLogger("warn", (l) => lines.push(l));
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  const levels = lines.map((l) => JSON.parse(l).level);
  expect(levels).toEqual(["warn", "error"]);
});

test("includes the message and metadata", () => {
  const lines: string[] = [];
  const log = createLogger("info", (l) => lines.push(l));
  log.info("hello", { guildId: "g1" });
  const parsed = JSON.parse(lines[0] as string);
  expect(parsed.msg).toBe("hello");
  expect(parsed.guildId).toBe("g1");
});
