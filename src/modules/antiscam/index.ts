import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  type GuildMember,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler, Listener } from "../../core/module";
import { createCase } from "../../db/cases";
import {
  bumpSignatureHit,
  evictOldest,
  loadSignatures,
  removeSignature,
  type SignatureKind,
  upsertSignature,
} from "../../db/scam-signature";
import { getTicketByChannel } from "../../db/tickets";
import { extractHostnames } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { onHoneypotHit } from "../../lib/honeypot-events";
import { inHoneypotChannel } from "../../lib/honeypot";
import { SprayTracker } from "../../lib/heat";
import { suppressDeletion, suppressedDeletions } from "../../lib/log-suppress";
import { applyModAction } from "../../lib/mod-action";
import { logModAlert } from "../../lib/modlog";
import { attachmentTriple, isSeedableDomain, parseDomainList } from "../../lib/scam-seed";

const DAY_MS = 86_400_000;

// ── Signature cache ──────────────────────────────────────────────────────────
// Loaded per guild and reused for CACHE_TTL so the hot path is a Set lookup, not a query per
// message. Invalidated immediately on a write so a moderator's correction takes effect at once.
const CACHE_TTL = 60_000;
const sigCache = new Map<string, { sets: ReturnType<typeof loadSignatures>; at: number }>();

function signatures(ctx: AppContext, guildId: string, now: number) {
  const cached = sigCache.get(guildId);
  if (cached && now - cached.at < CACHE_TTL) return cached.sets;
  const sets = loadSignatures(ctx.db, guildId, now);
  sigCache.set(guildId, { sets, at: now });
  return sets;
}

function invalidate(guildId: string): void {
  sigCache.delete(guildId);
}

// ── Config readers (fail safe to "off") ──────────────────────────────────────
function blocklistActionOf(ctx: AppContext, guildId: string): "off" | "flag" | "delete" | "ban" {
  const v = ctx.config.getEffective<string>(guildId, CONFIG_KEYS.antiscamBlocklistAction);
  return v === "flag" || v === "delete" || v === "ban" ? v : "off";
}

function sprayActionOf(ctx: AppContext, guildId: string): "off" | "flag" | "timeout" | "kick" | "ban" {
  const v = ctx.config.getEffective<string>(guildId, CONFIG_KEYS.antiscamSprayAction);
  return v === "flag" || v === "timeout" || v === "kick" || v === "ban" ? v : "off";
}

// ── Shared helpers ───────────────────────────────────────────────────────────
function embedTextsOf(message: Message): string[] {
  const out: string[] = [];
  for (const e of message.embeds) {
    if (e.url) out.push(e.url);
    if (e.title) out.push(e.title);
    if (e.description) out.push(e.description);
    if (e.author?.url) out.push(e.author.url);
    if (e.footer?.text) out.push(e.footer.text);
    for (const f of e.fields) out.push(f.value);
  }
  return out;
}

async function sha256Of(url: string, maxBytes: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(buf);
    return hasher.digest("hex");
  } catch {
    return null;
  }
}

async function resolveMember(message: Message): Promise<GuildMember | null> {
  if (message.member) return message.member;
  const guild = message.guild;
  if (!guild) return null;
  return guild.members.fetch(message.author.id).catch(() => null);
}

function banWipeSeconds(ctx: AppContext, guildId: string): number {
  return ctx.config.getEffective<number>(guildId, CONFIG_KEYS.automodBanDeleteHours) * 3600;
}

// ── Blocklist matching ───────────────────────────────────────────────────────
interface Match {
  kind: SignatureKind;
  value: string;
}

