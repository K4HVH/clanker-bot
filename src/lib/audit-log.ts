import { AuditLogEvent, EmbedBuilder, type GuildAuditLogsEntry } from "discord.js";
import { CONFIG_KEYS } from "./config";

export type LogToggle =
  | typeof CONFIG_KEYS.logModActions
  | typeof CONFIG_KEYS.logMemberEvents
  | typeof CONFIG_KEYS.logServerEvents;

export interface AuditLogPlan {
  destination: "mod" | "member";
  toggle: LogToggle;
  embed: EmbedBuilder;
  // A kick/ban target: lets the plain "left" line skip them (the attributed action is logged).
  removedMemberId?: string;
}

const CHANNEL_ACTIONS = new Set<AuditLogEvent>([
  AuditLogEvent.ChannelCreate,
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.ChannelUpdate,
]);
const ROLE_ACTIONS = new Set<AuditLogEvent>([
  AuditLogEvent.RoleCreate,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.RoleUpdate,
]);

interface Info {
  title: string;
  color: number;
  destination: "mod" | "member";
  toggle: LogToggle;
  removesMember?: boolean;
}

// Straightforward audit actions that need no change-inspection.
const ACTIONS: Partial<Record<AuditLogEvent, Info>> = {
  [AuditLogEvent.MemberBanAdd]: { title: "Member banned", color: 0x992d22, destination: "mod", toggle: CONFIG_KEYS.logModActions, removesMember: true },
  [AuditLogEvent.MemberBanRemove]: { title: "Member unbanned", color: 0x2ecc71, destination: "mod", toggle: CONFIG_KEYS.logModActions },
  [AuditLogEvent.MemberKick]: { title: "Member kicked", color: 0xe74c3c, destination: "mod", toggle: CONFIG_KEYS.logModActions, removesMember: true },
  [AuditLogEvent.ChannelCreate]: { title: "Channel created", color: 0x2ecc71, destination: "member", toggle: CONFIG_KEYS.logServerEvents },
  [AuditLogEvent.ChannelDelete]: { title: "Channel deleted", color: 0xe74c3c, destination: "member", toggle: CONFIG_KEYS.logServerEvents },
  [AuditLogEvent.ChannelUpdate]: { title: "Channel updated", color: 0xf1c40f, destination: "member", toggle: CONFIG_KEYS.logServerEvents },
  [AuditLogEvent.RoleCreate]: { title: "Role created", color: 0x2ecc71, destination: "member", toggle: CONFIG_KEYS.logServerEvents },
  [AuditLogEvent.RoleDelete]: { title: "Role deleted", color: 0xe74c3c, destination: "member", toggle: CONFIG_KEYS.logServerEvents },
  [AuditLogEvent.RoleUpdate]: { title: "Role updated", color: 0xf1c40f, destination: "member", toggle: CONFIG_KEYS.logServerEvents },
};

// The user id removed by a ban/kick (regardless of who did it), else null, used to suppress
// the duplicate "Member left" line for a member the bot or a mod just removed.
export function removalTargetId(entry: GuildAuditLogsEntry): string | null {
  if (entry.action === AuditLogEvent.MemberKick || entry.action === AuditLogEvent.MemberBanAdd) {
    return entry.targetId ?? null;
  }
  return null;
}

// A deleted channel/role can't be resolved by a mention (it renders as "#unknown"), so for a
// delete show the captured name + id; for create/update the entity still exists, so mention it.
function capturedName(entry: GuildAuditLogsEntry): string | undefined {
  const fromTarget = (entry.target as { name?: string } | null)?.name;
  if (fromTarget) return fromTarget;
  const change = entry.changes.find((c) => c.key === "name");
  return (change?.old ?? change?.new) as string | undefined;
}

function targetField(entry: GuildAuditLogsEntry): { name: string; value: string } | null {
  const id = entry.targetId;
  if (!id) return null;
  if (CHANNEL_ACTIONS.has(entry.action)) {
    const value =
      entry.action === AuditLogEvent.ChannelDelete
        ? `\`#${capturedName(entry) ?? "unknown"}\` (${id})`
        : `<#${id}>`;
    return { name: "Channel", value };
  }
  if (ROLE_ACTIONS.has(entry.action)) {
    const value =
      entry.action === AuditLogEvent.RoleDelete
        ? `\`@${capturedName(entry) ?? "unknown"}\` (${id})`
        : `<@&${id}>`;
    return { name: "Role", value };
  }
  return { name: "User", value: `<@${id}> (${id})` };
}

function baseEmbed(title: string, color: number, entry: GuildAuditLogsEntry): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp(new Date());
  const target = targetField(entry);
  if (target) embed.addFields(target);
  if (entry.executorId) embed.addFields({ name: "By", value: `<@${entry.executorId}>` });
  if (entry.reason) embed.addFields({ name: "Reason", value: entry.reason.slice(0, 1024) });
  return embed;
}

function roleMentions(entry: GuildAuditLogsEntry, key: "$add" | "$remove"): string[] {
  const change = entry.changes.find((c) => c.key === key);
  const list = (change?.new ?? []) as Array<{ id: string }>;
  return list.map((r) => `<@&${r.id}>`);
}

// Turn an audit-log entry into a log plan, or null to ignore it. The bot's OWN actions are
// dropped: they're already logged as cases (/mod) or are routine (a verification role grant,
// a ticket channel). So this only surfaces things done by a human outside the bot.
export function planAuditEntry(entry: GuildAuditLogsEntry, botId: string): AuditLogPlan | null {
  if (entry.executorId === botId) return null;

  // Timeouts arrive as a MemberUpdate touching communication_disabled_until. Treat a null OR
  // already-past timestamp as "removed" (some clients clear a timeout by writing the past).
  if (entry.action === AuditLogEvent.MemberUpdate) {
    const change = entry.changes.find((c) => c.key === "communication_disabled_until");
    if (!change) return null; // some other member edit (e.g. deafen): not ours to log
    const untilRaw = (change.new as string | undefined) ?? null;
    const untilMs = untilRaw ? new Date(untilRaw).getTime() : 0;
    const active = untilMs > Date.now();
    const embed = baseEmbed(active ? "Member timed out" : "Timeout removed", active ? 0xe67e22 : 0x2ecc71, entry);
    if (active) embed.addFields({ name: "Until", value: `<t:${Math.floor(untilMs / 1000)}:R>` });
    return { destination: "mod", toggle: CONFIG_KEYS.logModActions, embed };
  }

  // Role grants/removes on a member.
  if (entry.action === AuditLogEvent.MemberRoleUpdate) {
    const added = roleMentions(entry, "$add");
    const removed = roleMentions(entry, "$remove");
    if (!added.length && !removed.length) return null;
    const embed = baseEmbed("Member roles updated", 0x3498db, entry);
    if (added.length) embed.addFields({ name: "Added", value: added.join(", ") });
    if (removed.length) embed.addFields({ name: "Removed", value: removed.join(", ") });
    return { destination: "member", toggle: CONFIG_KEYS.logMemberEvents, embed };
  }

  const info = ACTIONS[entry.action];
  if (!info) return null;
  return {
    destination: info.destination,
    toggle: info.toggle,
    embed: baseEmbed(info.title, info.color, entry),
    removedMemberId: info.removesMember ? (entry.targetId ?? undefined) : undefined,
  };
}
