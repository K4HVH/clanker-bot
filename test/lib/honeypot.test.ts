import { expect, test } from "bun:test";
import { CONFIG_KEYS } from "../../src/lib/config";
import { channelIsHoneypot } from "../../src/lib/honeypot";
import { silentContext } from "../helpers/fakes";

const chan = (id: string) => ({ id, isThread: () => false, parentId: null });
const thread = (id: string, parentId: string) => ({ id, isThread: () => true, parentId });

test("unset honeypot channel matches nothing", () => {
  const ctx = silentContext();
  expect(channelIsHoneypot(ctx, "g", chan("c1"))).toBe(false);
  expect(channelIsHoneypot(ctx, "g", thread("t1", "c1"))).toBe(false);
});

test("matches the configured channel and threads under it, not siblings", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.honeypotChannelId, "c1");
  expect(channelIsHoneypot(ctx, "g", chan("c1"))).toBe(true); // the channel itself
  expect(channelIsHoneypot(ctx, "g", thread("t1", "c1"))).toBe(true); // a thread under it
  expect(channelIsHoneypot(ctx, "g", chan("c2"))).toBe(false); // a sibling channel
  expect(channelIsHoneypot(ctx, "g", thread("t2", "c2"))).toBe(false); // a thread under a sibling
});

test("is scoped per guild", () => {
  const ctx = silentContext();
  ctx.config.set("g", CONFIG_KEYS.honeypotChannelId, "c1");
  expect(channelIsHoneypot(ctx, "other", chan("c1"))).toBe(false);
});
