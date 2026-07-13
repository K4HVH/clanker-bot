import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../../src/core/context";
import { createLogger } from "../../src/core/logger";

export function silentContext(): AppContext {
  return {
    db: undefined as unknown as AppContext["db"],
    logger: createLogger("error", () => {}),
    env: {} as AppContext["env"],
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
