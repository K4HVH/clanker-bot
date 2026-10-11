import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSetting, validateSetting } from "../lib/config";
import { isPermissionName, type PermissionName } from "./permissions";

// A server described as data: what /server plan compares the live server against. Everything is
// named by a key, never a Discord id, so one spec can build any number of servers.

export type Overwrite = Partial<Record<PermissionName, boolean>>; // true allow, false deny, absent inherit

// Role keys that name roles Discord makes: @everyone, the server booster role, and the bot's own
// managed role. A spec references them in overwrites and settings but never defines them.
export const RESERVED_ROLES = ["everyone", "booster", "bot"] as const;

export interface RoleSpec {
  key: string;
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions: PermissionName[];
}

export interface EveryoneSpec {
  permissions: PermissionName[];
}

export type ChannelKind = "text" | "voice" | "announcement" | "forum" | "stage";

export interface ChannelSpec {
  key: string;
  type: ChannelKind;
  name: string;
  topic?: string;
  slowmode?: number;
  nsfw?: boolean;
  overwrites?: Record<string, Overwrite>;
  // Claim the channel's member overwrites too: any not declared here are removed.
  members?: "managed";
}

export interface CategorySpec {
  key: string;
  type: "category";
  name: string;
  overwrites?: Record<string, Overwrite>;
  members?: "managed";
  channels: ChannelSpec[];
}

export interface GuildSpec {
  name?: string;
  description?: string | null;
  icon?: string; // file in the spec's directory
  banner?: string;
  verificationLevel?: "none" | "low" | "medium" | "high" | "highest";
  explicitContentFilter?: "off" | "no-roles" | "all";
  defaultNotifications?: "all" | "mentions";
  systemChannel?: string | null;
  safetyAlertsChannel?: string | null;
  community?: { rules: string; updates: string } | false;
}

export interface AutoModSpec {
  key: string;
  name: string;
  enabled?: boolean;
  keywords?: string[];
  regex?: string[];
  allow?: string[];
  block?: string | true; // true blocks with Discord's default notice
  alert?: string; // channel key
  timeoutSeconds?: number;
  exemptRoles?: string[];
  exemptChannels?: string[];
}

export interface PostSpec {
  key: string;
  channel: string;
  file: string;
}

export type SettingValue =
  | boolean
  | number
  | string
  | string[]
  | null
  | { channel: string }
  | { role: string }
  | { roles: string[] };

export interface ServerSpec {
  name: string;
  dir: string;
  guild: GuildSpec;
  everyone: EveryoneSpec;
  roles: RoleSpec[];
  channels: (ChannelSpec | CategorySpec)[];
  automod: AutoModSpec[];
  posts: PostSpec[];
  bot: Record<string, SettingValue>;
}

export const defineServer = (spec: ServerSpec): ServerSpec => spec;

export interface FlatChannel {
  channel: ChannelSpec | CategorySpec;
  parent: string | null;
}

export function channelsFlat(spec: ServerSpec): FlatChannel[] {
  const out: FlatChannel[] = [];
  for (const c of spec.channels) {
    out.push({ channel: c, parent: null });
    if (c.type === "category") for (const child of c.channels) out.push({ channel: child, parent: c.key });
  }
  return out;
}

// Discord's limits on a keyword AutoMod rule.
const AUTOMOD = { keywords: 1000, keywordLen: 60, regex: 10, regexLen: 260, allow: 100, block: 150, rules: 6 };
const MAX_SLOWMODE = 21600;

// One field of a `{ channel }` / `{ role }` / `{ roles }` reference, or undefined for anything else.
const field = (v: unknown, name: string): unknown =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[name] : undefined;

