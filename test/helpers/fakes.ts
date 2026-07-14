import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../src/core/context";
import { createLogger } from "../../src/core/logger";
import { createDatabase } from "../../src/db/client";
import { ConfigService } from "../../src/services/config.service";

export function silentContext(): AppContext {
  const db = createDatabase(":memory:");
  return {
    db,
    logger: createLogger("error", () => {}),
    env: {} as AppContext["env"],
    config: new ConfigService(db),
  };
}

export interface FakeInteraction {
  commandName: string;
  replied: boolean;
  deferred: boolean;
  replies: unknown[];
  reply(opts: unknown): Promise<void>;
  followUp(opts: unknown): Promise<void>;
}

export function fakeInteraction(
  commandName: string,
): FakeInteraction & ChatInputCommandInteraction {
  const state: FakeInteraction = {
    commandName,
    replied: false,
    deferred: false,
    replies: [],
    async reply(opts: unknown) {
      state.replied = true;
      state.replies.push(opts);
    },
    async followUp(opts: unknown) {
      state.replies.push(opts);
    },
  };
  return state as FakeInteraction & ChatInputCommandInteraction;
}