async function matchBlocklist(ctx: AppContext, message: Message, now: number): Promise<Match | null> {
  const guildId = message.guild?.id;
  if (!guildId) return null;
  const sets = signatures(ctx, guildId, now);

  // Domains (content + optionally embeds + filenames + bare).
  const includeBare = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.antiscamBareDomains);
  const embedTexts = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.antiscamScanEmbeds)
    ? embedTextsOf(message)
    : [];
  const filenames = ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.antiscamScanAttachmentNames)
    ? message.attachments.map((a) => a.name)
    : [];
  if (sets.domain.size) {
    for (const host of extractHostnames({ content: message.content, embedTexts, filenames, includeBare })) {
      if (sets.domain.has(host)) return { kind: "domain", value: host };
    }
  }

  // Images: cheap (size:w:h) pre-filter, then confirm with a SHA-256 when we hold hashes.
  if (sets.triple.size || sets.sha256.size) {
    const maxBytes = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.antiscamSeedMaxBytes) * 1_000_000;
    for (const a of message.attachments.values()) {
      const triple = attachmentTriple(a.size, a.width, a.height);
      if (!triple || !sets.triple.has(triple)) continue;
      if (sets.sha256.size && a.size <= maxBytes) {
        const hash = await sha256Of(a.url, maxBytes);
        if (hash && sets.sha256.has(hash)) return { kind: "sha256", value: hash };
        // Same dimensions, different bytes — not the same file. Keep looking.
      } else {
        return { kind: "triple", value: triple };
      }
    }
  }
  return null;
}

function matchAlert(userId: string, channelId: string, match: Match, action: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xd35400)
    .setTitle("🛑 Known scam signature matched")
    .addFields(
      { name: "User", value: `<@${userId}> (${userId})` },
      { name: "Channel", value: `<#${channelId}>` },
      { name: "Matched", value: `\`${match.kind}\`: \`${match.value.slice(0, 200)}\`` },
      { name: "Action", value: action },
    )
    .setTimestamp(new Date());
}

function forgetButton(match: Match): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`antiscam:forget:${match.kind}:${match.value}`.slice(0, 100))
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Not a scam — remove"),
  );
}

