import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  Events,
  InteractionContextType,
  type Message,
  type MessageContextMenuCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { AppContext } from "../../core/context";
import type { ComponentHandler, ContextCommand, Listener } from "../../core/module";
import { evictOldest, removeSignature, type SignatureKind, upsertSignature } from "../../db/scam-signature";
import { extractHostnames, parseDomainList } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { onHoneypotHit } from "../../lib/honeypot-events";
import { attachmentTriple, isSeedableDomain } from "../../lib/scam-seed";
import { invalidateSignatures, sha256Of, takeForgetToken } from "../../lib/scam-signatures";

// Seeding is the one automated writer of the scam-signature store that automod's scam rules read.
// It lives inside the automod module so scam detection and its intelligence are one feature. It is
// fed by honeypot hits, the /automod seed command and its right-click menu, and staff DMs.

const DAY_MS = 86_400_000;

interface Evidence {
  content: string;
  attachments: { url: string; size: number; width: number | null; height: number | null; name: string }[];
}

function evidenceOf(message: Message): Evidence {
  return {
    content: message.content,
    attachments: message.attachments.map((a) => ({
      url: a.url,
      size: a.size,
      width: a.width ?? null,
      height: a.height ?? null,
      name: a.name,
    })),
  };
}

// Whether a message plausibly carries a scam sample worth seeding (an attachment or a link).
function hasSeedable(message: Message): boolean {
  return message.attachments.size > 0 || extractHostnames({ content: message.content, includeBare: true }).length > 0;
}

// Add a confirmed-bad message's domains and image signatures to the store. Domains skip anything
// allowlisted or on shared hosting. Images prefer a byte-exact SHA-256, falling back to a size/
// dimensions fingerprint only when they can't be hashed, so the two are mutually exclusive per
// image. Returns how many signatures were added.
async function seedFromEvidence(
  ctx: AppContext,
  guildId: string,
  source: "honeypot" | "manual",
  evidence: Evidence,
): Promise<number> {
  const now = Date.now();
  const expiresAt = now + ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamSeedTtlDays) * DAY_MS;
  let added = 0;

  if (ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.scamSeedDomains)) {
    const allowlist = parseDomainList(ctx.config.getEffective<string>(guildId, CONFIG_KEYS.automodLinkAllowlist) ?? "");
    const hosts = extractHostnames({
      content: evidence.content,
      filenames: evidence.attachments.map((a) => a.name),
      includeBare: true,
    });
    for (const host of hosts) {
      if (!isSeedableDomain(host, allowlist)) continue;
      upsertSignature(ctx.db, { guildId, kind: "domain", value: host, source, expiresAt }, now);
      added++;
    }
  }

  if (ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.scamSeedImages)) {
    const maxBytes = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamMaxImageMb) * 1_000_000;
    for (const a of evidence.attachments) {
      const triple = attachmentTriple(a.size, a.width, a.height);
      if (!triple) continue;
      let hashed = false;
      if (a.size <= maxBytes) {
        const hash = await sha256Of(a.url, maxBytes);
        if (hash) {
          upsertSignature(ctx.db, { guildId, kind: "sha256", value: hash, source, expiresAt }, now);
          added++;
          hashed = true;
        }
      }
      if (!hashed) {
        upsertSignature(ctx.db, { guildId, kind: "triple", value: triple, source, expiresAt }, now);
        added++;
      }
    }
  }

  if (added > 0) {
    const cap = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.scamSeedMaxEntries);
    for (const kind of ["domain", "sha256", "triple"] as SignatureKind[]) evictOldest(ctx.db, guildId, kind, cap);
    invalidateSignatures(guildId);
  }
  return added;
}

const seededReply = (n: number) =>
  n > 0 ? `Seeded ${n} signature(s).` : "Nothing seedable there (no scam domain or image).";

