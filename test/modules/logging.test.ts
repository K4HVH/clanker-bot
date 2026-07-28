import { expect, jest, test } from "bun:test";
import { Collection, Events, type Guild, type GuildMember } from "discord.js";
import type { AppContext } from "../../src/core/context";
import type { Listener } from "../../src/core/module";
import { CONFIG_KEYS } from "../../src/lib/config";
import { loggingModule } from "../../src/modules/logging";
import { silentContext } from "../helpers/fakes";

const GUILD_ID = "g1";
const LOG_CHANNEL_ID = "c-log";

interface EmbedData {
  title?: string;
  fields?: { name: string; value: string }[];
}

function listenerFor(event: Events): Listener {
  const found = (loggingModule.listeners ?? []).find((l) => l.event === event);
  if (!found) throw new Error(`no logging listener for ${String(event)}`);
  return found;
}

// A guild whose member-log channel captures sends, so we can assert on what got logged.
function stubGuild(sent: EmbedData[]) {
  const channel = {
    isTextBased: () => true,
    send: async (opts: { embeds: { data: EmbedData }[] }) => {
      for (const embed of opts.embeds) sent.push(embed.data);
    },
  };
  return {
    id: GUILD_ID,
    channels: { cache: new Map([[LOG_CHANNEL_ID, channel]]) },
  } as unknown as Guild;
}

function contextWithMemberLog(): AppContext {
  const ctx = silentContext();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.memberLogChannelId, LOG_CHANNEL_ID);
  return ctx;
}

function fieldsOf(embed: EmbedData | undefined) {
  return Object.fromEntries((embed?.fields ?? []).map((f) => [f.name, f.value]));
}

// The logged send is fired from a deferred timer, not awaited by the handler — let its
// promise chain settle before asserting.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function member(guild: Guild, nickname: string | null, partial: boolean): GuildMember {
  return { id: "u1", guild, nickname, partial } as unknown as GuildMember;
}

function leavingMember(guild: Guild, partial: boolean): GuildMember {
  return {
    id: "u1",
    guild,
    partial,
    user: { id: "u1", createdTimestamp: 1_600_000_000_000 },
    // Tenure is measured against the leave, so pin the join relative to now.
    joinedTimestamp: partial ? null : Date.now() - (3 * 86_400_000 + 4 * 3_600_000),
    // @everyone shares the guild's id and is filtered out of the logged role list.
    roles: {
      cache: new Collection([
        [GUILD_ID, { id: GUILD_ID }],
        ["r1", { id: "r1" }],
      ]),
    },
  } as unknown as GuildMember;
}

async function runLeave(ctx: AppContext, m: GuildMember): Promise<void> {
  jest.useFakeTimers();
  try {
    await listenerFor(Events.GuildMemberRemove).handle(ctx, m);
    jest.advanceTimersByTime(5_000);
  } finally {
    jest.useRealTimers();
  }
  await flush();
}

test("logs a cached member's leave with their tenure and roles", async () => {
  const sent: EmbedData[] = [];
  const guild = stubGuild(sent);
  await runLeave(contextWithMemberLog(), leavingMember(guild, false));
  expect(sent).toHaveLength(1);
  expect(sent[0]?.title).toBe("Member left");
  const fields = fieldsOf(sent[0]);
  expect(fields["Time in server"]).toBe("3 days, 4 hours");
  expect(fields["Roles held"]).toBe("<@&r1>");
});

test("logs an uncached member's leave, marking what was never known as unknown", async () => {
  const sent: EmbedData[] = [];
  const guild = stubGuild(sent);
  await runLeave(contextWithMemberLog(), leavingMember(guild, true));
  expect(sent).toHaveLength(1);
  const fields = fieldsOf(sent[0]);
  expect(fields.User).toContain("u1");
  expect(fields["Account created"]).toBe("<t:1600000000:R>");
  expect(fields["Joined server"]).toBe("*unknown*");
  expect(fields["Time in server"]).toBe("*unknown*");
  expect(fields["Roles held"]).toBe("*unknown*");
});

test("skips the leave log when member event logging is off", async () => {
  const sent: EmbedData[] = [];
  const guild = stubGuild(sent);
  const ctx = contextWithMemberLog();
  ctx.config.set(GUILD_ID, CONFIG_KEYS.logMemberEvents, false);
  await runLeave(ctx, leavingMember(guild, false));
  expect(sent).toEqual([]);
});

test("logs a nickname change between two cached states", async () => {
  const sent: EmbedData[] = [];
  const guild = stubGuild(sent);
  await listenerFor(Events.GuildMemberUpdate).handle(
    contextWithMemberLog(),
    member(guild, "old-nick", false),
    member(guild, "new-nick", false),
  );
  expect(sent.map((e) => e.title)).toEqual(["Nickname changed"]);
});

test("stays quiet when the previous member state is partial", async () => {
  const sent: EmbedData[] = [];
  const guild = stubGuild(sent);
  // An uncached member: discord.js synthesises "before" from the payload's user, so its
  // nickname is null whatever the real one was. Reporting a change here would be a fiction.
  await listenerFor(Events.GuildMemberUpdate).handle(
    contextWithMemberLog(),
    member(guild, null, true),
    member(guild, "real-nick", false),
  );
  expect(sent).toEqual([]);
});
