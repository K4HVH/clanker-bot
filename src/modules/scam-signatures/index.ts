import { Events, MessageFlags, PermissionFlagsBits } from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler, Listener } from "../../core/module";
import { evictOldest, removeSignature, type SignatureKind, upsertSignature } from "../../db/scam-signature";
import { extractHostnames, parseDomainList } from "../../lib/automod";
import { CONFIG_KEYS } from "../../lib/config";
import { onHoneypotHit } from "../../lib/honeypot-events";
import { attachmentTriple, isSeedableDomain } from "../../lib/scam-seed";
import { invalidateSignatures, sha256Of, takeForgetToken } from "../../lib/scam-signatures";

// The one automated writer of the scam-signature store. It seeds signatures from honeypot hits and
// the /scam commands; automod reads and enforces them. It never enforces or punishes.

const DAY_MS = 86_400_000;

interface Evidence {
  content: string;
  attachments: { url: string; size: number; width: number | null; height: number | null; name: string }[];
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

// Subscribe to honeypot hits once the client is ready, so ctx is captured.
let subscribed = false;
const onReady: Listener<Events.ClientReady> = {
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

const MSG_LINK = /channels\/(\d+)\/(\d+)\/(\d+)/;

const seedSub: Subcommand = {
  description: "Seed scam signatures from an existing message (its domains and image hash).",
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
    const added = await seedFromEvidence(ctx, interaction.guild.id, "manual", {
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

// The "Not a scam" button automod posts on a match alert. Removing a signature is a write, so it
// lives with the writer.
const forgetButtonHandler: ComponentHandler = {
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
        content: "That correction expired. Use `/scam forget` instead.",
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

export const scamSignaturesModule: BotModule = {
  name: "scam-signatures",
  commands: [
    featureCommand({
      name: "scam",
      description: "Scam signature list controls",
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      subcommands: { seed: seedSub, forget: forgetSub },
    }),
  ],
  listeners: [onReady] as Listener[],
  components: [forgetButtonHandler],
};
