import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_BY_KEY } from "../lib/config";
import type { Live, LiveChannel, LiveRole, LiveRule } from "./live";
import { menuComponents, parsePosted, splitPost } from "./posts";
import { type AllowDeny, keepUnnamed, permissionDiff, toBits, widens } from "./permissions";
import {
  type CategorySpec,
  type ForumSpec,
  type ChannelKind,
  type ChannelSpec,
  channelsFlat,
  type AutoModSpec,
  type Overwrite,
  type ServerSpec,
  type SettingValue,
} from "./spec";
import { type State, stateKey } from "./state";

// What /server plan shows and Apply runs: the spec compared with the live server, as a list of
// operations. Everything names keys; ids are resolved through state when an operation runs, so an
// operation can name a channel created earlier in the same run.

export type Flag = "widens" | "deletes";

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export interface OverwriteBits {
  target: string; // role key
  allow: bigint;
  deny: bigint;
}

export interface ForumBody {
  tags?: { name: string; emoji: string | null; moderated: boolean }[];
  requireTag?: boolean;
  reaction?: string | null;
  sort?: number | null;
  layout?: number;
  threadSlowmode?: number;
}

// The forum settings a spec declares, in Discord's terms. Settings it leaves out stay as they are.
export function forumBody(f: ForumSpec): ForumBody {
  const out: ForumBody = {};
  if (f.tags) out.tags = f.tags.map((t) => ({ name: t.name, emoji: t.emoji ?? null, moderated: t.moderated ?? false }));
  if (f.requireTag !== undefined) out.requireTag = f.requireTag;
  if (f.reaction !== undefined) out.reaction = f.reaction;
  if (f.sort !== undefined) out.sort = f.sort === "activity" ? 0 : 1;
  if (f.layout !== undefined) out.layout = f.layout === "list" ? 1 : 2;
  if (f.threadSlowmode !== undefined) out.threadSlowmode = f.threadSlowmode;
  return out;
}

export interface AutoModBody {
  name: string;
  enabled: boolean;
  keywords: string[];
  regex: string[];
  allow: string[];
  actions: { type: number; channel?: string; message?: string; seconds?: number }[]; // channel is a key
  exemptRoles: string[]; // keys
  exemptChannels: string[]; // keys
}

export type Op =
  | { t: "bind"; kind: "role" | "channel" | "automod" | "asset"; key: string; id: string; label: string; replaces?: string }
  | { t: "role.create"; key: string; name: string; color: number; hoist: boolean; mentionable: boolean; permissions: bigint; flags: Flag[] }
  | { t: "role.update"; key: string; changes: Change[]; flags: Flag[] }
  | { t: "role.delete"; key: string; name: string; flags: Flag[] }
  | { t: "role.order"; keys: string[] }
  | {
      t: "channel.create";
      key: string;
      type: number;
      name: string;
      parent: string | null;
      topic: string | null;
      slowmode: number;
      nsfw: boolean;
      overwrites: OverwriteBits[];
      visibleTo: string[]; // role keys, Administrator holders aside, that could view it
      forum?: ForumBody;
      flags: Flag[];
    }
  | { t: "channel.update"; key: string; changes: Change[]; flags: Flag[] }
  | { t: "channel.delete"; key: string; name: string; flags: Flag[] }
  | { t: "channel.order"; items: { key: string; parent: string | null }[] }
  | { t: "overwrite.set"; channel: string; target: string; allow: bigint; deny: bigint; before: AllowDeny | null; flags: Flag[] }
  | { t: "overwrite.delete"; channel: string; target: string; before: AllowDeny; flags: Flag[] }
  | { t: "guild.update"; changes: Change[]; flags: Flag[] }
  | { t: "community"; enable: boolean; flags: Flag[] }
  | { t: "asset.set"; key: "icon" | "banner" | "splash"; file: string; hash: string }
  | { t: "automod.create"; key: string; body: AutoModBody }
  | { t: "automod.update"; key: string; body: AutoModBody; changes: Change[] }
  | { t: "automod.delete"; key: string; name: string; flags: Flag[] }
  | { t: "setting.set"; key: string; value: SettingValue; before: unknown }
  | {
      t: "post.create";
      key: string;
      index: number;
      channel: string;
      content: string;
      thread?: { title: string; pin: boolean }; // a forum post's first chunk starts its thread
      components?: unknown[]; // a role menu, on the last chunk
      menuHash?: string;
    }
  | { t: "post.edit"; key: string; index: number; content: string; components?: unknown[]; menuHash?: string; clearMenu?: boolean }
  | { t: "post.title"; key: string; title: string; pin: boolean }
  | { t: "post.delete"; key: string; index: number }
  | { t: "prune"; kind: "role" | "channel"; id: string; label: string; flags: Flag[] };

export interface Plan {
  ops: Op[];
  held: Op[]; // deletions, shown but applied only when asked for
  manual: string[];
  unmanaged: string[];
  fingerprint: string;
}

export interface PlanInput {
  spec: ServerSpec;
  live: Live;
  state: State;
  settings: Record<string, unknown>;
  deletions: boolean;
  // Delete live roles and channels the spec doesn't name (Discord's defaults on a new server, say).
  prune?: boolean;
}

export const CHANNEL_TYPE: Record<ChannelKind | "category", number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
};

const KIND_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(CHANNEL_TYPE).map(([k, v]) => [v, k]),
);

