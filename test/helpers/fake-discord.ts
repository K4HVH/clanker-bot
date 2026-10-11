import type { DiscordApi } from "../../src/server/api";
import type { RawOnboarding } from "../../src/server/live";

// An in-memory guild behind DiscordApi, holding raw API objects in Discord's own field names, so
// the snapshot reader and the executor are tested against the shapes the real API returns. Every
// write is recorded; refuse() makes chosen writes fail the way Discord refuses an edit.

export interface RawRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
  position: number;
  managed: boolean;
  tags?: { bot_id?: string; premium_subscriber?: null };
}

export interface RawOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface RawChannel {
  id: string;
  type: number;
  name: string;
  topic?: string | null;
  rate_limit_per_user?: number;
  nsfw?: boolean;
  parent_id: string | null;
  position: number;
  permission_overwrites: RawOverwrite[];
  flags?: number;
  available_tags?: { id: string; name: string; moderated: boolean; emoji_id: string | null; emoji_name: string | null }[];
  default_reaction_emoji?: { emoji_id: string | null; emoji_name: string | null } | null;
  default_sort_order?: number | null;
  default_forum_layout?: number;
  default_thread_rate_limit_per_user?: number;
}

export interface RawRule {
  id: string;
  name: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata: {
    keyword_filter?: string[];
    regex_patterns?: string[];
    allow_list?: string[];
    mention_total_limit?: number;
    mention_raid_protection_enabled?: boolean;
  };
  actions: { type: number; metadata?: { channel_id?: string; custom_message?: string; duration_seconds?: number } }[];
  enabled: boolean;
  exempt_roles: string[];
  exempt_channels: string[];
}

export interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username?: string; global_name?: string | null };
  components?: unknown[];
  type?: number;
  timestamp?: string;
  flags?: number;
  attachments?: { filename: string; url: string; size: number }[];
  embeds?: Record<string, unknown>[];
}

export interface Write {
  method: string;
  route: string;
  body?: unknown;
  reason?: string;
  files?: { name: string; data: Uint8Array }[];
}

export class FakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number, // Discord's JSON error code, as DiscordAPIError carries it
  ) {
    super(message);
  }
}

type Body = Record<string, unknown>;

export class FakeDiscord implements DiscordApi {
  readonly guildId: string;
  readonly botId = "900";
  readonly ownerId = "800";
  guild: Body;
  roles: RawRole[] = [];
  channels: RawChannel[] = [];
  rules: RawRule[] = [];
  messages: RawMessage[] = [];
  onboarding: RawOnboarding = { enabled: false, mode: 0, default_channel_ids: [], prompts: [] };
  botRoles: string[] = [];
  members: { user: { id: string; bot?: boolean }; roles: string[] }[] = [];
  onCommunity?: () => void; // what Discord does itself when Community comes on
  invites: { code: string; channel: { id: string }; uses: number; max_age: number }[] = [];
  writes: Write[] = [];
  private next = 1000;
  private refusals: { when: (w: Write) => boolean; status: number; code?: number; message?: string }[] = [];

  constructor(guildId = "1") {
    this.guildId = guildId;
    this.guild = {
      id: guildId,
      name: "Test",
      description: null,
      icon: null,
      banner: null,
      owner_id: this.ownerId,
      verification_level: 0,
      explicit_content_filter: 0,
      default_message_notifications: 0,
      system_channel_id: null,
      safety_alerts_channel_id: null,
      rules_channel_id: null,
      public_updates_channel_id: null,
      features: [],
      mfa_level: 0,
    };
    this.roles.push({ id: guildId, name: "@everyone", color: 0, hoist: false, mentionable: false, permissions: "0", position: 0, managed: false });
    // The bot holds Administrator, as a server built from a spec needs it to.
    const botRole = this.addRole({ name: "Bot", managed: true, tags: { bot_id: this.botId }, position: 50, permissions: "8" });
    this.botRoles = [botRole.id];
  }

