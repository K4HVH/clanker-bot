import { expect, test } from "bun:test";
import { type Guild, type GuildMember, Events } from "discord.js";
import type { AppContext } from "../../src/core/context";
import type { Listener } from "../../src/core/module";
import { CONFIG_KEYS } from "../../src/lib/config";
import { guardsModule } from "../../src/modules/guards";
import { silentContext } from "../helpers/fakes";

const GUILD_ID = "g1";
const LOG_CHANNEL_ID = "c-log";

function nickListener(): Listener {
  const found = (guardsModule.listeners ?? []).find((l) => l.event === Events.GuildMemberUpdate);
  if (!found) throw new Error("no guards listener for GuildMemberUpdate");
  return found;
}

function stubGuild(alerts: string[]) {
  const channel = {
    isTextBased: () => true,
    send: async (opts: { embeds: { data: { title?: string } }[] }) => {
      for (const embed of opts.embeds) alerts.push(embed.data.title ?? "(untitled)");
    },
  };
  return {
    id: GUILD_ID,
    name: "Test",
    channels: { cache: new Map([[LOG_CHANNEL_ID, channel]]) },
  } as unknown as Guild;
}

// Name guard set to alert-only on the nickname "scam", with a mod-log to alert into.
function contextWithNameGuard(): AppContext {
  const ctx = silentContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.modLogChannelId, LOG_CHANNEL_ID);
  ctx.config.set(GUILD_ID, CONFIG_KEYS.nameGuardAction, "flag");
  ctx.config.set(GUILD_ID, CONFIG_KEYS.nameBlocklist, "scam");
  return ctx;
}

function member(guild: Guild, nickname: string | null, partial: boolean): GuildMember {
  return {
    id: "u1",
    guild,
    nickname,
    partial,
    user: { id: "u1", bot: false, username: "someone", globalName: null },
    permissions: { has: () => false },
  } as unknown as GuildMember;
}

test("enforces the name guard when a member renames into a blocked pattern", async () => {
  const alerts: string[] = [];
  const guild = stubGuild(alerts);
  await nickListener().handle(
    contextWithNameGuard(),
    member(guild, "harmless", false),
    member(guild, "scam", false),
  );
  expect(alerts).toHaveLength(1);
});

test("does not re-enforce on an update whose previous member state is partial", async () => {
  const alerts: string[] = [];
  const guild = stubGuild(alerts);
  // An uncached member: "before" has no nickname, so an unrelated role or timeout change
  // would otherwise look like a rename and re-punish a name that never changed.
  await nickListener().handle(
    contextWithNameGuard(),
    member(guild, null, true),
    member(guild, "scam", false),
  );
  expect(alerts).toEqual([]);
});
