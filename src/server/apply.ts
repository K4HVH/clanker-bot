import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { BotDatabase } from "../db/index";
import type { ConfigService } from "../lib/config";
import type { DiscordApi } from "./api";
import { type Live, readLive } from "./live";
import { type AutoModBody, buildPlan, FILTER, NOTIFY, type Op, type Plan, VERIFICATION } from "./plan";
import type { ServerSpec, SettingValue } from "./spec";
import { dropState, loadState, putState, type State, stateKey } from "./state";

export interface ApplyEnv {
  api: DiscordApi;
  db: BotDatabase;
  config: ConfigService;
  guildId: string;
  spec: ServerSpec;
  reason: string; // shown in Discord's audit log on every change
}

export interface ApplyResult {
  done: number;
  failed: { op: Op; error: string } | null;
  remaining: number;
}

// Read the server and plan against it. The bot command and the local command both start here.
export async function planFor(env: Omit<ApplyEnv, "reason">, deletions: boolean): Promise<Plan> {
  const state = loadState(env.db, env.guildId);
  const postIds = [...state.entries()]
    .filter(([k]) => k.startsWith("post:"))
    .map(([, v]) => {
      const [channelId, messageId] = v.split("/");
      return { channelId: channelId!, messageId: messageId! };
    });
  const live = await readLive(env.api, env.guildId, postIds);
  return buildPlan({ spec: env.spec, live, state, settings: env.config.all(env.guildId), deletions });
}

// The order operations run in, whatever order the plan lists them: what a later step names must
// exist first (a role before an overwrite for it, a channel before Community points at it), and
// deletions go last, children before parents.
const PHASE: Record<Op["t"], number> = {
  bind: 0,
  "role.create": 1,
  "role.update": 1,
  "role.order": 2,
  "channel.create": 3,
  "channel.update": 3,
  "channel.order": 4,
  "overwrite.set": 5,
  "overwrite.delete": 5,
  "guild.update": 6,
  "asset.set": 7,
  community: 8,
  "automod.create": 9,
  "automod.update": 9,
  "setting.set": 10,
  "post.create": 11,
  "post.edit": 11,
  "post.delete": 11,
  "automod.delete": 12,
  "channel.delete": 13,
  "role.delete": 14,
};

const bucketOf = (type: number) => (type === 4 ? "category" : type === 2 || type === 13 ? "voice" : "text");

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// Announcement and stage channels exist only on Community servers, so they come after Community is
// turned on; channel order waits for them.
const rank = (op: Op): number => {
  if (op.t === "channel.create" && (op.type === 5 || op.type === 13)) return PHASE.community + 0.5;
  if (op.t === "channel.order") return PHASE.community + 0.7;
  return PHASE[op.t];
};

export async function applyPlan(env: ApplyEnv, plan: Plan): Promise<ApplyResult> {
  const ops = plan.ops.map((op, i) => ({ op, i })).sort((a, b) => rank(a.op) - rank(b.op) || a.i - b.i).map((x) => x.op);
  const runner = new Runner(env, loadState(env.db, env.guildId), await readLive(env.api, env.guildId, []));
  let done = 0;
  for (const op of ops) {
    try {
      await runner.run(op);
      done++;
    } catch (error) {
      return { done, failed: { op, error: error instanceof Error ? error.message : String(error) }, remaining: ops.length - done };
    }
  }
  return { done, failed: null, remaining: 0 };
}

class Runner {
  constructor(
    private readonly env: ApplyEnv,
    private readonly state: State,
    private readonly live: Live,
  ) {}

  private get g(): `/guilds/${string}` {
    return `/guilds/${this.env.guildId}`;
  }

  private put(kind: Parameters<typeof putState>[2], key: string, id: string): void {
    putState(this.env.db, this.env.guildId, kind, key, id);
    this.state.set(stateKey(kind, key), id);
  }

  private drop(kind: Parameters<typeof dropState>[2], key: string): void {
    dropState(this.env.db, this.env.guildId, kind, key);
    this.state.delete(stateKey(kind, key));
  }

  private need(kind: "role" | "channel" | "automod" | "post", key: string): string {
    const id = this.state.get(stateKey(kind, key));
    if (id === undefined) throw new Error(`no ${kind} for key "${key}"`);
    return id;
  }

  role(key: string): string {
    if (key === "everyone") return this.env.guildId;
    if (key === "bot" || key === "booster") {
      const r = this.live.roles.find((x) => (key === "bot" ? x.botId === this.live.botId : x.booster));
      if (!r) throw new Error(`this server has no ${key === "bot" ? "bot" : "booster"} role`);
      return r.id;
    }
    return this.need("role", key);
  }

  channel(key: string): string {
    return this.need("channel", key);
  }

