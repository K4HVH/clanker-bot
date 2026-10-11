import { expect, test } from "bun:test";
import { handleMenu } from "../../src/modules/roles/index";
import { maybePublish } from "../../src/modules/publish/index";
import { defineServer } from "../../src/server/spec";
import { putState, setSpecName } from "../../src/server/state";
import { silentContext } from "../helpers/fakes";

const spec = defineServer({
  name: "t",
  dir: import.meta.dir,
  guild: {},
  everyone: { permissions: [] },
  roles: [
    { key: "developer", name: "Developer", permissions: [] },
    { key: "release-pings", name: "Release pings", permissions: [] },
    { key: "box-pings", name: "Box pings", permissions: [] },
  ],
  channels: [
    { key: "releases", type: "announcement", name: "releases", publish: true },
    { key: "news", type: "announcement", name: "news" },
  ],
  automod: [],
  posts: [],
  menus: [
    {
      key: "start",
      questions: [
        { key: "pings", title: "Pings", multiple: true, options: [{ label: "Releases", role: "release-pings" }, { label: "Box", role: "box-pings" }] },
      ],
    },
  ],
  bot: {},
});
const specs = { t: spec };

function setup() {
  const ctx = silentContext();
  setSpecName(ctx.db, "g", "t");
  putState(ctx.db, "g", "role", "release-pings", "r1");
  putState(ctx.db, "g", "role", "box-pings", "r2");
  putState(ctx.db, "g", "channel", "releases", "c1");
  putState(ctx.db, "g", "channel", "news", "c2");
  ctx.config.set("g", "verified_role_id", "v");
  return ctx;
}

function menuInteraction(values: string[], roles: string[]) {
  const held = new Set(roles);
  const replies: unknown[] = [];
  return {
    held,
    replies,
    i: {
      guildId: "g",
      customId: "roles:start:pings",
      values,
      member: { roles: { cache: { has: (id: string) => held.has(id) }, add: async (id: string) => void held.add(id), remove: async (id: string) => void held.delete(id) } },
      deferReply: async (o: unknown) => void replies.push({ deferred: o }),
      editReply: async (o: unknown) => void replies.push(o),
    },
  };
}

test("picking from a menu gives the picked roles and takes the others in that question", async () => {
  const ctx = setup();
  const m = menuInteraction(["release-pings"], ["v", "r2"]);
  await handleMenu(m.i as never, ctx, specs);
  expect([...m.held].sort()).toEqual(["r1", "v"]);
  // Acknowledged first: adding and removing roles can outlast the 3 seconds Discord gives a reply.
  expect(m.replies).toEqual([{ deferred: { flags: 64 } }, { content: "Done: Release pings added, Box pings removed." }]);
});

test("someone not yet verified is sent to verify first", async () => {
  const ctx = setup();
  ctx.config.set("g", "verification_channel_id", "vc");
  const m = menuInteraction(["release-pings"], []);
  await handleMenu(m.i as never, ctx, specs);
  expect(m.held.size).toBe(0);
  expect(m.replies).toEqual([{ deferred: { flags: 64 } }, { content: "Verify in <#vc> first." }]);
});

test("a message in a channel the spec marks is published; others aren't", async () => {
  const ctx = setup();
  const published: string[] = [];
  const message = (channelId: string, crossposted = false) => ({
    guildId: "g",
    channelId,
    channel: { type: 5 },
    flags: { has: () => crossposted },
    crosspost: async () => void published.push(channelId),
  });
  await maybePublish(ctx, message("c1") as never, specs);
  await maybePublish(ctx, message("c2") as never, specs);
  await maybePublish(ctx, message("c1", true) as never, specs);
  expect(published).toEqual(["c1"]);
});

test("a silent message isn't published: a backfill stays in the channel", async () => {
  const ctx = setup();
  const published: string[] = [];
  const silent = {
    guildId: "g",
    channelId: "c1",
    channel: { type: 5 },
    flags: { has: (f: number) => f === 4096 },
    crosspost: async () => void published.push("c1"),
  };
  await maybePublish(ctx, silent as never, specs);
  expect(published).toEqual([]);
});