export const VERIFICATION = ["none", "low", "medium", "high", "highest"] as const;
export const FILTER = ["off", "no-roles", "all"] as const;
export const NOTIFY = ["all", "mentions"] as const;

// Discord converts between text and announcement channels in place (with Community on); no other.
const convertible = (a: number, b: number) => (a === 0 && b === 5) || (a === 5 && b === 0);

const hasTopic = (type: number) => type === 0 || type === 5 || type === 15 || type === 16;

// Discord orders categories, text-like channels and voice-like channels as separate lists, so
// relative order is compared within one of these buckets at a time.
const bucketOf = (type: number) => (type === 4 ? "category" : type === 2 || type === 13 ? "voice" : "text");

export const channelLabel = (name: string, type: number): string =>
  type === 4 ? `category "${name}"` : `#${name}`;

// A key resolves to a live id, to null when it will be created, or stays out of the map when it
// can't be planned (two candidates share its name): everything that references it is skipped.
type Resolved = Map<string, string | null>;

class Planner {
  readonly ops: Op[] = [];
  readonly held: Op[] = [];
  readonly manual: string[] = [];
  readonly unmanaged: string[] = [];
  readonly roles: Resolved = new Map();
  readonly channels: Resolved = new Map();
  readonly rules: Resolved = new Map();
  readonly roleKeyById = new Map<string, string>();
  readonly channelKeyById = new Map<string, string>();
  readonly ruleKeyById = new Map<string, string>();
  // Channel keys planned around: everything that names one is skipped too.
  readonly skipped = new Set<string>();
  // Ids a renamed key took over from its old key, which the old key's deletion must not touch.
  readonly rebound = new Set<string>();
  // Reserved roles this server doesn't have (no one has boosted it). No member holds them, so a
  // reference to one is left out rather than holding anything up.
  readonly absentRoles = new Set<string>();

  constructor(readonly input: PlanInput) {}

  private get live(): Live {
    return this.input.live;
  }

  // Whether a channel key is part of this plan: resolved, and not planned around.
  usable(key: string): boolean {
    return this.channels.has(key) && !this.skipped.has(key);
  }

  liveRole(id: string): LiveRole | undefined {
    return this.live.roles.find((r) => r.id === id);
  }

  liveChannel(id: string): LiveChannel | undefined {
    return this.live.channels.find((c) => c.id === id);
  }

  // State first for every key, then binding by name, so a bind never takes an object another key
  // holds. An object whose key has left the file is free to bind: that is a key renamed in the file.
  resolve<T extends { id: string; name: string }>(
    kind: "role" | "channel" | "automod",
    entries: { key: string; name: string; was?: string[]; label: string; accepts: (o: T) => boolean }[],
    pool: T[],
    into: Resolved,
    byId: Map<string, string>,
  ): void {
    const inSpec = new Set(entries.map((e) => e.key));
    const orphans = new Map<string, string>(); // id -> the key it was held under
    for (const [k, id] of this.input.state) {
      if (k.startsWith(`${kind}:`) && !inSpec.has(k.slice(kind.length + 1))) orphans.set(id, k.slice(kind.length + 1));
    }
    const claimed = new Set<string>();
    const pending: typeof entries = [];
    for (const e of entries) {
      const id = this.input.state.get(stateKey(kind, e.key));
      if (id && pool.some((o) => o.id === id)) {
        into.set(e.key, id);
        byId.set(id, e.key);
        claimed.add(id);
      } else {
        pending.push(e);
      }
    }
    for (const id of this.input.state.values()) if (!orphans.has(id)) claimed.add(id);
    for (const e of pending) {
      // The current name first; a former name only when nothing has the current one.
      const named = (name: string) => pool.filter((o) => o.name === name && e.accepts(o) && !claimed.has(o.id));
      let found = named(e.name);
      for (const old of e.was ?? []) if (found.length === 0) found = named(old);
      if (found.length > 1) {
        const what = kind === "role" ? "roles" : kind === "channel" ? "channels" : "AutoMod rules";
        this.manual.push(`${found.length} ${what} named "${e.name}": rename one in Discord so "${e.key}" can bind to the other, then plan again`);
      } else if (found.length === 1) {
        const id = found[0]!.id;
        into.set(e.key, id);
        byId.set(id, e.key);
        claimed.add(id);
        const replaces = orphans.get(id);
        if (replaces !== undefined) this.rebound.add(id);
        const label = kind === "role" ? `role "${found[0]!.name}"` : kind === "channel" ? channelLabel(found[0]!.name, (found[0] as unknown as LiveChannel).type) : e.label;
        this.ops.push({ t: "bind", kind, key: e.key, id, label, ...(replaces !== undefined ? { replaces } : {}) });
      } else {
        into.set(e.key, null);
      }
    }
  }

  resolveRoles(): void {
    const { live, spec } = this.input;
    const everyone = live.guild.id;
    const bot = live.roles.find((r) => r.botId === live.botId);
    const booster = live.roles.find((r) => r.booster);
    const reserved: [string, LiveRole | undefined][] = [
      ["everyone", this.liveRole(everyone)],
      ["bot", bot],
      ["booster", booster],
    ];
    for (const [key, role] of reserved) {
      if (role) {
        this.roles.set(key, role.id);
        this.roleKeyById.set(role.id, key);
      } else {
        this.absentRoles.add(key);
      }
    }
    if (this.absentRoles.has("booster") && this.mentions("booster")) {
      this.manual.push('This server has no Server Booster role, so what names "booster" waits until someone boosts. Nothing to do');
    }
    const pool = live.roles.filter((r) => !r.managed && r.id !== everyone);
    this.resolve(
      "role",
      spec.roles.map((r) => ({ key: r.key, name: r.name, was: r.was, label: `role "${r.name}"`, accepts: () => true })),
      pool,
      this.roles,
      this.roleKeyById,
    );
  }

