import type { Live, LiveChannel, LiveRole } from "./live";
import { type AllowDeny, toBits, widens } from "./permissions";
import {
  type CategorySpec,
  type ChannelKind,
  type ChannelSpec,
  channelsFlat,
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
  | { t: "bind"; kind: "role" | "channel" | "automod" | "asset"; key: string; id: string; label: string }
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
      flags: Flag[];
    }
  | { t: "channel.update"; key: string; changes: Change[]; flags: Flag[] }
  | { t: "channel.delete"; key: string; name: string; flags: Flag[] }
  | { t: "channel.order"; items: { key: string; parent: string | null }[] }
  | { t: "overwrite.set"; channel: string; target: string; allow: bigint; deny: bigint; before: AllowDeny | null; flags: Flag[] }
  | { t: "overwrite.delete"; channel: string; target: string; before: AllowDeny; flags: Flag[] }
  | { t: "guild.update"; changes: Change[]; flags: Flag[] }
  | { t: "community"; enable: boolean; flags: Flag[] }
  | { t: "asset.set"; key: "icon" | "banner"; file: string; hash: string }
  | { t: "automod.create"; key: string; body: AutoModBody }
  | { t: "automod.update"; key: string; body: AutoModBody; changes: Change[] }
  | { t: "automod.delete"; key: string; name: string; flags: Flag[] }
  | { t: "setting.set"; key: string; value: SettingValue; before: unknown }
  | { t: "post.create"; key: string; index: number; channel: string; content: string }
  | { t: "post.edit"; key: string; index: number; content: string }
  | { t: "post.delete"; key: string; index: number };

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
}

export const CHANNEL_TYPE: Record<ChannelKind | "category", number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
};

const KIND_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(CHANNEL_TYPE).map(([k, v]) => [v, k]),
);