export function validateSpec(spec: ServerSpec): string[] {
  const errors: string[] = [];
  const roleKeys = new Set<string>(RESERVED_ROLES);
  const seenRoles = new Set<string>();
  for (const role of spec.roles) {
    if ((RESERVED_ROLES as readonly string[]).includes(role.key)) errors.push(`role key "${role.key}" is reserved`);
    else if (seenRoles.has(role.key)) errors.push(`role key "${role.key}" used twice`);
    seenRoles.add(role.key);
    roleKeys.add(role.key);
    for (const p of role.permissions) if (!isPermissionName(p)) errors.push(`role "${role.key}": unknown permission "${p}"`);
  }
  for (const p of spec.everyone.permissions) if (!isPermissionName(p)) errors.push(`everyone: unknown permission "${p}"`);

  const flat = channelsFlat(spec);
  const channelKeys = new Set<string>();
  const textKeys = new Set<string>();
  for (const { channel } of flat) {
    if (channelKeys.has(channel.key)) errors.push(`channel key "${channel.key}" used twice`);
    channelKeys.add(channel.key);
    if (channel.type !== "category") textKeys.add(channel.key);
  }
  for (const { channel } of flat) {
    for (const [role, ow] of Object.entries(channel.overwrites ?? {})) {
      if (!roleKeys.has(role)) errors.push(`channel "${channel.key}": overwrite for unknown role "${role}"`);
      for (const p of Object.keys(ow)) {
        if (!isPermissionName(p)) errors.push(`channel "${channel.key}": unknown permission "${p}"`);
      }
    }
    if (channel.type !== "category" && channel.slowmode !== undefined) {
      if (!Number.isInteger(channel.slowmode) || channel.slowmode < 0 || channel.slowmode > MAX_SLOWMODE) {
        errors.push(`channel "${channel.key}": slowmode must be 0 to ${MAX_SLOWMODE}`);
      }
    }
  }

  const needChannel = (where: string, key: string | null | undefined) => {
    if (key != null && !textKeys.has(key)) errors.push(`${where}: unknown channel "${key}"`);
  };
  const g = spec.guild;
  if (g.community) {
    needChannel("guild.community.rules", g.community.rules);
    needChannel("guild.community.updates", g.community.updates);
  }
  needChannel("guild.systemChannel", g.systemChannel);
  needChannel("guild.safetyAlertsChannel", g.safetyAlertsChannel);
  for (const asset of ["icon", "banner"] as const) {
    const file = g[asset];
    if (file !== undefined && !existsSync(join(spec.dir, file))) errors.push(`guild.${asset}: no file ${file}`);
  }

  const ruleKeys = new Set<string>();
  if (spec.automod.length > AUTOMOD.rules) errors.push(`automod: at most ${AUTOMOD.rules} keyword rules`);
  for (const rule of spec.automod) {
    const at = `automod "${rule.key}"`;
    if (ruleKeys.has(rule.key)) errors.push(`automod key "${rule.key}" used twice`);
    ruleKeys.add(rule.key);
    const list = (items: string[] | undefined, max: number, len: number, what: string) => {
      if (!items) return;
      if (items.length > max) errors.push(`${at}: at most ${max} ${what}${max === 1 ? "" : "s"}`);
      items.forEach((item, i) => {
        if (item.length > len) errors.push(`${at}: ${what} ${i + 1} is longer than ${len} characters`);
      });
    };
    if (rule.regex && rule.regex.length > AUTOMOD.regex) errors.push(`${at}: at most ${AUTOMOD.regex} regexes`);
    else list(rule.regex, AUTOMOD.regex, AUTOMOD.regexLen, "regex");
    list(rule.keywords, AUTOMOD.keywords, AUTOMOD.keywordLen, "keyword");
    list(rule.allow, AUTOMOD.allow, AUTOMOD.keywordLen, "allow entry");
    if (typeof rule.block === "string" && rule.block.length > AUTOMOD.block) {
      errors.push(`${at}: block message is longer than ${AUTOMOD.block} characters`);
    }
    needChannel(`${at}: alert`, rule.alert);
    for (const r of rule.exemptRoles ?? []) if (!roleKeys.has(r)) errors.push(`${at}: unknown role "${r}"`);
    for (const c of rule.exemptChannels ?? []) if (!channelKeys.has(c)) errors.push(`${at}: unknown channel "${c}"`);
  }

  const postKeys = new Set<string>();
  for (const post of spec.posts) {
    if (postKeys.has(post.key)) errors.push(`post key "${post.key}" used twice`);
    postKeys.add(post.key);
    if (!textKeys.has(post.channel)) errors.push(`post "${post.key}": unknown channel "${post.channel}"`);
    if (!existsSync(join(spec.dir, post.file))) errors.push(`post "${post.key}": no file ${post.file}`);
  }

  for (const [key, value] of Object.entries(spec.bot)) {
    const setting = getSetting(key);
    if (!setting) {
      errors.push(`bot: unknown setting "${key}"`);
      continue;
    }
    const at = `bot.${key}`;
    if (setting.type === "channel") {
      if (value === null) continue;
      const channel = field(value, "channel");
      if (typeof channel !== "string") errors.push(`${at}: expects { channel: key }`);
      else if (!channelKeys.has(channel)) errors.push(`${at}: unknown channel "${channel}"`);
    } else if (setting.type === "role") {
      if (value === null) continue;
      const role = field(value, "role");
      if (typeof role !== "string") errors.push(`${at}: expects { role: key }`);
      else if (!roleKeys.has(role)) errors.push(`${at}: unknown role "${role}"`);
    } else if (setting.type === "roles") {
      const roles = field(value, "roles");
      if (!Array.isArray(roles)) errors.push(`${at}: expects { roles: [keys] }`);
      else for (const r of roles) if (!roleKeys.has(String(r))) errors.push(`${at}: unknown role "${r}"`);
    } else if (!validateSetting(setting, value)) {
      const ranged = setting.type === "int" && typeof value === "number" && Number.isInteger(value);
      errors.push(ranged ? `${at}: out of range` : `${at}: expects ${setting.type}`);
    }
  }
  return errors;
}