  mentions(role: string): boolean {
    const { spec } = this.input;
    const inOverwrites = channelsFlat(spec).some(({ channel }) => role in (channel.overwrites ?? {}));
    const inRules = spec.automod.some((r) => r.exemptRoles?.includes(role));
    const inSettings = Object.values(spec.bot).some(
      (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (("role" in v && v.role === role) || ("roles" in v && v.roles.includes(role))),
    );
    return inOverwrites || inRules || inSettings;
  }

  resolveChannels(): void {
    this.resolve<LiveChannel>(
      "channel",
      channelsFlat(this.input.spec).map(({ channel }) => ({
        key: channel.key,
        name: channel.name,
        was: channel.was,
        label: channelLabel(channel.name, CHANNEL_TYPE[channel.type]),
        accepts: (c: LiveChannel) => c.type === CHANNEL_TYPE[channel.type] || convertible(c.type, CHANNEL_TYPE[channel.type]),
      })),
      this.live.channels,
      this.channels,
      this.channelKeyById,
    );
  }

  aboveBot(role: LiveRole): boolean {
    return role.position >= this.live.botTopPosition;
  }

  planRoles(): void {
    const { spec } = this.input;
    for (const role of spec.roles) {
      if (!this.roles.has(role.key)) continue;
      const id = this.roles.get(role.key);
      const permissions = toBits(role.permissions);
      if (id === null) {
        this.ops.push({
          t: "role.create",
          key: role.key,
          name: role.name,
          color: role.color ?? 0,
          hoist: role.hoist ?? false,
          mentionable: role.mentionable ?? false,
          permissions,
          flags: [],
        });
        continue;
      }
      const live = this.liveRole(id!)!;
      const changes: Change[] = [];
      const field = (name: string, from: unknown, to: unknown) => {
        if (from !== to) changes.push({ field: name, from, to });
      };
      const wanted = keepUnnamed(permissions, live.permissions);
      field("name", live.name, role.name);
      field("color", live.color, role.color ?? 0);
      field("hoist", live.hoist, role.hoist ?? false);
      field("mentionable", live.mentionable, role.mentionable ?? false);
      field("permissions", live.permissions, wanted);
      if (changes.length === 0) continue;
      if (this.aboveBot(live)) {
        const byHand = changes
          .map((c) =>
            c.field === "permissions"
              ? `permissions ${permissionDiff(c.from as bigint, c.to as bigint)}`
              : `${c.field === "color" ? "colour" : c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`,
          )
          .join("; ");
        this.manual.push(
          `Role "${live.name}" is above the bot's role, so the bot can't change it. Drag the bot's role above it in Server Settings > Roles and plan again, or change it there by hand: ${byHand}`,
        );
        continue;
      }
      const flags: Flag[] = (wanted & ~live.permissions) !== 0n ? ["widens"] : [];
      this.ops.push({ t: "role.update", key: role.key, changes, flags });
    }

    const everyone = this.liveRole(this.live.guild.id);
    const wanted = everyone ? keepUnnamed(toBits(spec.everyone.permissions), everyone.permissions) : 0n;
    if (everyone && everyone.permissions !== wanted) {
      this.ops.push({
        t: "role.update",
        key: "everyone",
        changes: [{ field: "permissions", from: everyone.permissions, to: wanted }],
        flags: (wanted & ~everyone.permissions) !== 0n ? ["widens"] : [],
      });
    }

    const members = spec.roles.filter((r) => {
      if (!this.roles.has(r.key)) return false;
      const id = this.roles.get(r.key);
      return id === null || !this.aboveBot(this.liveRole(id!)!);
    });
    if (members.length > 1) {
      const created = members.some((r) => this.roles.get(r.key) === null);
      const existing = members.filter((r) => this.roles.get(r.key) !== null);
      const liveOrder = [...existing]
        .sort((a, b) => this.liveRole(this.roles.get(b.key)!)!.position - this.liveRole(this.roles.get(a.key)!)!.position)
        .map((r) => r.key);
      if (created || liveOrder.join() !== existing.map((r) => r.key).join()) {
        this.ops.push({ t: "role.order", keys: members.map((r) => r.key) });
      }
    }
  }

  desiredOverwrites(overwrites: Record<string, Overwrite> | undefined): OverwriteBits[] {
    const out: OverwriteBits[] = [];
    for (const [target, ow] of Object.entries(overwrites ?? {})) {
      if (!this.roles.has(target)) continue; // can't be planned: the manual step says why
      const allow = toBits(Object.entries(ow).filter(([, v]) => v === true).map(([k]) => k) as never);
      const deny = toBits(Object.entries(ow).filter(([, v]) => v === false).map(([k]) => k) as never);
      out.push({ target, allow, deny });
    }
    return out;
  }

  planChannels(): void {
    const { spec } = this.input;
    const flat = channelsFlat(spec);
    const categories = new Map(spec.channels.filter((c): c is CategorySpec => c.type === "category").map((c) => [c.key, c]));
    const reparented = new Set<string>();
    for (const { channel, parent } of flat) {
      if (!this.channels.has(channel.key)) continue;
      if (parent !== null && !this.channels.has(parent)) {
        this.skipped.add(channel.key); // its category can't be planned
        continue;
      }
      const id = this.channels.get(channel.key);
      const type = CHANNEL_TYPE[channel.type];
      const plain = channel.type !== "category" ? (channel as ChannelSpec) : undefined;
      // A channel in a category with no permissions set takes the category's, as a synced
      // channel does in Discord. `overwrites: {}` means none.
      const own = channel.overwrites ?? (parent !== null ? categories.get(parent)?.overwrites : undefined);
      const desired = this.desiredOverwrites(own);
      if (id === null && (type === 5 || type === 13) && !this.communityAfter()) {
        this.manual.push(`${channelLabel(channel.name, type)} needs Community on: turn it on in the file (guild.community), or make it a text channel there`);
        this.skipped.add(channel.key);
        continue;
      }
      if (id === null) {
        const visibleTo = this.viewers(desired);
        this.ops.push({
          t: "channel.create",
          key: channel.key,
          type,
          name: channel.name,
          parent,
          topic: plain?.topic ?? null,
          slowmode: plain?.slowmode ?? 0,
          nsfw: plain?.nsfw ?? false,
          overwrites: desired,
          visibleTo,
          ...(plain?.forum ? { forum: forumBody(plain.forum) } : {}),
          flags: visibleTo.length > 0 ? ["widens"] : [],
        });
        continue;
      }
      const live = this.liveChannel(id!)!;
      if (convertible(live.type, type)) {
        if (this.communityAfter()) {
          this.ops.push({ t: "channel.update", key: channel.key, changes: [{ field: "type", from: KIND_NAME[live.type], to: channel.type }], flags: [] });
        } else {
          this.manual.push(`${channelLabel(live.name, live.type)} becomes an announcement channel once Community is on: turn it on in the file (guild.community)`);
        }
      } else if (live.type !== type) {
        this.manual.push(
          `${channelLabel(live.name, live.type)} is a ${KIND_NAME[live.type] ?? live.type} channel in Discord but ${channel.type} in the file, and Discord can't change a channel's type. Change the type in the file, or rename the old channel in Discord so the plan creates a new one`,
        );
        continue;
      }
      const changes: Change[] = [];
      const field = (name: string, from: unknown, to: unknown) => {
        if (from !== to) changes.push({ field: name, from, to });
      };
      field("name", live.name, channel.name);
      if (plain) {
        if (hasTopic(type)) field("topic", live.topic ?? "", plain.topic ?? "");
        field("slowmode", live.slowmode, plain.slowmode ?? 0);
        field("nsfw", live.nsfw, plain.nsfw ?? false);
        if (plain.forum && live.forum) {
          const want = forumBody(plain.forum);
          const have: ForumBody = {
            tags: live.forum.tags.map((t) => ({ name: t.name, emoji: t.emoji, moderated: t.moderated })),
            requireTag: (live.forum.flags & 16) !== 0,
            reaction: live.forum.reaction,
            sort: live.forum.sort,
            layout: live.forum.layout,
            threadSlowmode: live.forum.threadSlowmode,
          };
          for (const k of Object.keys(want) as (keyof ForumBody)[]) {
            if (JSON.stringify(want[k]) !== JSON.stringify(have[k])) changes.push({ field: k, from: have[k], to: want[k] });
          }
        }
        const liveParent = live.parentId === null ? null : (this.channelKeyById.get(live.parentId) ?? live.parentId);
        if (liveParent !== parent) {
          changes.push({ field: "parent", from: liveParent, to: parent });
          reparented.add(channel.key);
        }
      }
      if (changes.length > 0) this.ops.push({ t: "channel.update", key: channel.key, changes, flags: [] });
      this.planOverwrites(channel, own, live, desired);
    }
    this.planOrder(flat, reparented);
  }

  // The roles in the spec that could view a channel with these overwrites, in Discord's order:
  // @everyone's and the role's permissions, then the @everyone overwrite, then the role's.
  // Administrator holders see every channel, so they aren't named.
  viewers(desired: OverwriteBits[]): string[] {
    const view = toBits(["ViewChannel"]);
    const admin = toBits(["Administrator"]);
    const base = toBits(this.input.spec.everyone.permissions);
    const ow = (target: string) => desired.find((o) => o.target === target);
    const apply = (bits: bigint, o: OverwriteBits | undefined) => (o ? (bits & ~o.deny) | o.allow : bits);
    const sees = (own: bigint, key: string | null) => {
      let bits = base | own;
      if ((bits & admin) !== 0n) return false;
      bits = apply(bits, ow("everyone"));
      if (key !== null) bits = apply(bits, ow(key));
      return (bits & view) !== 0n;
    };
    const out: string[] = [];
    if (sees(0n, null)) out.push("everyone");
    for (const role of this.input.spec.roles) if (sees(toBits(role.permissions), role.key)) out.push(role.key);
    return out;
  }

  planOverwrites(
    channel: ChannelSpec | CategorySpec,
    own: Record<string, Overwrite> | undefined,
    live: LiveChannel,
    desired: OverwriteBits[],
  ): void {
    const label = channelLabel(live.name, live.type);
    const blocked = new Set(Object.keys(own ?? {}).filter((k) => !this.roles.has(k)));
    const seen = new Set<string>();
    const sets: Op[] = [];
    const deletes: Op[] = [];
    for (const o of live.overwrites) {
      if (o.type === 1) {
        if (channel.members === "managed") {
          deletes.push({ t: "overwrite.delete", channel: channel.key, target: `member:${o.id}`, before: { allow: o.allow, deny: o.deny }, flags: o.deny !== 0n ? ["widens"] : [] });
        } else {
          this.unmanaged.push(`${label}: permissions for member ${o.id}`);
        }
        continue;
      }
      const key = this.roleKeyById.get(o.id);
      if (key === undefined) {
        const name = this.liveRole(o.id)?.name ?? o.id;
        this.unmanaged.push(`${label}: permissions for role "${name}"`);
        continue;
      }
      if (blocked.has(key)) continue;
      seen.add(key);
      const declared = desired.find((d) => d.target === key);
      const before = { allow: o.allow, deny: o.deny };
      if (!declared) {
        deletes.push({ t: "overwrite.delete", channel: channel.key, target: key, before, flags: o.deny !== 0n ? ["widens"] : [] });
        continue;
      }
      const want = { allow: keepUnnamed(declared.allow, o.allow), deny: keepUnnamed(declared.deny, o.deny) };
      if (want.allow !== o.allow || want.deny !== o.deny) {
        sets.push({ t: "overwrite.set", channel: channel.key, target: key, allow: want.allow, deny: want.deny, before, flags: widens(before, want) ? ["widens"] : [] });
      }
    }
    const added: Op[] = desired
      .filter((d) => !seen.has(d.target))
      .map((d) => ({ t: "overwrite.set", channel: channel.key, target: d.target, allow: d.allow, deny: d.deny, before: null, flags: widens(null, d) ? ["widens"] : [] }));
    // Spec order for sets (changed and new alike), then removals in live order.
    const ordered = desired
      .map((d) => [...sets, ...added].find((op) => op.t === "overwrite.set" && op.target === d.target))
      .filter((op): op is Op => op !== undefined);
    this.ops.push(...ordered, ...deletes);
  }

  planOrder(flat: ReturnType<typeof channelsFlat>, reparented: Set<string>): void {
    const plannable = flat.filter(
      ({ channel, parent }) => this.channels.has(channel.key) && !this.skipped.has(channel.key) && (parent === null || this.channels.has(parent)),
    );
    const groupOf = (c: { channel: ChannelSpec | CategorySpec; parent: string | null }) =>
      `${c.parent ?? ""}/${bucketOf(CHANNEL_TYPE[c.channel.type])}`;
    const groups = new Map<string, { key: string; id: string | null }[]>();
    for (const c of plannable) {
      const g = groupOf(c);
      groups.set(g, [...(groups.get(g) ?? []), { key: c.channel.key, id: this.channels.get(c.channel.key) ?? null }]);
    }
    // A group moves when a channel is created in it or moved into it, or its live order differs.
    const moving = new Set(plannable.filter((c) => reparented.has(c.channel.key)).map(groupOf));
    for (const [g, list] of groups) {
      if (list.length < 2) {
        moving.delete(g);
        continue;
      }
      if (list.some((c) => c.id === null)) moving.add(g);
      const existing = list.filter((c) => c.id !== null);
      const liveOrder = [...existing]
        .sort((a, b) => {
          const la = this.liveChannel(a.id!)!;
          const lb = this.liveChannel(b.id!)!;
          return la.position - lb.position || (BigInt(la.id) < BigInt(lb.id) ? -1 : 1);
        })
        .map((c) => c.key);
      if (liveOrder.join() !== existing.map((c) => c.key).join()) moving.add(g);
    }
    if (moving.size > 0) {
      this.ops.push({
        t: "channel.order",
        items: plannable.filter((c) => moving.has(groupOf(c))).map(({ channel, parent }) => ({ key: channel.key, parent })),
      });
    }
  }

  resolveAutomod(): void {
    this.resolve<LiveRule>(
      "automod",
      this.input.spec.automod.map((r) => ({ key: r.key, name: r.name, label: `AutoMod "${r.name}"`, accepts: () => true })),
      this.live.rules.filter((r) => r.triggerType === 1),
      this.rules,
      this.ruleKeyById,
    );
  }

  channelRef(id: string | null): string | null {
    return id === null ? null : (this.channelKeyById.get(id) ?? id);
  }

  // What Discord asks before it turns Community on, as the server will be after this plan.
  communityMissing(): string[] {
    const g = this.input.spec.guild;
    const live = this.live.guild;
    const filterAfter = g.explicitContentFilter ?? FILTER[live.explicitContentFilter];
    const levelAfter = g.verificationLevel !== undefined ? VERIFICATION.indexOf(g.verificationLevel) : live.verificationLevel;
    const missing: string[] = [];
    if (filterAfter !== "all") missing.push('Community needs the explicit-content filter on all members: set guild.explicitContentFilter to "all" in the file');
    if (levelAfter < 1) missing.push('Community needs a verification level of low or higher: set guild.verificationLevel in the file');
    return missing;
  }

  communityAfter(): boolean {
    if (this.live.guild.features.includes("COMMUNITY")) return this.input.spec.guild.community !== false;
    return !!this.input.spec.guild.community && this.communityMissing().length === 0;
  }

  planGuild(): void {
    const g = this.input.spec.guild;
    const live = this.live.guild;
    const changes: Change[] = [];
    let lowered = false;
    const field = (name: string, from: unknown, to: unknown) => {
      if (to !== undefined && from !== to) changes.push({ field: name, from, to });
    };
    // A channel field naming a key that can't be planned is left as it is.
    const channelField = (name: string, from: string | null, to: string | null | undefined) => {
      if (to === undefined || (to !== null && !this.usable(to))) return;
      field(name, from, to);
    };
    field("name", live.name, g.name);
    field("description", live.description, g.description);
    const level = (n: number) => VERIFICATION[n] ?? String(n);
    const filter = (n: number) => FILTER[n] ?? String(n);
    field("verificationLevel", level(live.verificationLevel), g.verificationLevel);
    if (g.verificationLevel !== undefined && VERIFICATION.indexOf(g.verificationLevel) < live.verificationLevel) lowered = true;
    field("explicitContentFilter", filter(live.explicitContentFilter), g.explicitContentFilter);
    if (g.explicitContentFilter !== undefined && FILTER.indexOf(g.explicitContentFilter) < live.explicitContentFilter) lowered = true;
    field("defaultNotifications", NOTIFY[live.defaultNotifications] ?? String(live.defaultNotifications), g.defaultNotifications);
    channelField("systemChannel", this.channelRef(live.systemChannelId), g.systemChannel);
    channelField("safetyAlertsChannel", this.channelRef(live.safetyAlertsChannelId), g.safetyAlertsChannel);

    const on = live.features.includes("COMMUNITY");
    let community: Op | null = null;
    if (g.community && !on) {
      const missing = this.communityMissing();
      for (const key of [g.community.rules, g.community.updates]) {
        if (!this.usable(key)) missing.push(`Community needs #${key}, which this plan can't make`);
      }
      if (missing.length > 0) this.manual.push(...missing);
      else community = { t: "community", enable: true, flags: [] };
    } else if (g.community && on) {
      channelField("rulesChannel", this.channelRef(live.rulesChannelId), g.community.rules);
      channelField("updatesChannel", this.channelRef(live.publicUpdatesChannelId), g.community.updates);
    } else if (g.community === false && on) {
      community = { t: "community", enable: false, flags: ["deletes"] };
    }
    if (changes.length > 0) this.ops.push({ t: "guild.update", changes, flags: lowered ? ["widens"] : [] });
    if (community) this.ops.push(community);
    if (g.requireMfa && live.mfaLevel === 0) {
      this.manual.push(
        "Owner: turn on 2FA for moderation in Server Settings > Safety Setup > Permissions > Require 2FA for moderator actions. Your account needs 2FA first: User Settings > My Account > Enable Authenticator App",
      );
    }
  }

  planAssets(): void {
    const g = this.input.spec.guild;
    const needs: Record<"banner" | "splash", [string, string]> = {
      banner: ["BANNER", "The banner needs boost level 2 (7 boosts): it's applied once the server has it"],
      splash: ["INVITE_SPLASH", "The invite background needs boost level 1 (2 boosts): it's applied once the server has it"],
    };
    for (const key of ["icon", "banner", "splash"] as const) {
      const file = g[key];
      if (file === undefined) continue;
      if (key !== "icon" && !this.live.guild.features.includes(needs[key][0])) {
        this.manual.push(needs[key][1]);
        continue;
      }
      const hash = createHash("sha256").update(readFileSync(join(this.input.spec.dir, file))).digest("hex");
      const applied = this.input.state.get(stateKey("asset", key));
      if (applied === hash) continue;
      if (applied === undefined && (this.live.guild as unknown as Record<string, unknown>)[key]) {
        this.ops.push({ t: "bind", kind: "asset", key, id: hash, label: key });
      } else {
        this.ops.push({ t: "asset.set", key, file, hash });
      }
    }
  }

  automodBody(rule: AutoModSpec): AutoModBody {
    const actions: AutoModBody["actions"] = [];
    if (rule.block !== undefined) actions.push(typeof rule.block === "string" ? { type: 1, message: rule.block } : { type: 1 });
    if (rule.alert !== undefined) actions.push({ type: 2, channel: rule.alert });
    if (rule.timeoutSeconds !== undefined) actions.push({ type: 3, seconds: rule.timeoutSeconds });
    return {
      name: rule.name,
      enabled: rule.enabled ?? true,
      keywords: rule.keywords ?? [],
      regex: rule.regex ?? [],
      allow: rule.allow ?? [],
      actions,
      exemptRoles: (rule.exemptRoles ?? []).filter((k) => !this.absentRoles.has(k)),
      exemptChannels: rule.exemptChannels ?? [],
    };
  }

  liveBody(rule: LiveRule): AutoModBody {
    return {
      name: rule.name,
      enabled: rule.enabled,
      keywords: rule.keywords,
      regex: rule.regex,
      allow: rule.allow,
      actions: rule.actions.map((a) => {
        const out: AutoModBody["actions"][number] = { type: a.type };
        if (a.message !== undefined) out.message = a.message;
        if (a.channelId !== undefined) out.channel = this.channelKeyById.get(a.channelId) ?? a.channelId;
        if (a.seconds !== undefined) out.seconds = a.seconds;
        return out;
      }),
      exemptRoles: rule.exemptRoles.map((id) => this.roleKeyById.get(id) ?? id),
      exemptChannels: rule.exemptChannels.map((id) => this.channelKeyById.get(id) ?? id),
    };
  }

  planAutomod(): void {
    for (const rule of this.input.spec.automod) {
      if (!this.rules.has(rule.key)) continue;
      const refs = [...(rule.exemptRoles ?? []).filter((k) => !this.absentRoles.has(k)).map((k) => this.roles.has(k)), ...(rule.exemptChannels ?? []).map((k) => this.usable(k))];
      if (rule.alert !== undefined) refs.push(this.usable(rule.alert));
      if (refs.includes(false)) continue; // names something that can't be planned
      const body = this.automodBody(rule);
      const id = this.rules.get(rule.key);
      if (id === null) {
        this.ops.push({ t: "automod.create", key: rule.key, body });
        continue;
      }
      const live = this.liveBody(this.live.rules.find((r) => r.id === id)!);
      const changes: Change[] = [];
      for (const f of Object.keys(body) as (keyof AutoModBody)[]) {
        if (JSON.stringify(live[f]) !== JSON.stringify(body[f])) changes.push({ field: f, from: live[f], to: body[f] });
      }
      if (changes.length > 0) this.ops.push({ t: "automod.update", key: rule.key, body, changes });
    }
  }

  // A setting's value as stored: a key resolved to its id. Undefined when it names something not
  // yet created (compared as different; Apply resolves it) or that can't be planned.
  // "pending": names something this plan creates (compared as different; Apply resolves it).
  // "skip": names something that can't be planned, so the setting is left alone.
  settingValue(value: SettingValue): { ok: true; value: unknown } | { ok: false; why: "pending" | "skip" } {
    const resolve = (key: string, kind: "channel" | "role") => {
      if (kind === "channel" ? !this.usable(key) : !this.roles.has(key)) return "skip" as const;
      const id = (kind === "channel" ? this.channels : this.roles).get(key);
      return typeof id === "string" ? id : ("pending" as const);
    };
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const ids =
        "channel" in value ? [resolve(value.channel, "channel")] : "role" in value ? [resolve(value.role, "role")] : value.roles.map((k) => resolve(k, "role"));
      if (ids.includes("skip")) return { ok: false, why: "skip" };
      if (ids.includes("pending")) return { ok: false, why: "pending" };
      return { ok: true, value: "roles" in value ? ids : ids[0] };
    }
    return { ok: true, value: value === null ? undefined : value };
  }

