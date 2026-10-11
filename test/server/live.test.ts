import { expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { readLive } from "../../src/server/live";
import { FakeDiscord } from "../helpers/fake-discord";

const V = PermissionFlagsBits.ViewChannel;

function seeded() {
  const f = new FakeDiscord("1");
  const dev = f.addRole({ name: "Dev", permissions: String(PermissionFlagsBits.Administrator), position: 3, hoist: true });
  const booster = f.addRole({ name: "Server Booster", managed: true, tags: { premium_subscriber: null }, position: 2 });
  const cat = f.addChannel({ name: "Home", type: 4 });
  const general = f.addChannel({
    name: "general",
    parent_id: cat.id,
    topic: "Chat",
    rate_limit_per_user: 5,
    permission_overwrites: [
      { id: "1", type: 0, allow: "0", deny: String(V) },
      { id: "4242", type: 1, allow: String(V), deny: "0" },
    ],
  });
  const rule = f.addRule({
    name: "Rule 2",
    trigger_metadata: { keyword_filter: ["*cheat*"], regex_patterns: ["x"], allow_list: [] },
    actions: [{ type: 1, metadata: { custom_message: "no" } }, { type: 2, metadata: { channel_id: general.id } }],
    exempt_roles: [dev.id],
  });
  const msg = f.addMessage(general.id, "hello");
  return { f, dev, booster, cat, general, rule, msg };
}

test("reads the guild, roles, channels, rules and posts", async () => {
  const { f, dev, booster, general, rule, msg } = seeded();
  const live = await readLive(f, "1", [
    { channelId: general.id, messageId: msg.id },
    { channelId: general.id, messageId: "777" },
  ]);
  expect(live.guild.ownerId).toBe(f.ownerId);
  expect(live.botId).toBe(f.botId);
  expect(live.botTopPosition).toBe(50);
  expect(live.roles.find((r) => r.id === dev.id)).toMatchObject({ name: "Dev", hoist: true, permissions: PermissionFlagsBits.Administrator, booster: false });
  expect(live.roles.find((r) => r.id === booster.id)?.booster).toBe(true);
  expect(live.roles.find((r) => r.botId === f.botId)?.managed).toBe(true);
  const ch = live.channels.find((c) => c.id === general.id)!;
  expect(ch).toMatchObject({ topic: "Chat", slowmode: 5, nsfw: false });
  expect(ch.overwrites).toEqual([
    { id: "1", type: 0, allow: 0n, deny: V },
    { id: "4242", type: 1, allow: V, deny: 0n },
  ]);
  expect(live.rules[0]).toMatchObject({
    id: rule.id,
    keywords: ["*cheat*"],
    regex: ["x"],
    actions: [{ type: 1, message: "no" }, { type: 2, channelId: general.id }],
    exemptRoles: [dev.id],
  });
  expect(live.posts.get(msg.id)).toBe("hello");
  expect(live.posts.get("777")).toBeNull();
});
