import type { DiscordApi } from "./api";
import { statusOf } from "./api";

// The live server as the planner sees it: Discord's objects, cut down to the fields a spec manages
// and with permissions as bigints.

export interface LiveRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
  position: number;
  managed: boolean;
  botId?: string;
  booster: boolean;
}

export interface LiveOverwrite {
  id: string;
  type: 0 | 1; // 0 role, 1 member
  allow: bigint;
  deny: bigint;
}

export interface LiveChannel {
  id: string;
  type: number;
  name: string;
  topic: string | null;
  slowmode: number;
  nsfw: boolean;
  parentId: string | null;
  position: number;
  overwrites: LiveOverwrite[];
}

export interface LiveAction {
  type: number; // 1 block, 2 alert, 3 timeout
  channelId?: string;
  message?: string;
  seconds?: number;
}

export interface LiveRule {
  id: string;
  name: string;
  enabled: boolean;
  triggerType: number;
  keywords: string[];
  regex: string[];
  allow: string[];
  actions: LiveAction[];
  exemptRoles: string[];
  exemptChannels: string[];
}

export interface LiveGuild {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  ownerId: string;
  verificationLevel: number;
  explicitContentFilter: number;
  defaultNotifications: number;
  systemChannelId: string | null;
  safetyAlertsChannelId: string | null;
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  features: string[];
  mfaLevel: number;
}

export interface Live {
  guild: LiveGuild;
  roles: LiveRole[];
  channels: LiveChannel[];
  rules: LiveRule[];
  posts: Map<string, string | null>; // message id -> content; null when the message is gone
  botId: string;
  botTopPosition: number;
  botPermissions: bigint; // @everyone's and the bot's roles', combined
}

interface RawRole {
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

interface RawChannel {
  id: string;
  type: number;
  name: string;
  topic?: string | null;
  rate_limit_per_user?: number;
  nsfw?: boolean;
  parent_id?: string | null;
  position: number;
  permission_overwrites?: { id: string; type: 0 | 1; allow: string; deny: string }[];
}

interface RawRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: number;
  trigger_metadata?: { keyword_filter?: string[]; regex_patterns?: string[]; allow_list?: string[] };
  actions: { type: number; metadata?: { channel_id?: string; custom_message?: string; duration_seconds?: number } }[];
  exempt_roles: string[];
  exempt_channels: string[];
}

interface RawGuild {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  owner_id: string;
  verification_level: number;
  explicit_content_filter: number;
  default_message_notifications: number;
  system_channel_id: string | null;
  safety_alerts_channel_id: string | null;
  rules_channel_id: string | null;
  public_updates_channel_id: string | null;
  features: string[];
  mfa_level: number;
}

export async function readLive(
  api: DiscordApi,
  guildId: string,
  postIds: { channelId: string; messageId: string }[],
): Promise<Live> {
  const [g, roles, channels, rules, me] = await Promise.all([
    api.get<RawGuild>(`/guilds/${guildId}`),
    api.get<RawRole[]>(`/guilds/${guildId}/roles`),
    api.get<RawChannel[]>(`/guilds/${guildId}/channels`),
    api.get<RawRule[]>(`/guilds/${guildId}/auto-moderation/rules`),
    api.get<{ id: string }>("/users/@me"),
  ]);
  const member = await api.get<{ roles: string[] }>(`/guilds/${guildId}/members/${me.id}`);

  const liveRoles: LiveRole[] = roles.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    mentionable: r.mentionable,
    permissions: BigInt(r.permissions),
    position: r.position,
    managed: r.managed,
    botId: r.tags?.bot_id,
    // Discord marks the booster role with a null-valued key, so test for the key, not the value.
    booster: r.tags !== undefined && "premium_subscriber" in r.tags,
  }));
  const botRoles = liveRoles.filter((r) => member.roles.includes(r.id));
  const botTopPosition = Math.max(0, ...botRoles.map((r) => r.position));
  const botPermissions = [...botRoles, ...liveRoles.filter((r) => r.id === guildId)].reduce((acc, r) => acc | r.permissions, 0n);

  const posts = new Map<string, string | null>();
  for (const { channelId, messageId } of postIds) {
    try {
      posts.set(messageId, (await api.get<{ content: string }>(`/channels/${channelId}/messages/${messageId}`)).content);
    } catch (error) {
      // 404: deleted by hand, or its channel is gone. Anything else is a real failure to report.
      if (statusOf(error) !== 404) throw error;
      posts.set(messageId, null);
    }
  }

  return {
    guild: {
      id: g.id,
      name: g.name,
      description: g.description,
      icon: g.icon,
      banner: g.banner,
      ownerId: g.owner_id,
      verificationLevel: g.verification_level,
      explicitContentFilter: g.explicit_content_filter,
      defaultNotifications: g.default_message_notifications,
      systemChannelId: g.system_channel_id,
      safetyAlertsChannelId: g.safety_alerts_channel_id,
      rulesChannelId: g.rules_channel_id,
      publicUpdatesChannelId: g.public_updates_channel_id,
      features: g.features,
      mfaLevel: g.mfa_level,
    },
    roles: liveRoles,
    channels: channels.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      topic: c.topic ?? null,
      slowmode: c.rate_limit_per_user ?? 0,
      nsfw: c.nsfw ?? false,
      parentId: c.parent_id ?? null,
      position: c.position,
      overwrites: (c.permission_overwrites ?? []).map((o) => ({
        id: o.id,
        type: o.type,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      })),
    })),
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      triggerType: r.trigger_type,
      keywords: r.trigger_metadata?.keyword_filter ?? [],
      regex: r.trigger_metadata?.regex_patterns ?? [],
      allow: r.trigger_metadata?.allow_list ?? [],
      actions: r.actions.map((a) => {
        const out: LiveAction = { type: a.type };
        if (a.metadata?.channel_id) out.channelId = a.metadata.channel_id;
        if (a.metadata?.custom_message) out.message = a.metadata.custom_message;
        if (a.metadata?.duration_seconds) out.seconds = a.metadata.duration_seconds;
        return out;
      }),
      exemptRoles: r.exempt_roles,
      exemptChannels: r.exempt_channels,
    })),
    posts,
    botId: me.id,
    botTopPosition,
    botPermissions,
  };
}