  private optionalChannel(key: unknown): string | null {
    return key === null || key === undefined ? null : this.channel(String(key));
  }

  async run(op: Op): Promise<void> {
    const { api, reason } = this.env;
    switch (op.t) {
      case "bind":
        this.put(op.kind, op.key, op.id);
        if (op.replaces !== undefined && op.kind !== "asset") this.drop(op.kind, op.replaces);
        return;
      case "role.create": {
        const r = await api.post<{ id: string }>(
          `${this.g}/roles`,
          { name: op.name, color: op.color, hoist: op.hoist, mentionable: op.mentionable, permissions: String(op.permissions) },
          reason,
        );
        this.put("role", op.key, r.id);
        return;
      }
      case "role.update": {
        const body: Record<string, unknown> = {};
        for (const c of op.changes) body[c.field] = c.field === "permissions" ? String(c.to) : c.to;
        await api.patch(`${this.g}/roles/${this.role(op.key)}`, body, reason);
        return;
      }
      case "role.delete":
        await api.delete(`${this.g}/roles/${this.role(op.key)}`, reason);
        this.drop("role", op.key);
        return;
      case "role.order": {
        // Permute the positions these roles already hold, so roles the spec doesn't manage, and
        // the bot's own, keep theirs.
        const roles = await api.get<{ id: string; position: number }[]>(`${this.g}/roles`);
        const ids = op.keys.map((k) => this.role(k));
        const slots = ids.map((id) => roles.find((r) => r.id === id)!.position).sort((a, b) => b - a);
        await api.patch(`${this.g}/roles`, ids.map((id, i) => ({ id, position: slots[i] })), reason);
        return;
      }
      case "channel.create": {
        const textLike = op.type === 0 || op.type === 5 || op.type === 15 || op.type === 16;
        const body: Record<string, unknown> = {
          name: op.name,
          type: op.type,
          permission_overwrites: op.overwrites.map((o) => ({ id: this.role(o.target), type: 0, allow: String(o.allow), deny: String(o.deny) })),
        };
        if (op.parent !== null) body.parent_id = this.channel(op.parent);
        if (textLike && op.topic !== null) body.topic = op.topic;
        if (op.type !== 4) {
          body.rate_limit_per_user = op.slowmode;
          body.nsfw = op.nsfw;
        }
        const c = await api.post<{ id: string }>(`${this.g}/channels`, body, reason);
        this.put("channel", op.key, c.id);
        return;
      }
      case "channel.update": {
        const body: Record<string, unknown> = {};
        for (const c of op.changes) {
          if (c.field === "topic") body.topic = c.to === "" ? null : c.to;
          else if (c.field === "slowmode") body.rate_limit_per_user = c.to;
          else if (c.field === "parent") body.parent_id = this.optionalChannel(c.to);
          else body[c.field] = c.to;
        }
        await api.patch(`/channels/${this.channel(op.key)}`, body, reason);
        return;
      }
      case "channel.delete":
        await api.delete(`/channels/${this.channel(op.key)}`, reason);
        this.drop("channel", op.key);
        return;
      case "channel.order": {
        // As for roles: within each parent and bucket, permute the positions the channels hold.
        const live = await api.get<{ id: string; type: number; position: number }[]>(`${this.g}/channels`);
        const groups = new Map<string, string[]>();
        for (const item of op.items) {
          const id = this.channel(item.key);
          const c = live.find((x) => x.id === id);
          if (!c) continue;
          const g = `${item.parent ?? ""}/${bucketOf(c.type)}`;
          groups.set(g, [...(groups.get(g) ?? []), id]);
        }
        const body: { id: string; position: number }[] = [];
        for (const ids of groups.values()) {
          const slots = ids.map((id) => live.find((x) => x.id === id)!.position).sort((a, b) => a - b);
          ids.forEach((id, i) => body.push({ id, position: slots[i]! }));
        }
        if (body.length > 0) await api.patch(`${this.g}/channels`, body, reason);
        return;
      }
      case "overwrite.set":
        await api.put(
          `/channels/${this.channel(op.channel)}/permissions/${this.role(op.target)}`,
          { type: 0, allow: String(op.allow), deny: String(op.deny) },
          reason,
        );
        return;
      case "overwrite.delete": {
        const target = op.target.startsWith("member:") ? op.target.slice(7) : this.role(op.target);
        await api.delete(`/channels/${this.channel(op.channel)}/permissions/${target}`, reason);
        return;
      }
      case "guild.update": {
        const body: Record<string, unknown> = {};
        for (const c of op.changes) {
          switch (c.field) {
            case "verificationLevel":
              body.verification_level = VERIFICATION.indexOf(c.to as (typeof VERIFICATION)[number]);
              break;
            case "explicitContentFilter":
              body.explicit_content_filter = FILTER.indexOf(c.to as (typeof FILTER)[number]);
              break;
            case "defaultNotifications":
              body.default_message_notifications = NOTIFY.indexOf(c.to as (typeof NOTIFY)[number]);
              break;
            case "systemChannel":
              body.system_channel_id = this.optionalChannel(c.to);
              break;
            case "safetyAlertsChannel":
              body.safety_alerts_channel_id = this.optionalChannel(c.to);
              break;
            case "rulesChannel":
              body.rules_channel_id = this.optionalChannel(c.to);
              break;
            case "updatesChannel":
              body.public_updates_channel_id = this.optionalChannel(c.to);
              break;
            default:
              body[c.field] = c.to;
          }
        }
        await api.patch(this.g, body, reason);
        return;
      }
      case "asset.set": {
        const file = join(this.env.spec.dir, op.file);
        const mime = MIME[extname(file).toLowerCase()] ?? "image/png";
        const data = `data:${mime};base64,${readFileSync(file).toString("base64")}`;
        await api.patch(this.g, { [op.key]: data }, reason);
        this.put("asset", op.key, op.hash);
        return;
      }
      case "community": {
        const guild = await api.get<{ features: string[] }>(this.g);
        const others = guild.features.filter((f) => f !== "COMMUNITY");
        const community = this.env.spec.guild.community;
        if (op.enable && community) {
          await api.patch(
            this.g,
            { features: [...others, "COMMUNITY"], rules_channel_id: this.channel(community.rules), public_updates_channel_id: this.channel(community.updates) },
            reason,
          );
        } else {
          await api.patch(this.g, { features: others }, reason);
        }
        return;
      }
      case "automod.create": {
        const r = await api.post<{ id: string }>(`${this.g}/auto-moderation/rules`, { ...this.ruleBody(op.body), event_type: 1, trigger_type: 1 }, reason);
        this.put("automod", op.key, r.id);
        return;
      }
      case "automod.update":
        await api.patch(`${this.g}/auto-moderation/rules/${this.need("automod", op.key)}`, this.ruleBody(op.body), reason);
        return;
      case "automod.delete":
        await api.delete(`${this.g}/auto-moderation/rules/${this.need("automod", op.key)}`, reason);
        this.drop("automod", op.key);
        return;
      case "setting.set": {
        const value = this.settingValue(op.value);
        if (value === undefined) this.env.config.unset(this.env.guildId, op.key);
        else this.env.config.set(this.env.guildId, op.key, value);
        return;
      }
      case "post.create": {
        const channelId = this.channel(op.channel);
        const m = await api.post<{ id: string }>(`/channels/${channelId}/messages`, { content: op.content, allowed_mentions: { parse: [] } }, reason);
        this.put("post", `${op.key}#${op.index}`, `${channelId}/${m.id}`);
        return;
      }
      case "post.edit": {
        const [channelId, messageId] = this.need("post", `${op.key}#${op.index}`).split("/");
        await api.patch(`/channels/${channelId}/messages/${messageId}`, { content: op.content, allowed_mentions: { parse: [] } }, reason);
        return;
      }
      case "post.delete": {
        const [channelId, messageId] = this.need("post", `${op.key}#${op.index}`).split("/");
        try {
          await api.delete(`/channels/${channelId}/messages/${messageId}`, reason);
        } catch (error) {
          // Already gone by hand: the state row is all that's left to remove.
          if ((error as { status?: number }).status !== 404) throw error;
        }
        this.drop("post", `${op.key}#${op.index}`);
        return;
      }
    }
  }

  private ruleBody(b: AutoModBody): Record<string, unknown> {
    return {
      name: b.name,
      enabled: b.enabled,
      trigger_metadata: { keyword_filter: b.keywords, regex_patterns: b.regex, allow_list: b.allow },
      actions: b.actions.map((a) => {
        if (a.type === 1) return { type: 1, metadata: a.message === undefined ? {} : { custom_message: a.message } };
        if (a.type === 2) return { type: 2, metadata: { channel_id: this.channel(a.channel!) } };
        return { type: 3, metadata: { duration_seconds: a.seconds } };
      }),
      exempt_roles: b.exemptRoles.map((k) => this.role(k)),
      exempt_channels: b.exemptChannels.map((k) => this.channel(k)),
    };
  }

  private settingValue(v: SettingValue): unknown {
    if (v === null) return undefined;
    if (typeof v === "object" && !Array.isArray(v)) {
      if ("channel" in v) return this.channel(v.channel);
      if ("role" in v) return this.role(v.role);
      return v.roles.map((k) => this.role(k));
    }
    return v;
  }
}


