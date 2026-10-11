import { REGISTRY_BY_KEY } from "../lib/config";
import type { Live, LiveChannel, LiveOverwrite } from "./live";
import { toNames } from "./permissions";
import { CHANNEL_TYPE, FILTER, NOTIFY, VERIFICATION } from "./plan";
import { RESERVED_ROLES } from "./spec";

// /server adopt: a spec matching the live server and the bot's settings, as TypeScript source to
// commit. It writes nothing: the first plan binds the keys to the live objects by name.

// A key from a name: emoji and punctuation dropped, words joined by "-". Taken keys get "-2", "-3".
export function keyOf(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "channel";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

const KIND: Record<number, string> = Object.fromEntries(Object.entries(CHANNEL_TYPE).map(([k, v]) => [v, k]));

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// A TypeScript literal, indented two spaces a level. Comments ride along as `{ comment }` items.
type Lit = string | number | boolean | null | Lit[] | { [k: string]: Lit } | Comment;
class Comment {
  constructor(readonly text: string) {}
}

function lit(v: Lit, depth: number): string {
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (v instanceof Comment) return `// ${v.text}`;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => x === null || typeof x !== "object")) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    return `[\n${v.map((x) => `${pad}${lit(x, depth + 1)}${x instanceof Comment ? "" : ","}`).join("\n")}\n${end}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return "{}";
  const lines = entries.map(([k, x]) => {
    if (x instanceof Comment) return `${pad}${lit(x, depth + 1)}`;
    return `${pad}${IDENT.test(k) ? k : JSON.stringify(k)}: ${lit(x, depth + 1)},`;
  });
  return `{\n${lines.join("\n")}\n${end}}`;
}

export function adoptSource(
  live: Live,
  settings: Record<string, unknown>,
  specName: string,
  importPath = "../../src/server/spec",
): string {
  const roleKey = new Map<string, string>();
  const roleKeys = new Set<string>(RESERVED_ROLES);
  roleKey.set(live.guild.id, "everyone");
  const botRole = live.roles.find((r) => r.botId === live.botId);
  if (botRole) roleKey.set(botRole.id, "bot");
  const booster = live.roles.find((r) => r.booster);
  if (booster) roleKey.set(booster.id, "booster");

  const roles = live.roles
    .filter((r) => r.id !== live.guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => {
      const key = keyOf(r.name, roleKeys);
      roleKey.set(r.id, key);
      const out: { [k: string]: Lit } = { key, name: r.name };
      if (r.color !== 0) out.color = r.color;
      if (r.hoist) out.hoist = true;
      if (r.mentionable) out.mentionable = true;
      out.permissions = toNames(r.permissions);
      return out;
    });

  // Display order: channels outside a category first, then each category with its text-like
  // channels before its voice ones, each by position.
  const byPosition = (a: LiveChannel, b: LiveChannel) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const voice = (c: LiveChannel) => c.type === 2 || c.type === 13;
  const displayed = (list: LiveChannel[]) => [...list.filter((c) => !voice(c)).sort(byPosition), ...list.filter(voice).sort(byPosition)];
  const channelKeys = new Set<string>();
  const channelKey = new Map<string, string>();
  // Kinds a spec can hold; others (a server directory, say) are listed as comments and left alone.
  const known = live.channels.filter((c) => KIND[c.type] !== undefined);
  const unknown = live.channels.filter((c) => KIND[c.type] === undefined);
  const top = displayed(known.filter((c) => c.parentId === null && c.type !== 4));
  const categories = known.filter((c) => c.type === 4).sort(byPosition);
  const ordered = [...top, ...categories.flatMap((cat) => [cat, ...displayed(known.filter((c) => c.parentId === cat.id))])];
  for (const c of ordered) channelKey.set(c.id, keyOf(c.name, channelKeys));

  const overwrites = (list: LiveOverwrite[]): { [k: string]: Lit } | null => {
    const out: { [k: string]: Lit } = {};
    for (const o of list) {
      if (o.type !== 0) continue; // member overwrites stay unmanaged
      const key = roleKey.get(o.id);
      if (!key) {
        out[`__unknown_${o.id}`] = new Comment(`overwrite for unknown role ${o.id}`);
        continue;
      }
      const ow: { [k: string]: Lit } = {};
      for (const n of toNames(o.allow)) ow[n] = true;
      for (const n of toNames(o.deny)) ow[n] = false;
      out[key] = ow;
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  const channel = (c: LiveChannel, category?: LiveChannel): { [k: string]: Lit } => {
    const out: { [k: string]: Lit } = { key: channelKey.get(c.id)!, type: KIND[c.type]!, name: c.name };
    if (c.type !== 4) {
      if (c.topic) out.topic = c.topic;
      if (c.slowmode > 0) out.slowmode = c.slowmode;
      if (c.nsfw) out.nsfw = true;
    }
    const ow = overwrites(c.overwrites);
    // A channel matching its category's permissions is written without its own: it takes them.
    // One that differs, even by having none, is written out.
    if (category) {
      const parent = overwrites(category.overwrites);
      if (JSON.stringify(ow ?? {}) !== JSON.stringify(parent ?? {})) out.overwrites = ow ?? {};
    } else if (ow) {
      out.overwrites = ow;
    }
    return out;
  };
  const channels: Lit[] = [
    ...top.map((c) => channel(c)),
    ...categories.map((cat) => ({ ...channel(cat), channels: displayed(known.filter((c) => c.parentId === cat.id)).map((c) => channel(c, cat)) })),
    ...unknown.map((c) => new Comment(`${c.name}: a type ${c.type} channel, which a spec can't hold`)),
  ];

  const ruleKeys = new Set<string>();
  const automod: Lit[] = live.rules
    .filter((r) => r.triggerType === 1)
    .map((r) => {
      const out: { [k: string]: Lit } = { key: keyOf(r.name, ruleKeys), name: r.name };
      if (!r.enabled) out.enabled = false;
      if (r.keywords.length) out.keywords = r.keywords;
      if (r.regex.length) out.regex = r.regex;
      if (r.allow.length) out.allow = r.allow;
      for (const a of r.actions) {
        if (a.type === 1) out.block = a.message ?? true;
        if (a.type === 2 && a.channelId) out.alert = channelKey.get(a.channelId) ?? a.channelId;
        if (a.type === 3 && a.seconds) out.timeoutSeconds = a.seconds;
      }
      if (r.exemptRoles.length) out.exemptRoles = r.exemptRoles.map((id) => roleKey.get(id) ?? id);
      if (r.exemptChannels.length) out.exemptChannels = r.exemptChannels.map((id) => channelKey.get(id) ?? id);
      return out;
    });

  const bot: { [k: string]: Lit } = {};
  for (const key of Object.keys(settings).sort()) {
    const setting = REGISTRY_BY_KEY.get(key);
    if (!setting) continue;
    const value = settings[key];
    if (setting.type === "channel") {
      const k = channelKey.get(String(value));
      bot[k ? key : `__${key}`] = k ? { channel: k } : new Comment(`${key}: unknown channel ${value}`);
    } else if (setting.type === "role") {
      const k = roleKey.get(String(value));
      bot[k ? key : `__${key}`] = k ? { role: k } : new Comment(`${key}: unknown role ${value}`);
    } else if (setting.type === "roles") {
      const ids = Array.isArray(value) ? value.map(String) : [];
      bot[key] = { roles: ids.flatMap((id) => (roleKey.has(id) ? [roleKey.get(id)!] : [])) };
    } else {
      bot[key] = value as Lit;
    }
  }

  const g = live.guild;
  const guild: { [k: string]: Lit } = { name: g.name };
  if (g.description) guild.description = g.description;
  guild.verificationLevel = VERIFICATION[g.verificationLevel] ?? "none";
  guild.explicitContentFilter = FILTER[g.explicitContentFilter] ?? "off";
  guild.defaultNotifications = NOTIFY[g.defaultNotifications] ?? "all";
  guild.systemChannel = g.systemChannelId ? (channelKey.get(g.systemChannelId) ?? null) : null;
  guild.safetyAlertsChannel = g.safetyAlertsChannelId ? (channelKey.get(g.safetyAlertsChannelId) ?? null) : null;
  if (g.features.includes("COMMUNITY") && g.rulesChannelId && g.publicUpdatesChannelId) {
    guild.community = { rules: channelKey.get(g.rulesChannelId)!, updates: channelKey.get(g.publicUpdatesChannelId)! };
  }
  if (g.mfaLevel === 1) guild.requireMfa = true;

  const spec = lit(
    {
      name: specName,
      dir: "__DIR__",
      guild,
      everyone: { permissions: toNames(live.roles.find((r) => r.id === g.id)?.permissions ?? 0n) },
      roles,
      channels,
      automod,
      posts: [],
      bot,
    },
    0,
  ).replace('"__DIR__"', "import.meta.dir");
  return `import { defineServer } from ${JSON.stringify(importPath)};\n\nexport default defineServer(${spec});\n`;
}