  planSettings(): void {
    const { spec, settings } = this.input;
    for (const [key, value] of Object.entries(spec.bot)) {
      const stored = settings[key];
      const fallback = REGISTRY_BY_KEY.get(key)?.default;
      const current = stored !== undefined ? stored : fallback;
      const wanted = this.settingValue(value);
      if (!wanted.ok && wanted.why === "skip") continue;
      if (wanted.ok && JSON.stringify(wanted.value ?? null) === JSON.stringify(current ?? null)) continue;
      this.ops.push({ t: "setting.set", key, value, before: current });
    }
    const loose = Object.keys(settings).filter((k) => !(k in spec.bot)).length;
    if (loose > 0) this.unmanaged.push(`${loose} bot setting${loose === 1 ? "" : "s"} set in /config but not in the file`);
  }

  planPosts(): void {
    const { spec, state } = this.input;
    const kinds = new Map(channelsFlat(spec).map(({ channel }) => [channel.key, channel.type]));
    for (const post of spec.posts) {
      if (!this.usable(post.channel)) continue;
      const channelId = this.channels.get(post.channel);
      const forum = kinds.get(post.channel) === "forum";
      // "{#key}" names a channel: filled in with its id here, or at apply for one this plan creates.
      const fill = (text: string) =>
        text.replace(/\{#([a-z0-9-]+)\}/g, (all, key: string) => {
          const id = this.channels.get(key);
          return typeof id === "string" ? `<#${id}>` : all;
        });
      const chunks = splitPost(readFileSync(join(spec.dir, post.file), "utf8")).map(fill);
      const last = chunks.length - 1;
      const menu = post.menu ? spec.menus?.find((m) => m.key === post.menu) : undefined;
      const components = menu ? menuComponents(menu) : undefined;
      const menuHash = components ? createHash("sha256").update(JSON.stringify(components)).digest("hex") : undefined;
      const postedMenu = state.get(stateKey("post", `${post.key}#menu`));
      const posted = (i: number) => {
        const v = state.get(stateKey("post", `${post.key}#${i}`));
        return v === undefined ? undefined : parsePosted(v);
      };
      let recreate = false;
      for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i]!;
        const at = posted(i);
        const liveContent = at ? this.live.posts.get(at.message) : undefined;
        const threadGone = forum && i === 0 && at !== undefined && this.live.threads.get(at.channel) == null;
        const moved = at !== undefined && (at.forum ?? at.channel) !== channelId;
        const withMenu = i === last ? { ...(components ? { components, menuHash } : {}) } : {};
        if (recreate || at === undefined || liveContent == null || moved || threadGone) {
          if (at !== undefined && liveContent != null) this.ops.push({ t: "post.delete", key: post.key, index: i });
          const thread = forum && i === 0 ? { thread: { title: post.title ?? post.key, pin: post.pin ?? false } } : {};
          this.ops.push({ t: "post.create", key: post.key, index: i, channel: post.channel, content, ...thread, ...withMenu });
          recreate = true; // later chunks must follow it, so they are posted again after it
        } else {
          const menuChanged = i === last && (menuHash ?? null) !== (postedMenu ?? null);
          if (liveContent !== content || menuChanged) {
            const clear = menuChanged && !components ? { clearMenu: true } : {};
            this.ops.push({ t: "post.edit", key: post.key, index: i, content, ...withMenu, ...clear });
          }
        }
      }
      // A forum post's thread follows the spec's title and pin.
      const first = posted(0);
      if (forum && !recreate && first) {
        const thread = this.live.threads.get(first.channel);
        const title = post.title ?? post.key;
        const pin = post.pin ?? false;
        if (thread && (thread.name !== title || ((thread.flags & 2) !== 0) !== pin)) {
          this.ops.push({ t: "post.title", key: post.key, title, pin });
        }
      }
      for (let i = chunks.length; posted(i) !== undefined; i++) {
        this.ops.push({ t: "post.delete", key: post.key, index: i });
      }
    }
  }

  planDeletions(): void {
    const { spec, state, deletions } = this.input;
    const roleKeys = new Set(spec.roles.map((r) => r.key));
    const channelKeys = new Set(channelsFlat(spec).map((c) => c.channel.key));
    const ruleKeys = new Set(spec.automod.map((r) => r.key));
    const out: Op[] = [];
    // Children before their category, so a category is never deleted out from under them.
    const gone = [...state.entries()]
      .map(([k, id]) => ({ kind: k.slice(0, k.indexOf(":")), key: k.slice(k.indexOf(":") + 1), id }))
      .sort((a, b) => (this.liveChannel(a.id)?.type === 4 ? 1 : 0) - (this.liveChannel(b.id)?.type === 4 ? 1 : 0));
    for (const { kind, key, id } of gone) {
      if (this.rebound.has(id)) continue;
      if (kind === "channel" && !channelKeys.has(key)) {
        const live = this.liveChannel(id);
        if (live) out.push({ t: "channel.delete", key, name: live.name, flags: ["deletes"] });
      } else if (kind === "automod" && !ruleKeys.has(key)) {
        const live = this.live.rules.find((r) => r.id === id);
        if (live) out.push({ t: "automod.delete", key, name: live.name, flags: ["deletes"] });
      } else if (kind === "role" && !roleKeys.has(key)) {
        const live = this.liveRole(id);
        if (!live) continue;
        if (this.aboveBot(live)) {
          this.manual.push(`Role "${live.name}" is above the bot's role, so the bot can't delete it. Delete it in Server Settings > Roles > ${live.name} > Delete Role, or drag the bot's role above it and plan again`);
        } else {
          out.push({ t: "role.delete", key, name: live.name, flags: ["deletes"] });
        }
      }
    }
    (deletions ? this.ops : this.held).push(...out);
  }

  listUnmanaged(): void {
    const stateIds = new Set(this.input.state.values());
    const claimed = (id: string) => stateIds.has(id) || this.roleKeyById.has(id) || this.channelKeyById.has(id);
    const lines: string[] = [];
    const roles = [...this.live.roles]
      .sort((a, b) => b.position - a.position)
      .filter((r) => r.id !== this.live.guild.id && !r.managed && !claimed(r.id));
    const channels = this.live.channels.filter((c) => !claimed(c.id));
    if (this.input.prune) {
      // Channels before their categories, then roles. Community's rules and updates channels can't
      // be deleted while Community is on; a role above the bot's can't be deleted by it.
      const g = this.live.guild;
      const ordered = [...channels.filter((c) => c.type !== 4), ...channels.filter((c) => c.type === 4)];
      for (const c of ordered) {
        if (c.id === g.rulesChannelId || c.id === g.publicUpdatesChannelId) {
          this.manual.push(
            `${channelLabel(c.name, c.type)} is Community's rules or updates channel, so it can't be pruned. Pick another in Server Settings > Community > Overview, then plan again`,
          );
          continue;
        }
        this.ops.push({ t: "prune", kind: "channel", id: c.id, label: channelLabel(c.name, c.type), flags: ["deletes"] });
      }
      for (const r of roles) {
        if (this.aboveBot(r)) this.manual.push(`Role "${r.name}" is above the bot's role, so the bot can't delete it. Delete it in Server Settings > Roles > ${r.name} > Delete Role`);
        else this.ops.push({ t: "prune", kind: "role", id: r.id, label: `role "${r.name}"`, flags: ["deletes"] });
      }
    } else {
      for (const r of roles) lines.push(`role "${r.name}"`);
      for (const c of channels) lines.push(channelLabel(c.name, c.type));
    }
    for (const r of this.live.rules) {
      if (stateIds.has(r.id) || this.ruleKeyById.has(r.id)) continue;
      lines.push(`AutoMod "${r.name}"`);
    }
    this.unmanaged.unshift(...lines);
  }
}

export function buildPlan(input: PlanInput): Plan {
  const p = new Planner(input);
  if ((input.live.botPermissions & toBits(["Administrator"])) === 0n) {
    p.manual.push(
      "Give the bot's role Administrator in Server Settings > Roles > (the bot's role) > Permissions > Administrator, and drag it to the top. Turning Community on, AutoMod and posting in read-only channels need it",
    );
  }
  p.resolveRoles();
  p.resolveChannels();
  p.resolveAutomod();
  p.planRoles();
  p.planChannels();
  p.planGuild();
  p.planAssets();
  p.planAutomod();
  p.planSettings();
  p.planPosts();
  p.planDeletions();
  p.listUnmanaged();
  const plan = { ops: p.ops, held: p.held, manual: p.manual, unmanaged: p.unmanaged };
  return { ...plan, fingerprint: fingerprint({ ...plan, live: input.live, settings: input.settings }) };
}

// JSON with bigints as strings and maps as sorted entries, so equal inputs always hash equal.
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Map) return [...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

// What Apply checks before it writes: a hash of the plan and of the server it was made from. Any
// change to the live server, the bot's settings or the plan gives a different value.
function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

