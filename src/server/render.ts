import { CHANNEL_TYPE, type Change, channelLabel, type Op, type Plan } from "./plan";
import { permissionDiff, prettyPermission, toNames } from "./permissions";
import { channelsFlat, type ServerSpec, type SettingValue } from "./spec";

// A plan as the owner reads it before pressing Apply: one line per change, grouped, with a "!"
// on anything that widens who can see or do something, or deletes.

const RESERVED: Record<string, string> = { everyone: "@everyone", bot: "the bot's role", booster: "Server Booster" };

const perms = (bits: bigint) => toNames(bits).map(prettyPermission).join(", ");

const FIELD: Record<string, string> = {
  verificationLevel: "verification level",
  explicitContentFilter: "explicit-content filter",
  defaultNotifications: "default notifications",
  systemChannel: "system channel",
  safetyAlertsChannel: "safety alerts channel",
  rulesChannel: "rules channel",
  updatesChannel: "community updates channel",
};

// One operation as a line of text, and the plan section it belongs in.
export function describer(spec: ServerSpec): (op: Op) => [string, string] {
  const roleName = (key: string) => RESERVED[key] ?? spec.roles.find((r) => r.key === key)?.name ?? key;
  const flat = channelsFlat(spec);
  const channel = (key: string | null): string => {
    if (key === null) return "top";
    const c = flat.find((f) => f.channel.key === key)?.channel;
    const retired = spec.retired?.find((r) => r.key === key);
    return c ? channelLabel(c.name, CHANNEL_TYPE[c.type]) : retired ? `#${retired.name}` : key;
  };
  const value = (v: unknown): string => {
    if (v === null || v === undefined) return "unset";
    if (typeof v === "string") return v;
    if (typeof v === "bigint") return perms(v) || "nothing";
    return JSON.stringify(v);
  };
  const quoted = (v: unknown) => (typeof v === "string" ? `"${v}"` : value(v));
  const setting = (v: SettingValue | unknown): string => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const ref = v as Record<string, unknown>;
      if (typeof ref.channel === "string") return channel(ref.channel);
      if (typeof ref.role === "string") return `role "${roleName(ref.role)}"`;
      if (Array.isArray(ref.roles)) return ref.roles.map((r) => `role "${roleName(String(r))}"`).join(", ") || "none";
    }
    return value(v);
  };
  const change = (c: Change): string => {
    if (c.field === "permissions") return `permissions ${permissionDiff(c.from as bigint, c.to as bigint)}`;
    if (c.field === "tags") {
      const tags = (v: unknown) =>
        (v as { name: string; emoji: string | null; moderated: boolean }[] | undefined ?? [])
          .map((t) => `${t.emoji ? `${t.emoji} ` : ""}${t.name}${t.moderated ? " (staff only)" : ""}`)
          .join(", ") || "none";
      return `tags ${tags(c.from)} -> ${tags(c.to)}`;
    }
    if (c.field === "parent") return `parent ${channel(c.from as string | null)} -> ${channel(c.to as string | null)}`;
    if (c.field.endsWith("Channel")) return `${FIELD[c.field]}: ${channel(c.from as string | null)} -> ${channel(c.to as string | null)}`;
    const label = FIELD[c.field] ?? c.field;
    if (FIELD[c.field]) return `${label}: ${value(c.from)} -> ${value(c.to)}`;
    return `${label} ${quoted(c.from)} -> ${quoted(c.to)}`;
  };
  const target = (t: string) => (t.startsWith("member:") ? `member ${t.slice(7)}` : roleName(t));
  const bits = (allow: bigint, deny: bigint) => {
    const parts = [];
    if (allow !== 0n) parts.push(`allow ${perms(allow)}`);
    if (deny !== 0n) parts.push(`deny ${perms(deny)}`);
    return parts.join("; ") || "empty overwrite";
  };

  return (op: Op): [string, string] => {
    switch (op.t) {
      case "bind":
        return ["Bindings", `bind ${op.label} -> ${op.key}${op.replaces !== undefined ? ` (was ${op.replaces})` : ""}`];
      case "role.create":
        return ["Roles", `+ role "${op.name}": ${perms(op.permissions) || "no permissions"}`];
      case "role.update":
        return ["Roles", `role "${roleName(op.key)}": ${op.changes.map(change).join(", ")}`];
      case "role.delete":
        return ["Roles", `- role "${op.name}"`];
      case "role.order":
        return ["Roles", `order: ${op.keys.map(roleName).join(", ")}`];
      case "role.grant":
        return ["Roles", `give @${roleName(op.key)} to every member now in the server, once`];
      case "channel.create": {
        const kind = Object.entries(CHANNEL_TYPE).find(([, t]) => t === op.type)?.[0] ?? "channel";
        const where = op.parent === null ? "top" : `in ${channel(op.parent)}`;
        const seen = op.visibleTo.length > 0 ? `, visible to ${op.visibleTo.map(roleName).join(", ")}` : "";
        return ["Channels", `+ ${channelLabel(op.name, op.type)} (${kind}, ${where})${seen}`];
      }
      case "channel.update":
        return ["Channels", `${channel(op.key)}: ${op.changes.map(change).join(", ")}`];
      case "channel.delete":
        return ["Channels", `- #${op.name}`];
      case "onboarding.set": {
        const b = op.body;
        const was = op.enabledBefore === b.enabled ? "" : ` (was ${op.enabledBefore ? "on" : "off"})`;
        const removes = op.removed.length > 0 ? `, removes ${op.removed.join(", ")}` : "";
        const head = `${b.enabled ? "on" : "off"}${was}, default channels ${b.defaultChannels.map(channel).join(", ") || "none"}${removes}`;
        const questions = b.prompts.map((p) => {
          const how = [p.inOnboarding ? "before joining" : "in Channels & Roles", ...(p.required ? ["required"] : []), ...(p.single ? ["one answer"] : [])].join(", ");
          const answers = p.options.map((o) => {
            const gives = [...o.roles.map((k) => `@${roleName(k)}`), ...o.channels.map(channel)];
            return gives.length > 0 ? `${o.title} (${gives.join(", ")})` : o.title;
          });
          return `"${p.title}", ${how}: ${answers.join(", ")}`;
        });
        return ["Onboarding", [head, ...questions].join("\n  ")];
      }
      case "channel.backup": {
        const files = op.files > 0 ? ` and ${op.files} file${op.files === 1 ? "" : "s"}` : "";
        return ["Channels", `${channel(op.key)}: copy ${op.messages} message${op.messages === 1 ? "" : "s"}${files} into ${channel(op.into)}`];
      }
      case "channel.order":
        return ["Channels", `order: ${op.items.map((i) => channel(i.key)).join(", ")}`];
      case "overwrite.set":
        return ["Permissions", `${channel(op.channel)}, ${target(op.target)}: ${bits(op.allow, op.deny)} (was ${op.before ? bits(op.before.allow, op.before.deny) : "no overwrite"})`];
      case "overwrite.delete":
        return ["Permissions", `${channel(op.channel)}, ${target(op.target)}: removed (was ${bits(op.before.allow, op.before.deny)})`];
      case "guild.update":
        return ["Server", op.changes.map(change).join(", ")];
      case "community":
        return ["Server", op.enable ? "turn Community on" : "turn Community off"];
      case "asset.set":
        return ["Server", `${op.key} from ${op.file}`];
      case "automod.create": {
        const b = op.body;
        const parts = [`${b.keywords.length} keyword${b.keywords.length === 1 ? "" : "s"}`, `${b.regex.length} regex${b.regex.length === 1 ? "" : "es"}`];
        for (const a of b.actions) parts.push(a.type === 1 ? "block" : a.type === 2 ? `alert ${channel(a.channel ?? null)}` : `timeout ${a.seconds}s`);
        return ["AutoMod", `+ AutoMod "${b.name}": ${parts.join(", ")}`];
      }
      case "automod.update":
        return ["AutoMod", `AutoMod "${op.body.name}": ${op.changes.map((c) => c.field).join(", ")} changed`];
      case "automod.delete":
        return ["AutoMod", `- AutoMod "${op.name}"`];
      case "setting.set":
        return ["Bot settings", `${op.key}: ${setting(op.before)} -> ${setting(op.value)}`];
      case "post.create": {
        const what = op.thread ? `forum post "${op.thread.title}"${op.thread.pin ? ", pinned" : ""}` : `${op.key}, part ${op.index + 1}`;
        const menu = op.components ? ", with its role menu" : "";
        return ["Posts", `+ ${what} (${op.content.length} characters) in ${channel(op.channel)}${menu}`];
      }
      case "post.edit":
        return ["Posts", `${op.key}, part ${op.index + 1}: edited (${op.content.length} characters)${op.components ? ", role menu updated" : op.clearMenu ? ", role menu removed" : ""}`];
      case "post.title":
        return ["Posts", `${op.key}: title "${op.title}"${op.pin ? ", pinned" : ", not pinned"}`];
      case "post.delete":
        return ["Posts", `- ${op.key}, part ${op.index + 1}`];
      case "prune":
        return ["Prune: not in the spec", `- ${op.label}`];
    }
  };
}