  id(): string {
    return String(this.next++);
  }

  addRole(r: Partial<RawRole> & { name: string }): RawRole {
    const role: RawRole = { id: this.id(), color: 0, hoist: false, mentionable: false, permissions: "0", position: 1, managed: false, ...r };
    this.roles.push(role);
    return role;
  }

  addChannel(c: Partial<RawChannel> & { name: string }): RawChannel {
    const channel: RawChannel = { id: this.id(), type: 0, topic: null, rate_limit_per_user: 0, nsfw: false, parent_id: null, position: this.channels.length, permission_overwrites: [], ...c };
    this.channels.push(channel);
    return channel;
  }

  addRule(r: Partial<RawRule> & { name: string }): RawRule {
    const rule: RawRule = { id: this.id(), event_type: 1, trigger_type: 1, trigger_metadata: {}, actions: [], enabled: true, exempt_roles: [], exempt_channels: [], ...r };
    this.rules.push(rule);
    return rule;
  }

  addMessage(channelId: string, content: string, authorId = this.botId, extra: Partial<RawMessage> = {}): RawMessage {
    const m: RawMessage = { id: this.id(), channel_id: channelId, content, author: { id: authorId }, type: 0, timestamp: new Date(0).toISOString(), ...extra };
    this.messages.push(m);
    return m;
  }

  refuse(when: (w: Write) => boolean, status = 403, code?: number, message?: string): void {
    this.refusals.push({ when, status, code, message });
  }

  allowAll(): void {
    this.refusals = [];
  }

  private record(w: Write): void {
    const refusal = this.refusals.find((r) => r.when(w));
    if (refusal) throw new FakeError(refusal.message ?? `refused ${w.method} ${w.route}`, refusal.status, refusal.code);
    this.writes.push(w);
  }

  // Forum fields as Discord stores them: a tag sent without an id gets one; one with an id keeps it.
  private forumFields(b: Body): Partial<RawChannel> {
    const tags = b.available_tags as { id?: string; name: string; moderated?: boolean; emoji_name?: string | null }[] | undefined;
    const out: Partial<RawChannel> = {};
    if (tags) {
      out.available_tags = tags.map((t) => ({
        id: t.id ?? this.id(),
        name: t.name,
        moderated: t.moderated ?? false,
        emoji_id: null,
        emoji_name: t.emoji_name ?? null,
      }));
    }
    for (const k of ["flags", "default_reaction_emoji", "default_sort_order", "default_forum_layout", "default_thread_rate_limit_per_user"] as const) {
      if (b[k] !== undefined) (out as Record<string, unknown>)[k] = b[k];
    }
    return out;
  }

  private role(id: string): RawRole {
    const r = this.roles.find((x) => x.id === id);
    if (!r) throw new FakeError(`no role ${id}`, 404);
    return r;
  }

  private channel(id: string): RawChannel {
    const c = this.channels.find((x) => x.id === id);
    if (!c) throw new FakeError(`no channel ${id}`, 404);
    return c;
  }

