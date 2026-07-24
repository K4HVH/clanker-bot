import { Events } from "discord.js";
import type { Listener } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { onHoneypotHit } from "../../lib/honeypot-events";
import { seedFromEvidence } from "../../lib/scam-signatures";

// Automatic seeding: when the honeypot catches someone, add their scam signatures to the store that
// automod's scan enforces. The manual side (the /mod scamseed command and its context menu) lives
// with the other moderation-data tools in the moderation module.
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