// Subscribe to honeypot hits once the client is ready, so ctx is captured.
let subscribed = false;
export const seedOnReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle(ctx) {
    if (subscribed) return;
    subscribed = true;
    onHoneypotHit(async (hit) => {
      if (!ctx.config.getEffective<boolean>(hit.guild.id, CONFIG_KEYS.scamSeedFromHoneypot)) return;
      try {
        await seedFromEvidence(ctx, hit.guild.id, "honeypot", { content: hit.content, attachments: hit.attachments });
      } catch (error) {
        ctx.logger.error("scam: seeding from a honeypot hit failed", {
          guildId: hit.guild.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },
};

// Seed by DMing the bot an image or link. Staff-only (Manage Server in the guild); silent for
// anyone else and for chit-chat with nothing seedable.
export const seedDmListener: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    if (message.guild || message.author.bot || !hasSeedable(message)) return;
    const guild =
      message.client.guilds.cache.get(ctx.env.guildId) ??
      (await message.client.guilds.fetch(ctx.env.guildId).catch(() => null));
    if (!guild) return;
    const member = await guild.members.fetch(message.author.id).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) return;
    const added = await seedFromEvidence(ctx, guild.id, "manual", evidenceOf(message));
    await message.reply(seededReply(added)).catch(() => {});
  },
};

// /automod seed <message link or id>
const MSG_LINK = /channels\/(\d+)\/(\d+)\/(\d+)/;
const seedSub: Subcommand = {
  description: "Seed scam signatures from a message (paste a link or a message ID in this channel).",
  permission: PermissionFlagsBits.ManageGuild,
  options: (s) => s.addStringOption((o) => o.setName("message").setDescription("A message link or ID").setRequired(true)),
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
      return;
    }
    const raw = interaction.options.getString("message", true).trim();
    const link = raw.match(MSG_LINK);
    const channelId = link ? link[2] : interaction.channelId;
    const messageId = link ? link[3] : /^\d{17,20}$/.test(raw) ? raw : null;
    if (!channelId || !messageId) {
      await interaction.reply({ content: "Give a message link or a message ID.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Defer before the fetch + download/hash, which can exceed Discord's 3s ack window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const target = channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
    if (!target) {
      await interaction.editReply("Couldn't fetch that message.");
      return;
    }
    const added = await seedFromEvidence(ctx, interaction.guild.id, "manual", evidenceOf(target));
    await interaction.editReply(seededReply(added));
  },
};

// /automod forget <kind> <value>
const forgetSub: Subcommand = {
  description: "Remove a signature from the scam list.",
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
    invalidateSignatures(interaction.guildId);
    await interaction.reply({
      content: removed > 0 ? "Removed." : "No matching signature.",
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const automodCommand = featureCommand({
  name: "automod",
  description: "Automod scam-signature controls",
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  subcommands: { seed: seedSub, forget: forgetSub },
});

// Right-click a message, Apps, Seed scam signature.
export const seedContextCommand: ContextCommand = {
  data: new ContextMenuCommandBuilder()
    .setName("Seed scam signature")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction: MessageContextMenuCommandInteraction, ctx) {
    if (!interaction.inGuild()) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server.", flags: MessageFlags.Ephemeral });
      return;
    }
    // Defer before the download/hash, which can exceed Discord's 3s ack window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const added = await seedFromEvidence(ctx, interaction.guildId, "manual", evidenceOf(interaction.targetMessage));
    await interaction.editReply(seededReply(added));
  },
};

// The "Not a scam" button automod posts on a match alert. Removing a signature is a write, so it
// lives with the seeder.
export const forgetButtonHandler: ComponentHandler = {
  customId: "scam:forget",
  type: "button",
  match: "prefix",
  async handle(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.guildId) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = takeForgetToken(interaction.customId.slice("scam:forget:".length));
    if (!target) {
      await interaction.reply({
        content: "That correction expired. Use `/automod forget` instead.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const removed = removeSignature(ctx.db, interaction.guildId, target.kind, target.value);
    invalidateSignatures(interaction.guildId);
    await interaction.reply({
      content: removed > 0 ? `Removed \`${target.kind}\` from the scam list.` : "That signature was already gone.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