async function actOnMatch(
  ctx: AppContext,
  message: Message,
  member: GuildMember | null,
  action: "flag" | "delete" | "ban",
  match: Match,
  now: number,
): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  bumpSignatureHit(ctx.db, guild.id, match.kind, match.value, now);
  const botId = message.client.user.id;
  const reason = `Anti-scam: known-bad ${match.kind}`;

  let effective = action;
  if (action === "ban") {
    const acted = await applyModAction({
      guild,
      member,
      userId: message.author.id,
      type: "ban",
      reason,
      deleteMessageSeconds: banWipeSeconds(ctx, guild.id),
      dm: ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.dmOnAction)
        ? `You were banned from **${guild.name}** — your message matched a known scam.`
        : undefined,
    });
    if (acted) {
      try {
        createCase(ctx.db, { guildId: guild.id, userId: message.author.id, moderatorId: botId, type: "ban", reason });
      } catch (error) {
        ctx.logger.error("antiscam: banned but failed to record case", {
          guildId: guild.id,
          userId: message.author.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      effective = "flag"; // couldn't ban — report honestly
    }
  }

  // Remove the message on delete. Flag = alert only. (Ban already wiped via deleteMessageSeconds.)
  if (effective === "delete") {
    suppressDeletion(message.id);
    const ok = await message.delete().then(() => true).catch(() => false);
    if (!ok) suppressedDeletions.delete(message.id);
    // Record a violation (counts toward the automod escalation ladder) — no logCase, the match
    // alert below is the visible mod-log record.
    try {
      createCase(ctx.db, { guildId: guild.id, userId: message.author.id, moderatorId: botId, type: "warn", reason });
    } catch (error) {
      ctx.logger.error("antiscam: failed to record blocklist warn", {
        guildId: guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const label = effective === "ban" ? "Banned" : effective === "delete" ? "Deleted + recorded" : "Flagged";
  await logModAlert(ctx, guild, matchAlert(message.author.id, message.channelId, match, label));
  // The alert carries a one-click correction for a false positive.
  const channelId = ctx.config.get<string>(guild.id, CONFIG_KEYS.modLogChannelId);
  if (channelId) {
    const channel =
      guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (channel?.isTextBased()) {
      await channel.send({ components: [forgetButton(match)] }).catch(() => {});
    }
  }
}

// ── Cross-channel spray ──────────────────────────────────────────────────────
const sprays = new SprayTracker();
// Recent message refs per user, so a tripped spray can be purged across every channel it hit.
const sprayMsgs = new Map<string, { channelId: string; messageId: string; ts: number }[]>();

function recordSprayMsg(key: string, channelId: string, messageId: string, now: number, windowMs: number): void {
  const list = (sprayMsgs.get(key) ?? []).filter((m) => m.ts > now - windowMs);
  list.push({ channelId, messageId, ts: now });
  sprayMsgs.set(key, list);
  if (sprayMsgs.size > 1000) {
    for (const [k, ms] of sprayMsgs) if (ms.every((m) => m.ts <= now - windowMs)) sprayMsgs.delete(k);
  }
}

async function purgeSpray(ctx: AppContext, message: Message, key: string): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const refs = sprayMsgs.get(key) ?? [];
  for (const ref of refs) {
    const channel = guild.channels.cache.get(ref.channelId);
    if (!channel?.isTextBased()) continue;
    suppressDeletion(ref.messageId);
    const ok = await channel.messages.delete(ref.messageId).then(() => true).catch(() => false);
    if (!ok) suppressedDeletions.delete(ref.messageId);
  }
  sprayMsgs.delete(key);
}

async function actOnSpray(
  ctx: AppContext,
  message: Message,
  member: GuildMember | null,
  action: "flag" | "timeout" | "kick" | "ban",
  key: string,
): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const botId = message.client.user.id;
  const reason = "Anti-scam: cross-channel spray";
  let effective: "flag" | "timeout" | "kick" | "ban" = action;

  if (action !== "flag") {
    const acted = await applyModAction({
      guild,
      member,
      userId: message.author.id,
      type: action,
      reason,
      timeoutMs:
        action === "timeout"
          ? ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.antiscamSprayTimeoutMinutes) * 60_000
          : undefined,
      deleteMessageSeconds: action === "ban" ? banWipeSeconds(ctx, guild.id) : undefined,
      dm: ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.dmOnAction)
        ? `You were actioned in **${guild.name}** for spraying the same message across many channels — if this wasn't you, your account may be compromised.`
        : undefined,
    });
    if (acted) {
      const caseType = action === "timeout" ? "timeout" : action;
      try {
        createCase(ctx.db, { guildId: guild.id, userId: message.author.id, moderatorId: botId, type: caseType, reason });
      } catch (error) {
        ctx.logger.error("antiscam: sprayed action but failed to record case", {
          guildId: guild.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      effective = "flag";
    }
  }

  if (ctx.config.getEffective<boolean>(guild.id, CONFIG_KEYS.antiscamSprayPurge)) {
    await purgeSpray(ctx, message, key);
  }

  const label =
    effective === "ban" ? "Banned" : effective === "kick" ? "Kicked" : effective === "timeout" ? "Timed out" : "Flagged";
  await logModAlert(
    ctx,
    guild,
    new EmbedBuilder()
      .setColor(0xd35400)
      .setTitle("🚿 Cross-channel spray detected")
      .addFields(
        { name: "User", value: `<@${message.author.id}> (${message.author.id})` },
        { name: "Action", value: label },
      )
      .setTimestamp(new Date()),
  );
}

// ── Self-seeding ─────────────────────────────────────────────────────────────
interface Evidence {
  content: string;
  attachments: { url: string; size: number; width: number | null; height: number | null; name: string }[];
}

async function seedFromEvidence(
  ctx: AppContext,
  guild: { id: string },
  source: "honeypot" | "manual",
  evidence: Evidence,
): Promise<number> {
  const gid = guild.id;
  const now = Date.now();
  const expiresAt = now + ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSeedTtlDays) * DAY_MS;
  let added = 0;

  if (ctx.config.getEffective<boolean>(gid, CONFIG_KEYS.antiscamSeedDomains)) {
    const allowlist = parseDomainList(ctx.config.getEffective<string>(gid, CONFIG_KEYS.automodLinkAllowlist) ?? "");
    const hosts = extractHostnames({
      content: evidence.content,
      filenames: evidence.attachments.map((a) => a.name),
      includeBare: true,
    });
    for (const host of hosts) {
      if (!isSeedableDomain(host, allowlist)) continue;
      upsertSignature(ctx.db, { guildId: gid, kind: "domain", value: host, source, expiresAt }, now);
      added++;
    }
  }

  if (ctx.config.getEffective<boolean>(gid, CONFIG_KEYS.antiscamSeedImages)) {
    const maxBytes = ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSeedMaxBytes) * 1_000_000;
    for (const a of evidence.attachments) {
      const triple = attachmentTriple(a.size, a.width, a.height);
      if (!triple) continue;
      upsertSignature(ctx.db, { guildId: gid, kind: "triple", value: triple, source, expiresAt }, now);
      added++;
      if (a.size <= maxBytes) {
        const hash = await sha256Of(a.url, maxBytes);
        if (hash) upsertSignature(ctx.db, { guildId: gid, kind: "sha256", value: hash, source, expiresAt }, now);
      }
    }
  }

  if (added > 0) {
    const cap = ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSeedMaxEntries);
    for (const kind of ["domain", "sha256", "triple"] as SignatureKind[]) evictOldest(ctx.db, gid, kind, cap);
    invalidate(gid);
  }
  return added;
}

// ── The message listener ─────────────────────────────────────────────────────
const onCreate: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    const guild = message.guild;
    if (!guild || message.author.bot || message.system) return;
    if (inHoneypotChannel(ctx, message)) return; // the honeypot owns its channel
    const gid = guild.id;

    const blocklistAction = blocklistActionOf(ctx, gid);
    const sprayAction = sprayActionOf(ctx, gid);
    if (blocklistAction === "off" && sprayAction === "off") return;

    // Ticket channels follow the same exemption toggle as automod.
    if (
      !ctx.config.getEffective<boolean>(gid, CONFIG_KEYS.automodModerateTickets) &&
      getTicketByChannel(ctx.db, message.channelId)
    ) {
      return;
    }

    const isStaff = message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false;
    const now = Date.now();

    // Blocklist: trusted staff are exempt (a compromised staff account is caught by the spray
    // detector, which by default does NOT exempt them).
    if (blocklistAction !== "off" && !isStaff) {
      const match = await matchBlocklist(ctx, message, now);
      if (match) {
        await actOnMatch(ctx, message, await resolveMember(message), blocklistAction, match, now);
        return; // acted; don't also count this toward a spray
      }
    }

    // Spray detector.
    if (sprayAction !== "off") {
      if (isStaff && ctx.config.getEffective<boolean>(gid, CONFIG_KEYS.antiscamSprayExemptStaff)) return;
      const windowMs = ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSpraySeconds) * 1000;
      const fp = ctx.config.getEffective<boolean>(gid, CONFIG_KEYS.antiscamSprayMatchAttachments)
        ? firstImageTriple(message)
        : null;
      const key = `${gid}:${message.author.id}`;
      recordSprayMsg(key, message.channelId, message.id, now, windowMs);
      const tripped = sprays.record(
        key,
        { channelId: message.channelId, text: message.content, fp, now },
        {
          windowMs,
          minChars: ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSprayMinChars),
          similarity: ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSpraySimilarity),
          channels: ctx.config.getEffective<number>(gid, CONFIG_KEYS.antiscamSprayChannels),
        },
      );
      if (tripped) await actOnSpray(ctx, message, await resolveMember(message), sprayAction, key);
    }
  },
};

