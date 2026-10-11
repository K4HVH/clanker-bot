import { expect, test } from "bun:test";
import { channelsFlat, defineServer, type ServerSpec, validateSpec } from "../../src/server/spec";

const base = (): ServerSpec =>
  defineServer({
    name: "test",
    dir: `${import.meta.dir}/fixture-valid`,
    guild: { community: { rules: "rules", updates: "updates" } },
    everyone: { permissions: ["ViewChannel"] },
    roles: [
      { key: "dev", name: "Dev", permissions: ["Administrator"] },
      { key: "verified", name: "Verified", permissions: ["SendMessages"] },
    ],
    channels: [
      { key: "rules", type: "text", name: "rules", overwrites: { everyone: { SendMessages: false } } },
      {
        key: "admin",
        type: "category",
        name: "Admin",
        overwrites: { everyone: { ViewChannel: false } },
        channels: [
          { key: "general", type: "text", name: "general", slowmode: 5 },
          { key: "updates", type: "text", name: "updates" },
        ],
      },
    ],
    automod: [{ key: "rule-2", name: "Rule 2", keywords: ["*cheat*"], block: true, alert: "updates", exemptRoles: ["dev"] }],
    posts: [{ key: "rules", channel: "rules", file: "rules.md" }],
    bot: { mod_log_channel_id: { channel: "updates" }, verified_role_id: { role: "verified" }, timeout_minutes: 10 },
  });

const errorsAfter = (change: (s: ServerSpec) => void): string[] => {
  const s = base();
  change(s);
  return validateSpec(s);
};

const general = (s: ServerSpec) => {
  const admin = s.channels[1];
  if (!admin || admin.type !== "category") throw new Error("fixture changed");
  return admin.channels[0]!;
};

test("a valid spec has no errors", () => {
  expect(validateSpec(base())).toEqual([]);
});

test("categories come before their channels, in file order", () => {
  expect(channelsFlat(base()).map((c) => [c.channel.key, c.parent])).toEqual([
    ["rules", null],
    ["admin", null],
    ["general", "admin"],
    ["updates", "admin"],
  ]);
});

const cases: [string, (s: ServerSpec) => void, string][] = [
  ["duplicate role key", (s) => s.roles.push({ key: "dev", name: "Dev 2", permissions: [] }), 'role key "dev" used twice'],
  ["reserved role key", (s) => s.roles.push({ key: "everyone", name: "x", permissions: [] }), 'role key "everyone" is reserved'],
  ["duplicate channel key", (s) => s.channels.push({ key: "admin", type: "text", name: "x" }), 'channel key "admin" used twice'],
  [
    "overwrite for an unknown role",
    (s) => {
      s.channels[0]!.overwrites = { devs: { ViewChannel: true } };
    },
    'channel "rules": overwrite for unknown role "devs"',
  ],
  ["unknown community channel", (s) => (s.guild.community = { rules: "rulez", updates: "updates" }), 'guild.community.rules: unknown channel "rulez"'],
  ["slowmode out of range", (s) => (general(s).slowmode = 30000), 'channel "general": slowmode must be 0 to 21600'],
  ["too many regexes", (s) => (s.automod[0]!.regex = Array(11).fill("a")), 'automod "rule-2": at most 10 regexes'],
  ["regex too long", (s) => (s.automod[0]!.regex = ["a".repeat(261)]), 'automod "rule-2": regex 1 is longer than 260 characters'],
  ["keyword too long", (s) => (s.automod[0]!.keywords = ["k".repeat(61)]), 'automod "rule-2": keyword 1 is longer than 60 characters'],
  ["block message too long", (s) => (s.automod[0]!.block = "b".repeat(151)), 'automod "rule-2": block message is longer than 150 characters'],
  ["post in an unknown channel", (s) => (s.posts[0]!.channel = "rulez"), 'post "rules": unknown channel "rulez"'],
  ["post file missing", (s) => (s.posts[0]!.file = "missing.md"), 'post "rules": no file missing.md'],
  ["unknown setting", (s) => (s.bot.mod_log_channel = { channel: "updates" }), 'bot: unknown setting "mod_log_channel"'],
  ["channel setting given a bool", (s) => (s.bot.mod_log_channel_id = true), "bot.mod_log_channel_id: expects { channel: key }"],
  ["role setting naming an unknown role", (s) => (s.bot.verified_role_id = { role: "nope" }), 'bot.verified_role_id: unknown role "nope"'],
  ["setting out of range", (s) => (s.bot.timeout_minutes = 0), "bot.timeout_minutes: out of range"],
  ["setting of the wrong type", (s) => (s.bot.dm_on_action = "yes"), "bot.dm_on_action: expects bool"],
];

for (const [name, change, error] of cases) {
  test(`rejects ${name}`, () => {
    expect(errorsAfter(change)).toEqual([error]);
  });
}

test("text channel names are written the way Discord stores them", () => {
  const s = base();
  s.channels[0]!.name = "Rules Here";
  expect(validateSpec(s)).toEqual(['channel "rules": Discord stores text channel names in lowercase with dashes: write "rules-here"']);
});

test("voice channels and categories keep their capitals and spaces", () => {
  const s = base();
  s.channels.push({ key: "lounge", type: "voice", name: "The Lounge" });
  expect(validateSpec(s)).toEqual([]);
});

test("the bot's role sits under a role the file names", () => {
  expect(errorsAfter((s) => (s.botRole = { after: "nobody" }))).toEqual(['botRole.after: unknown role "nobody"']);
  expect(errorsAfter((s) => (s.botRole = { after: "dev" }))).toEqual([]);
});