const hasTopic = (type: number) => type === 0 || type === 5 || type === 15;

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
  readonly roleKeyById = new Map<string, string>();
  readonly channelKeyById = new Map<string, string>();

  constructor(readonly input: PlanInput) {}

  private get live(): Live {
    return this.input.live;
  }

  liveRole(id: string): LiveRole | undefined {
    return this.live.roles.find((r) => r.id === id);
  }

  liveChannel(id: string): LiveChannel | undefined {
    return this.live.channels.find((c) => c.id === id);
  }

  // State first for every key, then binding by name, so a bind never takes an object another key
  // already holds.
  resolve<T extends { id: string; name: string }>(
    kind: "role" | "channel",
    entries: { key: string; name: string; label: string; accepts: (o: T) => boolean }[],
    pool: T[],
    into: Resolved,
    byId: Map<string, string>,
  ): void {
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
    for (const id of this.input.state.values()) claimed.add(id);
    for (const e of pending) {
      const found = pool.filter((o) => o.name === e.name && e.accepts(o) && !claimed.has(o.id));
      if (found.length > 1) {
        const what = kind === "role" ? "roles" : "channels";
        this.manual.push(`${found.length} ${what} named "${e.name}": rename one so "${e.key}" can bind`);
      } else if (found.length === 1) {
        const id = found[0]!.id;
        into.set(e.key, id);
        byId.set(id, e.key);
        claimed.add(id);
        this.ops.push({ t: "bind", kind, key: e.key, id, label: e.label });
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
      }
    }
    const pool = live.roles.filter((r) => !r.managed && r.id !== everyone);
    this.resolve(
      "role",
      spec.roles.map((r) => ({ key: r.key, name: r.name, label: `role "${r.name}"`, accepts: () => true })),
      pool,
      this.roles,
      this.roleKeyById,
    );
  }

  resolveChannels(): void {
    this.resolve<LiveChannel>(
      "channel",
      channelsFlat(this.input.spec).map(({ channel }) => ({
        key: channel.key,
        name: channel.name,
        label: channelLabel(channel.name, CHANNEL_TYPE[channel.type]),
        accepts: (c: LiveChannel) => c.type === CHANNEL_TYPE[channel.type],
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
      field("name", live.name, role.name);
      field("color", live.color, role.color ?? 0);
      field("hoist", live.hoist, role.hoist ?? false);
      field("mentionable", live.mentionable, role.mentionable ?? false);
      field("permissions", live.permissions, permissions);
      if (changes.length === 0) continue;
      if (this.aboveBot(live)) {
        this.manual.push(`Role "${live.name}" is above the bot's role: change it by hand, or move the bot's role above it`);
        continue;
      }
      const flags: Flag[] = (permissions & ~live.permissions) !== 0n ? ["widens"] : [];
      this.ops.push({ t: "role.update", key: role.key, changes, flags });
    }

    const everyone = this.liveRole(this.live.guild.id);
    const wanted = toBits(spec.everyone.permissions);
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
    const reparented = new Set<string>();
    for (const { channel, parent } of flat) {
      if (!this.channels.has(channel.key)) continue;
      if (parent !== null && !this.channels.has(parent)) continue; // its category can't be planned
      const id = this.channels.get(channel.key);
      const type = CHANNEL_TYPE[channel.type];
      const plain = channel.type !== "category" ? (channel as ChannelSpec) : undefined;
      const desired = this.desiredOverwrites(channel.overwrites);
      if (id === null) {
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
          flags: this.visibleToEveryone(desired) || desired.some((o) => o.allow !== 0n) ? ["widens"] : [],
        });
        continue;
      }
      const live = this.liveChannel(id!)!;
      if (live.type !== type) {
        this.manual.push(
          `${channelLabel(live.name, live.type)} is a ${KIND_NAME[live.type] ?? live.type} channel in Discord but ${channel.type} in the file: change it by hand`,
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
        const liveParent = live.parentId === null ? null : (this.channelKeyById.get(live.parentId) ?? live.parentId);
        if (liveParent !== parent) {
          changes.push({ field: "parent", from: liveParent, to: parent });
          reparented.add(channel.key);
        }
      }
      if (changes.length > 0) this.ops.push({ t: "channel.update", key: channel.key, changes, flags: [] });
      this.planOverwrites(channel, live, desired);
    }
    this.planOrder(flat, reparented);
  }

  // Whether @everyone could see a channel with these overwrites: its base permissions grant view
  // and no overwrite for it takes view away.
  visibleToEveryone(desired: OverwriteBits[]): boolean {
    const base = toBits(this.input.spec.everyone.permissions);
    const ow = desired.find((o) => o.target === "everyone");
    const view = toBits(["ViewChannel"]);
    if (ow && (ow.deny & view) !== 0n) return false;
    return (base & view) !== 0n || (ow !== undefined && (ow.allow & view) !== 0n);
  }

  planOverwrites(channel: ChannelSpec | CategorySpec, live: LiveChannel, desired: OverwriteBits[]): void {
    const label = channelLabel(live.name, live.type);
    const blocked = new Set(Object.keys(channel.overwrites ?? {}).filter((k) => !this.roles.has(k)));
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
      const want = desired.find((d) => d.target === key);
      const before = { allow: o.allow, deny: o.deny };
      if (!want) {
        deletes.push({ t: "overwrite.delete", channel: channel.key, target: key, before, flags: o.deny !== 0n ? ["widens"] : [] });
      } else if (want.allow !== o.allow || want.deny !== o.deny) {
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
    const groups = new Map<string, { key: string; id: string | null; type: number }[]>();
    for (const { channel, parent } of flat) {
      if (!this.channels.has(channel.key)) continue;
      if (parent !== null && !this.channels.has(parent)) continue;
      const type = CHANNEL_TYPE[channel.type];
      const g = `${parent ?? ""}/${bucketOf(type)}`;
      const list = groups.get(g) ?? [];
      list.push({ key: channel.key, id: this.channels.get(channel.key) ?? null, type });
      groups.set(g, list);
    }
    let reorder = reparented.size > 0;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      if (list.some((c) => c.id === null)) reorder = true;
      const existing = list.filter((c) => c.id !== null);
      const liveOrder = [...existing]
        .sort((a, b) => {
          const la = this.liveChannel(a.id!)!;
          const lb = this.liveChannel(b.id!)!;
          return la.position - lb.position || (BigInt(la.id) < BigInt(lb.id) ? -1 : 1);
        })
        .map((c) => c.key);
      if (liveOrder.join() !== existing.map((c) => c.key).join()) reorder = true;
    }
    if (reorder) {
      this.ops.push({
        t: "channel.order",
        items: flat
          .filter(({ channel, parent }) => this.channels.has(channel.key) && (parent === null || this.channels.has(parent)))
          .map(({ channel, parent }) => ({ key: channel.key, parent })),
      });
    }
  }

  planDeletions(): void {
    const { spec, state, deletions } = this.input;
    const roleKeys = new Set(spec.roles.map((r) => r.key));
    const channelKeys = new Set(channelsFlat(spec).map((c) => c.channel.key));
    const out: Op[] = [];
    // Children before their category, so a category is never deleted out from under them.
    const gone = [...state.entries()]
      .map(([k, id]) => ({ kind: k.slice(0, k.indexOf(":")), key: k.slice(k.indexOf(":") + 1), id }))
      .sort((a, b) => (this.liveChannel(a.id)?.type === 4 ? 1 : 0) - (this.liveChannel(b.id)?.type === 4 ? 1 : 0));
    for (const { kind, key, id } of gone) {
      if (kind === "channel" && !channelKeys.has(key)) {
        const live = this.liveChannel(id);
        if (live) out.push({ t: "channel.delete", key, name: live.name, flags: ["deletes"] });
      } else if (kind === "role" && !roleKeys.has(key)) {
        const live = this.liveRole(id);
        if (!live) continue;
        if (this.aboveBot(live)) {
          this.manual.push(`Role "${live.name}" is above the bot's role: delete it by hand, or move the bot's role above it`);
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
    for (const r of [...this.live.roles].sort((a, b) => b.position - a.position)) {
      if (r.id === this.live.guild.id || r.managed || claimed(r.id)) continue;
      lines.push(`role "${r.name}"`);
    }
    for (const c of this.live.channels) {
      if (claimed(c.id)) continue;
      lines.push(channelLabel(c.name, c.type));
    }
    this.unmanaged.unshift(...lines);
  }
}

export function buildPlan(input: PlanInput): Plan {
  const p = new Planner(input);
  p.resolveRoles();
  p.resolveChannels();
  p.planRoles();
  p.planChannels();
  p.planDeletions();
  p.listUnmanaged();
  return { ops: p.ops, held: p.held, manual: p.manual, unmanaged: p.unmanaged, fingerprint: "" };
}

