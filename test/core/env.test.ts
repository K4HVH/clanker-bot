import { expect, test } from "bun:test";
import { loadEnv } from "../../src/core/env";

const base = {
  DISCORD_TOKEN: "t",
  DISCORD_APPLICATION_ID: "a",
  DISCORD_GUILD_ID: "g",
};

test("loads required values and applies defaults", () => {
  const env = loadEnv(base);
  expect(env.token).toBe("t");
  expect(env.applicationId).toBe("a");
  expect(env.guildId).toBe("g");
  expect(env.databasePath).toBe("./data/clanker.sqlite");
  expect(env.logLevel).toBe("info");
});

test("throws when a required variable is missing", () => {
  expect(() => loadEnv({ DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a" })).toThrow(
    /DISCORD_GUILD_ID/,
  );
});

test("rejects an invalid log level", () => {
  expect(() => loadEnv({ ...base, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
});
