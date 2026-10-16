import { expect, test } from "bun:test";
import { createDatabase } from "../../src/db/index";
import { ConfigService } from "../../src/lib/config";
import { panelMessage } from "../../src/lib/panels";
import { applyPlan, planFor } from "../../src/server/apply";
import { renderPlan } from "../../src/server/render";
import { defineServer, type ServerSpec, validateSpec } from "../../src/server/spec";
import { FakeDiscord } from "../helpers/fake-discord";

const DEFAULT_TICKET = "Need help? Click **Open Ticket** to talk to the team privately.";

const spec = (over: Partial<ServerSpec> = {}): ServerSpec =>
  defineServer({
    name: "t",
    dir: import.meta.dir,
    guild: {},
    everyone: { permissions: [] },
    roles: [],
    channels: [
      { key: "ticket", type: "text", name: "ticket" },
      { key: "verify", type: "text", name: "verify" },
    ],
    automod: [],
    posts: [
      { key: "ticket-panel", channel: "ticket", panel: "ticket" },
      { key: "verify-panel", channel: "verify", panel: "verify" },
    ],
    bot: {},
    ...over,
  });

function env(s = spec(), f = new FakeDiscord()) {
  const db = createDatabase(":memory:");
  return { f, api: f, db, config: new ConfigService(db), guildId: f.guildId, spec: s, reason: "test" };
}

const panelsIn = (f: FakeDiscord, name: string) => {
  const channel = f.channels.find((c) => c.name === name)!;
  return f.messages.filter((m) => m.channel_id === channel.id && m.components?.length);
};

test("a panel is posted with the bot's text and its button, then plans clean", async () => {
  const e = env();
  expect((await applyPlan(e, await planFor(e, false))).failed).toBeNull();
  const [ticket] = panelsIn(e.f, "ticket");
  expect(ticket!.embeds as unknown).toEqual(panelMessage("ticket", DEFAULT_TICKET).embeds);
  expect(ticket!.components).toEqual(panelMessage("ticket", DEFAULT_TICKET).components);
  expect(panelsIn(e.f, "verify")).toHaveLength(1);
  expect((await planFor(e, false)).ops).toEqual([]);
});

test("a panel already in its channel is taken over, not posted twice", async () => {
  const f = new FakeDiscord();
  const ticket = f.addChannel({ name: "ticket" });
  f.addMessage(ticket.id, "", f.botId, panelMessage("ticket", DEFAULT_TICKET) as never);
  const e = env(spec(), f);
  const plan = await planFor(e, false);
  expect(plan.ops).toContainEqual(expect.objectContaining({ t: "bind", kind: "post", key: "ticket-panel#0" }));
  expect(plan.ops.filter((o) => o.t === "post.create").map((o) => (o as { key: string }).key)).toEqual(["verify-panel"]);
  await applyPlan(e, plan);
  expect(panelsIn(f, "ticket")).toHaveLength(1);
  expect((await planFor(e, false)).ops).toEqual([]);
});

test("a panel drawn before the bot's colour is recoloured in place, found in its channel or posted by the spec", async () => {
  const plain = { embeds: [{ title: "Support", description: DEFAULT_TICKET }], components: panelMessage("ticket", DEFAULT_TICKET).components };
  const f = new FakeDiscord();
  const ticket = f.addChannel({ name: "ticket" });
  const old = f.addMessage(ticket.id, "", f.botId, plain as never);
  const e = env(spec(), f);
  const plan = await planFor(e, false);
  expect(plan.ops).toContainEqual(expect.objectContaining({ t: "post.edit", key: "ticket-panel", panel: { kind: "ticket", text: DEFAULT_TICKET, recolor: true } }));
  expect(renderPlan(plan, spec())).toContain("ticket-panel: the ticket panel's colour");
  await applyPlan(e, plan);
  expect(panelsIn(f, "ticket")).toEqual([expect.objectContaining({ id: old.id, embeds: panelMessage("ticket", DEFAULT_TICKET).embeds })]);
  expect((await planFor(e, false)).ops).toEqual([]);

  panelsIn(f, "verify")[0]!.embeds = [{ title: "Server Verification", description: panelsIn(f, "verify")[0]!.embeds![0]!.description }];
  const again = await planFor(e, false);
  expect(again.ops).toEqual([expect.objectContaining({ t: "post.edit", key: "verify-panel", panel: expect.objectContaining({ recolor: true }) })]);
});

test("new panel text in the file edits the panel", async () => {
  const e = env();
  await applyPlan(e, await planFor(e, false));
  const e2 = env(spec({ bot: { ticket_panel_text: "Open a ticket to talk to staff." } }), e.f);
  const shared = { ...e2, db: e.db, config: e.config };
  const plan = await planFor(shared, false);
  expect(plan.ops.filter((o) => o.t === "post.edit")).toHaveLength(1);
  await applyPlan(shared, plan);
  expect(panelsIn(e.f, "ticket")[0]!.embeds![0]!.description).toBe("Open a ticket to talk to staff.");
  expect((await planFor(shared, false)).ops).toEqual([]);
});

test("a post is a file or a panel, not both", () => {
  expect(validateSpec(spec({ posts: [{ key: "x", channel: "ticket", panel: "ticket", file: "a.md" }] }))).toEqual(['post "x": a file or a panel, not both']);
});

test("the honeypot panel goes in a voice channel's chat, and one already there is found by its colour", async () => {
  const f = new FakeDiscord();
  const vc = f.addChannel({ name: "vc", type: 2 });
  f.addMessage(vc.id, "", f.botId, { embeds: [{ color: 0xf1c40f, description: "an older warning" }] });
  const s = spec({
    channels: [{ key: "vc", type: "voice", name: "vc" }],
    posts: [{ key: "trap", channel: "vc", panel: "honeypot" }],
  });
  const e = env(s, f);
  const plan = await planFor(e, false);
  expect(plan.ops.map((o) => o.t)).toEqual(["bind", "bind", "post.edit"]);
  await applyPlan(e, plan);
  const panels = f.messages.filter((m) => m.channel_id === vc.id);
  expect(panels).toHaveLength(1);
  expect(panels[0]!.embeds![0]!.description).toBe(
    "**Do not post in this channel.** It is a trap for compromised accounts. Posting here removes you from the server automatically.",
  );
  expect((await planFor(e, false)).ops).toEqual([]);
});
