import { expect, test } from "bun:test";
import { Collection } from "discord.js";
import { run } from "../../src/db/index";
import { automodModule } from "../../src/modules/automod/index";
import { silentContext } from "../helpers/fakes";

// The real automod listener, on a stub message shaped as discord.js hands it over.
function message(over: { content?: string; files?: string[]; forwarded?: string[]; channelId?: string } = {}) {
  const state = { deleted: false };
  const asMap = (names: string[]) =>
    new Collection(names.map((name, i) => [String(i), { id: String(i), name, size: 10, url: `https://cdn/${name}` }] as const));
  const guild = { id: "g", name: "Medius", client: { users: { fetch: async () => null } }, members: { fetch: async () => null }, channels: { cache: new Map(), fetch: async () => null } };
  const msg = {
    id: `m${Math.random()}`,
    guild,
    guildId: "g",
    channelId: over.channelId ?? "c1",
    author: { id: "u1", bot: false, username: "someone", send: async () => {} },
    member: { permissions: { has: () => false }, roles: { cache: new Map() } },
    content: over.content ?? "",
    attachments: asMap(over.files ?? []),
    messageSnapshots: new Collection(over.forwarded ? [["s", { attachments: asMap(over.forwarded), content: "" }] as const] : []),
    embeds: [],
    stickers: new Collection(),
    mentions: { users: new Collection(), roles: new Collection(), everyone: false, repliedUser: null },
    client: { user: { id: "bot" } },
    delete: async () => {
      state.deleted = true;
    },
    webhookId: null,
  };
  return { msg, state };
}

const onCreate = automodModule.listeners!.find((l) => l.event === "messageCreate")!;

function ctxWithExecutables() {
  const ctx = silentContext();
  ctx.config.set("g", "automod_executables", true);
  return ctx;
}

const warns = (ctx: ReturnType<typeof silentContext>) => ctx.db.query("SELECT reason FROM cases WHERE type = 'warn'").all();

test("an executable with no text is removed and warned", async () => {
  const ctx = ctxWithExecutables();
  const { msg, state } = message({ files: ["Loader.exe"] });
  await onCreate.handle(ctx, msg as never);
  expect(state.deleted).toBe(true);
  expect(warns(ctx)).toEqual([{ reason: "Automod: executable attachment" }]);
});

test("a forwarded executable is caught too", async () => {
  const ctx = ctxWithExecutables();
  const { msg, state } = message({ forwarded: ["Loader.exe"] });
  await onCreate.handle(ctx, msg as never);
  expect(state.deleted).toBe(true);
});

test("a scam rule that only flags still lets the executable check remove the file", async () => {
  const ctx = ctxWithExecutables();
  ctx.config.set("g", "scam_signature_action", "flag");
  run(ctx.db, "INSERT INTO scam_signature (guild_id, kind, value, source, first_seen, last_seen) VALUES ('g', 'domain', 'scam.example', 'manual', 1, 1)");
  const { msg, state } = message({ content: "get it at https://scam.example/free", files: ["Free.exe"] });
  await onCreate.handle(ctx, msg as never);
  expect(state.deleted).toBe(true);
  expect(warns(ctx)).toEqual([{ reason: "Automod: executable attachment" }]);
});