export const describeOp = (op: Op, spec: ServerSpec): string => describer(spec)(op)[1];

export function renderPlan(plan: Plan, spec: ServerSpec): string {
  const describe = describer(spec);
  const groups: [string, string[]][] = [
    ["Bindings", []],
    ["Roles", []],
    ["Channels", []],
    ["Permissions", []],
    ["Server", []],
    ["Onboarding", []],
    ["AutoMod", []],
    ["Bot settings", []],
    ["Posts", []],
    ["Prune: not in the spec", []],
  ];
  const put = (group: string, op: Op, line: string) => {
    const flagged = "flags" in op && op.flags.length > 0;
    groups.find(([g]) => g === group)![1].push(`  ${flagged ? "! " : ""}${line}`);
  };

  for (const op of plan.ops) {
    const [group, line] = describe(op);
    put(group, op, line);
  }
  const sections: [string, string[]][] = [
    ...groups,
    ["Held deletions (plan with deletions:true to apply them)", plan.held.map((op) => `  ${describe(op)[1]}`)],
    ["Manual steps", plan.manual.map((m) => `  ${m}`)],
    ["Unmanaged", plan.unmanaged.map((u) => `  ${u}`)],
  ];
  const out = sections.filter(([, lines]) => lines.length > 0).map(([title, lines]) => [title, ...lines].join("\n"));
  return out.length > 0 ? out.join("\n\n") : "No changes.";
}