  async get<T>(route: `/${string}`): Promise<T> {
    const g = `/guilds/${this.guildId}`;
    let m: RegExpMatchArray | null;
    if (route === g) return structuredClone(this.guild) as T;
    if (route === `${g}/roles`) return structuredClone(this.roles) as T;
    if (route === `${g}/channels`) return structuredClone(this.channels) as T;
    if (route === `${g}/auto-moderation/rules`) return structuredClone(this.rules) as T;
    if (route === "/users/@me") return { id: this.botId } as T;
    if ((m = route.match(/^\/guilds\/\d+\/members\?(.*)$/))) {
      const q = new URLSearchParams(m[1]);
      const after = BigInt(q.get("after") ?? "0");
      const list = this.members.filter((x) => BigInt(x.user.id) > after).sort((a, b) => (BigInt(a.user.id) < BigInt(b.user.id) ? -1 : 1));
      return structuredClone(list.slice(0, Number(q.get("limit") ?? "1"))) as T;
    }
    if ((m = route.match(/^\/guilds\/\d+\/members\/(\d+)$/))) {
      if (m[1] !== this.botId) throw new FakeError("unknown member", 404);
      return { user: { id: this.botId }, roles: [...this.botRoles] } as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const msg = this.messages.find((x) => x.channel_id === m![1] && x.id === m![2]);
      if (!msg) throw new FakeError("unknown message", 404);
      return structuredClone(msg) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)$/))) return structuredClone(this.channel(m[1]!)) as T;
    if ((m = route.match(/^\/channels\/(\d+)\/messages(\?.*)?$/))) {
      // As Discord does: the `limit` messages just after `after`, newest first.
      const q = new URLSearchParams(m[2]?.slice(1) ?? "");
      const after = BigInt(q.get("after") ?? "0");
      const page = this.messages
        .filter((x) => x.channel_id === m![1] && BigInt(x.id) > after)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .slice(0, Number(q.get("limit") ?? "50"));
      return structuredClone(page.reverse()) as T;
    }
    if (route === `/guilds/${this.guildId}/onboarding`) return structuredClone(this.onboarding) as T;
    if (route === `/guilds/${this.guildId}/invites`) return structuredClone(this.invites) as T;
    if (route === `/guilds/${this.guildId}/threads/active`) {
      return { threads: structuredClone(this.channels.filter((c) => c.type === 11 || c.type === 12)) } as T;
    }
    if (/^\/channels\/\d+\/threads\/archived\/(public|private)$/.test(route)) return { threads: [] } as T;
    throw new Error(`fake: no route GET ${route}`);
  }

  async post<T>(route: `/${string}`, body: unknown, reason?: string, files?: { name: string; data: Uint8Array }[]): Promise<T> {
    this.record({ method: "POST", route, body, reason, ...(files ? { files } : {}) });
    const b = body as Body;
    const g = `/guilds/${this.guildId}`;
    let m: RegExpMatchArray | null;
    if (route === `${g}/roles`) {
      for (const r of this.roles) if (r.position >= 1) r.position += 1;
      return structuredClone(
        this.addRole({
          name: String(b.name),
          color: Number(b.color ?? 0),
          hoist: Boolean(b.hoist),
          mentionable: Boolean(b.mentionable),
          permissions: String(b.permissions ?? "0"),
          position: 1,
        }),
      ) as T;
    }
    if (route === `${g}/channels`) {
      // Announcement and stage channels exist only on Community servers.
      if ([5, 13, 15, 16].includes(Number(b.type)) && !(this.guild.features as string[]).includes("COMMUNITY")) {
        throw new FakeError("announcement and stage channels need Community", 400);
      }
      const parent = (b.parent_id as string | undefined) ?? null;
      const siblings = this.channels.filter((c) => c.parent_id === parent);
      return structuredClone(
        this.addChannel({
          name: String(b.name),
          type: Number(b.type ?? 0),
          topic: (b.topic as string | undefined) ?? null,
          rate_limit_per_user: Number(b.rate_limit_per_user ?? 0),
          nsfw: Boolean(b.nsfw),
          parent_id: parent,
          position: siblings.length,
          permission_overwrites: ((b.permission_overwrites as RawOverwrite[] | undefined) ?? []).map((o) => ({ ...o })),
          // Discord drops `flags` on create (seen on a real server, 2026-10-11): only a modify sets them.
          ...this.forumFields({ ...b, flags: undefined }),
        }),
      ) as T;
    }
    if (route === `${g}/auto-moderation/rules`) {
      const trigger = Number(b.trigger_type);
      if ((trigger === 3 || trigger === 5) && this.rules.some((r) => r.trigger_type === trigger)) {
        throw new FakeError("Maximum number of rules of this type reached", 400, 50035);
      }
      return structuredClone(this.addRule(b as unknown as RawRule)) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages$/))) {
      this.channel(m[1]!);
      const msg = this.addMessage(m[1]!, String(b.content ?? ""));
      if (b.components) msg.components = b.components as unknown[];
      if (b.flags) msg.flags = Number(b.flags);
      if (b.embeds) msg.embeds = b.embeds as Record<string, unknown>[];
      if (files) msg.attachments = files.map((x, i) => ({ filename: x.name, size: x.data.length, url: `https://cdn.example/${msg.id}/${i}` }));
      return structuredClone(msg) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/threads$/))) {
      const forum = this.channel(m[1]!);
      const thread = this.addChannel({ name: String(b.name), type: 11, parent_id: forum.id });
      const first = b.message as { content: string; components?: unknown[] };
      // A forum thread's first message has the thread's id.
      const msg: RawMessage = { id: thread.id, channel_id: thread.id, content: first.content, author: { id: this.botId }, ...(first.components ? { components: first.components } : {}) };
      this.messages.push(msg);
      return structuredClone({ ...thread, message: msg }) as T;
    }
    throw new Error(`fake: no route POST ${route}`);
  }

  async patch<T>(route: `/${string}`, body: unknown, reason?: string): Promise<T> {
    this.record({ method: "PATCH", route, body, reason });
    const g = `/guilds/${this.guildId}`;
    let m: RegExpMatchArray | null;
    if (route === g) {
      const b = body as Body;
      const features = b.features as string[] | undefined;
      const turningOn = features?.includes("COMMUNITY") && !(this.guild.features as string[]).includes("COMMUNITY");
      if (turningOn) {
        const merged = { ...this.guild, ...b };
        if (merged.explicit_content_filter !== 2 || Number(merged.verification_level) < 1 || !merged.rules_channel_id || !merged.public_updates_channel_id) {
          throw new FakeError("community requirements not met", 400);
        }
      }
      // Discord ignores a new rules or updates channel unless the feature list comes with it.
      const { rules_channel_id, public_updates_channel_id, ...rest } = b;
      Object.assign(this.guild, features ? b : rest);
      if (turningOn) this.onCommunity?.();
      return structuredClone(this.guild) as T;
    }
    if (route === `${g}/roles`) {
      for (const { id, position } of body as { id: string; position: number }[]) this.role(id).position = position;
      return structuredClone(this.roles) as T;
    }
    if (route === `${g}/channels`) {
      for (const p of body as { id: string; position: number; parent_id?: string | null }[]) {
        const c = this.channel(p.id);
        c.position = p.position;
        if (p.parent_id !== undefined) c.parent_id = p.parent_id;
      }
      return undefined as T;
    }
    if ((m = route.match(/^\/guilds\/\d+\/roles\/(\d+)$/))) {
      return structuredClone(Object.assign(this.role(m[1]!), body)) as T;
    }
    if ((m = route.match(/^\/guilds\/\d+\/auto-moderation\/rules\/(\d+)$/))) {
      const rule = this.rules.find((r) => r.id === m![1]);
      if (!rule) throw new FakeError("unknown rule", 404);
      return structuredClone(Object.assign(rule, body)) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const msg = this.messages.find((x) => x.channel_id === m![1] && x.id === m![2]);
      if (!msg) throw new FakeError("unknown message", 404);
      const b = body as Body;
      msg.content = String(b.content);
      if (b.components !== undefined) msg.components = b.components as unknown[];
      if (b.embeds !== undefined) msg.embeds = b.embeds as Record<string, unknown>[];
      return structuredClone(msg) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)$/))) {
      const c = this.channel(m[1]!);
      const b = body as Body;
      if (b.type !== undefined && b.type !== c.type) {
        const pair = (c.type === 0 && b.type === 5) || (c.type === 5 && b.type === 0);
        if (!pair) throw new FakeError("only text and announcement convert", 400, 50024);
        if (!(this.guild.features as string[]).includes("COMMUNITY")) throw new FakeError("announcement channels need Community", 400);
      }
      const { available_tags, ...rest } = b;
      Object.assign(c, rest, this.forumFields({ available_tags }));
      return structuredClone(c) as T;
    }
    throw new Error(`fake: no route PATCH ${route}`);
  }

  async put(route: `/${string}`, body: unknown, reason?: string): Promise<void> {
    this.record({ method: "PUT", route, body, reason });
    const given = route.match(/^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/);
    if (given) {
      const member = this.members.find((x) => x.user.id === given[1]);
      if (!member) throw new FakeError("unknown member", 404);
      if (!member.roles.includes(given[2]!)) member.roles.push(given[2]!);
      return;
    }
    if (route === `/guilds/${this.guildId}/onboarding`) {
      const b = body as RawOnboarding;
      if (b.enabled && !(this.guild.features as string[]).includes("COMMUNITY")) throw new FakeError("onboarding needs Community", 400);
      // As Discord does: an id it doesn't know is a new prompt or option, which gets one of its own.
      const known = new Set(this.onboarding.prompts.flatMap((p) => [p.id, ...p.options.map((o) => o.id)]));
      const id = (x: string) => (known.has(x) ? x : this.id());
      this.onboarding = {
        enabled: b.enabled,
        mode: b.mode,
        default_channel_ids: b.default_channel_ids,
        // GET gives an option's emoji as an object, whatever the PUT sent.
        prompts: b.prompts.map((p) => ({
          ...p,
          id: id(p.id),
          options: p.options.map((o) => {
            const sent = o as typeof o & { emoji_id?: string | null; emoji_animated?: boolean };
            const { emoji_name, emoji_id, emoji_animated, ...rest } = sent;
            return { ...rest, id: id(o.id), emoji: { id: emoji_id ?? null, name: emoji_name ?? null, animated: emoji_animated ?? false } };
          }),
        })),
      };
      return;
    }
    const m = route.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/);
    if (!m) throw new Error(`fake: no route PUT ${route}`);
    const b = body as { type: 0 | 1; allow: string; deny: string };
    this.editOverwrites(this.channel(m[1]!), (list) => [...list.filter((o) => o.id !== m[2]), { id: m[2]!, type: b.type, allow: b.allow, deny: b.deny }]);
  }

  // As Discord does: an edit to a category's overwrites is copied onto each child whose overwrites
  // matched the category's.
  editOverwrites(c: RawChannel, edit: (list: RawChannel["permission_overwrites"]) => RawChannel["permission_overwrites"]): void {
    const key = (list: RawChannel["permission_overwrites"]) => JSON.stringify([...list].map((o) => `${o.id}:${o.type}:${o.allow}:${o.deny}`).sort());
    const synced = c.type === 4 ? this.channels.filter((x) => x.parent_id === c.id && key(x.permission_overwrites) === key(c.permission_overwrites)) : [];
    for (const x of [c, ...synced]) x.permission_overwrites = edit(x.permission_overwrites);
  }

  async delete(route: `/${string}`, reason?: string): Promise<void> {
    this.record({ method: "DELETE", route, reason });
    let m: RegExpMatchArray | null;
    if ((m = route.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/))) {
      this.editOverwrites(this.channel(m[1]!), (list) => list.filter((o) => o.id !== m![2]));
      return;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      this.messages = this.messages.filter((x) => !(x.channel_id === m![1] && x.id === m![2]));
      return;
    }
    if ((m = route.match(/^\/channels\/(\d+)$/))) {
      this.channel(m[1]!);
      this.channels = this.channels.filter((c) => c.id !== m![1]);
      return;
    }
    if ((m = route.match(/^\/guilds\/\d+\/roles\/(\d+)$/))) {
      this.role(m[1]!);
      this.roles = this.roles.filter((r) => r.id !== m![1]);
      return;
    }
    if ((m = route.match(/^\/guilds\/\d+\/auto-moderation\/rules\/(\d+)$/))) {
      this.rules = this.rules.filter((r) => r.id !== m![1]);
      return;
    }
    throw new Error(`fake: no route DELETE ${route}`);
  }
}
