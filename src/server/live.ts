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
  forum: LiveForum | null; // forum and media channels only
}

export interface LiveForum {
  flags: number;
  tags: { id: string; name: string; emoji: string | null; moderated: boolean }[];
  reaction: string | null;
  sort: number | null;
  layout: number;
  threadSlowmode: number;
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

export interface RawOnboarding {
  enabled: boolean;
  mode: number;
  default_channel_ids: string[];
  prompts: {
    id: string;
    type: number;
    title: string;
    single_select: boolean;
    required: boolean;
    in_onboarding: boolean;
    options: {
      id: string;
      title: string;
      description: string | null;
      emoji?: { id: string | null; name: string | null; animated?: boolean } | null;
      emoji_name?: string | null;
      role_ids: string[];
      channel_ids: string[];
    }[];
  }[];
}

export interface Live {
  guild: LiveGuild;
  onboarding: RawOnboarding | null; // null where Discord won't show it
  roles: LiveRole[];
  channels: LiveChannel[];
  rules: LiveRule[];
  posts: Map<string, string | null>; // message id -> content; null when the message is gone
  embeds: Map<string, string | null>; // message id -> its first embed's text (a panel's)
  threads: Map<string, { name: string; flags: number } | null>; // forum posts' threads; null when gone
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
  flags?: number;
  available_tags?: { id: string; name: string; moderated?: boolean; emoji_id?: string | null; emoji_name?: string | null }[];
  default_reaction_emoji?: { emoji_id: string | null; emoji_name: string | null } | null;
  default_sort_order?: number | null;
  default_forum_layout?: number;
  default_thread_rate_limit_per_user?: number;
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
  threadIds: string[] = [],
): Promise<Live> {
  const [g, roles, channels, rules, me] = await Promise.all([
    api.get<RawGuild>(`/guilds/${guildId}`),
    api.get<RawRole[]>(`/guilds/${guildId}/roles`),
    api.get<RawChannel[]>(`/guilds/${guildId}/channels`),
    api.get<RawRule[]>(`/guilds/${guildId}/auto-moderation/rules`),
    api.get<{ id: string }>("/users/@me"),
  ]);
  const member = await api.get<{ roles: string[] }>(`/guilds/${guildId}/members/${me.id}`);
  let onboarding: RawOnboarding | null = null;
  try {
    onboarding = await api.get<RawOnboarding>(`/guilds/${guildId}/onboarding`);
  } catch (error) {
    const status = statusOf(error);
    if (status !== 403 && status !== 404) throw error;
  }

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
  const embeds = new Map<string, string | null>();
  for (const { channelId, messageId } of postIds) {
    try {
      const m = await api.get<{ content: string; embeds?: { description?: string }[] }>(`/channels/${channelId}/messages/${messageId}`);
      posts.set(messageId, m.content);
      embeds.set(messageId, m.embeds?.[0]?.description ?? null);
    } catch (error) {
      // 404: deleted by hand, or its channel is gone. Anything else is a real failure to report.
      if (statusOf(error) !== 404) throw error;
      posts.set(messageId, null);
    }
  }

  const threads = new Map<string, { name: string; flags: number } | null>();
  for (const id of threadIds) {
    try {
      const t = await api.get<{ name: string; flags?: number }>(`/channels/${id}`);
      threads.set(id, { name: t.name, flags: t.flags ?? 0 });
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      threads.set(id, null);
    }
  }

  return {
    onboarding,
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
      forum:
        c.type === 15 || c.type === 16
          ? {
              flags: c.flags ?? 0,
              tags: (c.available_tags ?? []).map((t) => ({ id: t.id, name: t.name, emoji: t.emoji_name ?? null, moderated: t.moderated ?? false })),
              reaction: c.default_reaction_emoji?.emoji_name ?? null,
              sort: c.default_sort_order ?? null,
              layout: c.default_forum_layout ?? 0,
              threadSlowmode: c.default_thread_rate_limit_per_user ?? 0,
            }
          : null,
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
    embeds,
    threads,
    botId: me.id,
    botTopPosition,
    botPermissions,
  };
}
