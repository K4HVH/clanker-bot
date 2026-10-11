import type { DiscordApi } from "../../src/server/api";

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
}

export interface RawRule {
  id: string;
  name: string;
  event_type: number;
  trigger_type: number;
  trigger_metadata: { keyword_filter?: string[]; regex_patterns?: string[]; allow_list?: string[] };
  actions: { type: number; metadata?: { channel_id?: string; custom_message?: string; duration_seconds?: number } }[];
  enabled: boolean;
  exempt_roles: string[];
  exempt_channels: string[];
}

export interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string };
}

export interface Write {
  method: string;
  route: string;
  body?: unknown;
  reason?: string;
}

export class FakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
  botRoles: string[] = [];
  writes: Write[] = [];
  private next = 1000;
  private refusals: { when: (w: Write) => boolean; status: number }[] = [];

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
    const botRole = this.addRole({ name: "Bot", managed: true, tags: { bot_id: this.botId }, position: 50 });
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

  addMessage(channelId: string, content: string, authorId = this.botId): RawMessage {
    const m: RawMessage = { id: this.id(), channel_id: channelId, content, author: { id: authorId } };
    this.messages.push(m);
    return m;
  }

  refuse(when: (w: Write) => boolean, status = 403): void {
    this.refusals.push({ when, status });
  }

  allowAll(): void {
    this.refusals = [];
  }

  private record(w: Write): void {
    const refusal = this.refusals.find((r) => r.when(w));
    if (refusal) throw new FakeError(`refused ${w.method} ${w.route}`, refusal.status);
    this.writes.push(w);
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
    if ((m = route.match(/^\/guilds\/\d+\/members\/(\d+)$/))) {
      if (m[1] !== this.botId) throw new FakeError("unknown member", 404);
      return { user: { id: this.botId }, roles: [...this.botRoles] } as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const msg = this.messages.find((x) => x.channel_id === m![1] && x.id === m![2]);
      if (!msg) throw new FakeError("unknown message", 404);
      return structuredClone(msg) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages(\?.*)?$/))) {
      return structuredClone(this.messages.filter((x) => x.channel_id === m![1]).reverse()) as T;
    }
    throw new Error(`fake: no route GET ${route}`);
  }

  async post<T>(route: `/${string}`, body: unknown, reason?: string): Promise<T> {
    this.record({ method: "POST", route, body, reason });
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
        }),
      ) as T;
    }
    if (route === `${g}/auto-moderation/rules`) {
      return structuredClone(this.addRule(b as unknown as RawRule)) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)\/messages$/))) {
      this.channel(m[1]!);
      return structuredClone(this.addMessage(m[1]!, String(b.content))) as T;
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
      if (features?.includes("COMMUNITY") && !(this.guild.features as string[]).includes("COMMUNITY")) {
        const merged = { ...this.guild, ...b };
        if (merged.explicit_content_filter !== 2 || Number(merged.verification_level) < 1 || !merged.rules_channel_id || !merged.public_updates_channel_id) {
          throw new FakeError("community requirements not met", 400);
        }
      }
      Object.assign(this.guild, b);
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
      msg.content = String((body as Body).content);
      return structuredClone(msg) as T;
    }
    if ((m = route.match(/^\/channels\/(\d+)$/))) {
      return structuredClone(Object.assign(this.channel(m[1]!), body)) as T;
    }
    throw new Error(`fake: no route PATCH ${route}`);
  }

  async put(route: `/${string}`, body: unknown, reason?: string): Promise<void> {
    this.record({ method: "PUT", route, body, reason });
    const m = route.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/);
    if (!m) throw new Error(`fake: no route PUT ${route}`);
    const c = this.channel(m[1]!);
    const b = body as { type: 0 | 1; allow: string; deny: string };
    c.permission_overwrites = c.permission_overwrites.filter((o) => o.id !== m[2]);
    c.permission_overwrites.push({ id: m[2]!, type: b.type, allow: b.allow, deny: b.deny });
  }

  async delete(route: `/${string}`, reason?: string): Promise<void> {
    this.record({ method: "DELETE", route, reason });
    let m: RegExpMatchArray | null;
    if ((m = route.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/))) {
      const c = this.channel(m[1]!);
      c.permission_overwrites = c.permission_overwrites.filter((o) => o.id !== m![2]);
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