function firstImageTriple(message: Message): string | null {
  for (const a of message.attachments.values()) {
    const triple = attachmentTriple(a.size, a.width, a.height);
    if (triple) return triple;
  }
  return null;
}

// ── Wire self-seeding once the client is ready (captures ctx) ────────────────
let subscribed = false;
const onReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle(ctx) {
    if (subscribed) return;
    subscribed = true;
    onHoneypotHit(async (hit) => {
      if (!ctx.config.getEffective<boolean>(hit.guild.id, CONFIG_KEYS.antiscamSeedFromHoneypot)) return;
      try {
        await seedFromEvidence(ctx, hit.guild, "honeypot", {
          content: hit.content,
          attachments: hit.attachments,
        });
        invalidate(hit.guild.id);
      } catch (error) {
        ctx.logger.error("antiscam: seeding from honeypot failed", {
          guildId: hit.guild.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },
};

// ── Commands ─────────────────────────────────────────────────────────────────
const MSG_LINK = /channels\/(\d+)\/(\d+)\/(\d+)/;

const seedSub: Subcommand = {
  description: "Seed the scam blocklist from an existing message (domains + image hash).",
  permission: PermissionFlagsBits.ManageGuild,
  options: (s) => s.addStringOption((o) => o.setName("message").setDescription("A message link").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const m = interaction.options.getString("message", true).match(MSG_LINK);
    const channelId = m?.[2];
    const messageId = m?.[3];
    if (!channelId || !messageId) {
      await interaction.reply({ content: "That doesn't look like a message link.", flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const target = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!target) {
      await interaction.reply({ content: "Couldn't fetch that message.", flags: MessageFlags.Ephemeral });
      return;
    }
    const added = await seedFromEvidence(ctx, interaction.guild, "manual", {
      content: target.content,
      attachments: target.attachments.map((a) => ({
        url: a.url,
        size: a.size,
        width: a.width ?? null,
        height: a.height ?? null,
        name: a.name,
      })),
    });
    await interaction.reply({
      content: added > 0 ? `Seeded ${added} signature(s) from that message.` : "Nothing seedable in that message.",
      flags: MessageFlags.Ephemeral,
    });
  },
};

const forgetSub: Subcommand = {
  description: "Remove a signature from the scam blocklist.",
  permission: PermissionFlagsBits.ManageGuild,
  options: (s) =>
    s
      .addStringOption((o) =>
        o
          .setName("kind")
          .setDescription("Signature kind")
          .setRequired(true)
          .addChoices({ name: "domain", value: "domain" }, { name: "sha256", value: "sha256" }, { name: "triple", value: "triple" }),
      )
      .addStringOption((o) => o.setName("value").setDescription("The exact value to remove").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const kind = interaction.options.getString("kind", true) as SignatureKind;
    const value = interaction.options.getString("value", true);
    const removed = removeSignature(ctx.db, interaction.guildId, kind, value);
    invalidate(interaction.guildId);
    await interaction.reply({
      content: removed > 0 ? "Removed." : "No matching signature.",
      flags: MessageFlags.Ephemeral,
    });
  },
};

// The "Not a scam — remove" button on a match alert.
const forgetButtonHandler: ComponentHandler = {
  customId: "antiscam:forget",
  type: "button",
  match: "prefix",
  async handle(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guildId) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
      return;
    }
    // customId = antiscam:forget:<kind>:<value>
    const rest = interaction.customId.slice("antiscam:forget:".length);
    const sep = rest.indexOf(":");
    const kind = rest.slice(0, sep) as SignatureKind;
    const value = rest.slice(sep + 1);
    removeSignature(ctx.db, interaction.guildId, kind, value);
    invalidate(interaction.guildId);
    await interaction.reply({ content: `Removed \`${kind}\` \`${value.slice(0, 100)}\` from the blocklist.`, flags: MessageFlags.Ephemeral });
  },
};

export const antiscamModule: BotModule = {
  name: "antiscam",
  commands: [
    featureCommand({
      name: "antiscam",
      description: "Anti-scam blocklist controls",
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      subcommands: { seed: seedSub, forget: forgetSub },
    }),
  ],
  listeners: [onCreate, onReady] as Listener[],
  components: [forgetButtonHandler],
};
