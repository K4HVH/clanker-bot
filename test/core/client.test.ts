import { expect, test } from "bun:test";
import { type Client, Events, Status } from "discord.js";
import { createClient } from "../../src/core/client";
import type { Listener } from "../../src/core/module";
import { silentContext } from "../helpers/fakes";

// A guild stub shaped exactly as discord.js's GuildMemberRemove action uses it, so the test
// drives the library's real dispatch decision (which depends on our client's `partials`)
// rather than a re-implementation of it.
function stubGuild(client: Client, id: string) {
  const cache = new Map<string, unknown>();
  const guild = {
    id,
    client,
    memberCount: 10,
    presences: { cache: new Map() },
    voiceStates: { cache: new Map() },
    members: {
      cache,
      _add: (data: { user: { id: string } }) => {
        const member = { id: data.user.id, user: data.user, guild, partial: true };
        cache.set(data.user.id, member);
        return member;
      },
    },
  };
  (client.guilds.cache as unknown as Map<string, unknown>).set(id, guild);
  return guild;
}

// `client.actions` is internal to discord.js; reaching for it is deliberate — it is the real
// gateway-dispatch entry point, and the behaviour under test is its resolution of the member.
function guildMemberRemoveAction(client: Client) {
  return (
    client as unknown as {
      actions: { GuildMemberRemove: { handle(data: unknown, shard: { status: number }): unknown } };
    }
  ).actions.GuildMemberRemove;
}

function leaveListener(seen: string[]): Listener {
  return {
    event: Events.GuildMemberRemove,
    handle: (_ctx, member) => {
      seen.push((member as { id: string }).id);
    },
  } as Listener;
}

test("a leave by a member who is not in the member cache still fires GuildMemberRemove", async () => {
  const seen: string[] = [];
  const client = createClient([{ name: "t", listeners: [leaveListener(seen)] }], silentContext());
  try {
    stubGuild(client, "g1"); // note: member cache left empty — a lurker the bot never cached
    guildMemberRemoveAction(client).handle(
      { guild_id: "g1", user: { id: "alt-1", username: "alt" } },
      { status: Status.Ready },
    );
    expect(seen).toEqual(["alt-1"]);
  } finally {
    await client.destroy();
  }
});

test("a leave by a cached member fires GuildMemberRemove and drops them from cache", async () => {
  const seen: string[] = [];
  const client = createClient([{ name: "t", listeners: [leaveListener(seen)] }], silentContext());
  try {
    const guild = stubGuild(client, "g1");
    guild.members._add({ user: { id: "alt-2" } });
    guildMemberRemoveAction(client).handle(
      { guild_id: "g1", user: { id: "alt-2", username: "alt" } },
      { status: Status.Ready },
    );
    expect(seen).toEqual(["alt-2"]);
    expect(guild.members.cache.has("alt-2")).toBe(false);
  } finally {
    await client.destroy();
  }
});
