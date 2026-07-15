import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Events,
  type Guild,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type User,
} from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler, Listener, SlashCommand } from "../../core/module";
import { type CaptchaDifficulty, ensureWasm, generateCode, renderCaptcha } from "../../lib/captcha";
import { CONFIG_KEYS } from "../../lib/config";
import { suppressDeletion, suppressedDeletions } from "../../lib/log-suppress";
import { logMemberEvent, logModAlert } from "../../lib/modlog";
import { inVerifyChannel } from "../../lib/verify-channel";
import {
  type ChallengeMode,
  challengeMode,
  isCodeShaped,
  memberHasRole,
  verifyFlags,
} from "../../lib/verification-logic";
import { deleteChallenge, getChallenge, setChallenge } from "../../db/verification";

const DAY_MS = 86_400_000;
// Ephemeral replies edit via an interaction token that dies at 15 min; cap under it.
const EPHEMERAL_CAP_MS = 14 * 60_000;

// A message payload accepted by both interaction.editReply and message.edit.
// `attachments: []` drops the prior captcha image so an edit swaps it cleanly.
interface Payload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: AttachmentBuilder[];
  attachments: never[];
}

// One live verification session per user. The captcha CODE lives in SQLite (the
// source of truth, survives restarts); this holds the transient UX state — which
// surface to re-render, the attempt count, and when the shown code was issued.
interface Session {
  guild: Guild;
  user: User;
  isDm: boolean;
  channelId: string;
  attempts: number;
  issuedAt: number;
  timer: ReturnType<typeof setTimeout>;
  refresh(payload: Payload): Promise<void>;
}

const sessions = new Map<string, Session>();
// Users whose message is mid-processing, so two fast submissions can't interleave.
const processing = new Set<string>();
const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

let imageSeq = 0; // unique attachment filename per render (Discord caches by name)

// Per-user cooldown on user-triggered captcha renders (/verify, Verify, New Code) so
// nobody can spam synchronous wasm renders; on-join renders are exempt (system-driven).
const RENDER_COOLDOWN_MS = 3000;
const renderCooldown = new Map<string, number>();
// Per-user cooldown on verification mod-log alerts so a loop can't flood the mod-log.
const MOD_ALERT_COOLDOWN_MS = 30_000;
const modAlertCooldown = new Map<string, number>();

// Drop timestamp entries older than their window once a map gets large, so the
// cooldown maps stay bounded over long uptimes without a scheduled sweep.
function sweep(map: Map<string, number>, maxAgeMs: number): void {
  if (map.size < 500) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const [entry, ts] of map) if (ts < cutoff) map.delete(entry);
}

// True (and stamps) if a render is allowed for this user now, false if too soon.
function takeRenderSlot(k: string): boolean {
  sweep(renderCooldown, RENDER_COOLDOWN_MS);
  const now = Date.now();
  const last = renderCooldown.get(k);
  if (last !== undefined && now - last < RENDER_COOLDOWN_MS) return false;
  renderCooldown.set(k, now);
  return true;
}

// Fire a verification mod-alert at most once per cooldown key, so a departed or
// looping user can't manufacture a flood that buries real ones. The key includes
// the alert KIND so two distinct reasons for the same user throttle independently.
async function maybeAlert(
  ctx: AppContext,
  guild: Guild,
  cooldownKey: string,
  build: () => EmbedBuilder,
): Promise<void> {
  sweep(modAlertCooldown, MOD_ALERT_COOLDOWN_MS);
  const k = `${guild.id}:${cooldownKey}`;
  const now = Date.now();
  const last = modAlertCooldown.get(k);
  if (last !== undefined && now - last < MOD_ALERT_COOLDOWN_MS) return;
  modAlertCooldown.set(k, now);
  await logModAlert(ctx, guild, build());
}

function difficultyOf(ctx: AppContext, guildId: string): CaptchaDifficulty {
  const d = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationDifficulty);
  return (Math.min(5, Math.max(1, Math.round(d))) || 3) as CaptchaDifficulty;
}

function newCodeRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("verify_new").setLabel("New Code").setStyle(ButtonStyle.Secondary),
  );
}

function terminal(title: string, description: string, color: number): Payload {
  return {
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)],
    components: [],
    files: [],
    attachments: [],
  };
}

// Reuse / rotate / start a challenge, render it, and return a payload + deadline +
// mode. Renders BEFORE persisting so a failed render leaves no row behind.
async function issueCaptcha(
  ctx: AppContext,
  guildId: string,
  userId: string,
  opts: { forceNew?: boolean; isDm: boolean; status?: string },
): Promise<{ payload: Payload; expiresAt: number; mode: ChallengeMode }> {
  const now = Date.now();
  const existing = getChallenge(ctx.db, guildId, userId);
  const mode = challengeMode(existing, now, opts.forceNew ?? false);

  let code: string;
  let expiresAt: number;
  if (mode === "reuse") {
    code = existing!.code;
    expiresAt = existing!.expiresAt;
  } else {
    const len = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationCodeLength);
    code = generateCode(len);
    expiresAt =
      mode === "rotate"
        ? existing!.expiresAt // keep the deadline stable across rotations
        : now + ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationChallengeTtlMs);
  }

  const png = await renderCaptcha(code, difficultyOf(ctx, guildId));
  if (mode !== "reuse") setChallenge(ctx.db, guildId, userId, code, expiresAt);

  const name = `captcha-${imageSeq++}.png`;
  const file = new AttachmentBuilder(Buffer.from(png), {
    name,
    description: "Distorted verification code — an image-based challenge", // non-revealing a11y text
  });
  // In-channel (ephemeral) sessions are capped at the interaction-token life, so
  // never promise longer than the session can actually honor.
  const shownExpiry = opts.isDm ? expiresAt : Math.min(expiresAt, Date.now() + EPHEMERAL_CAP_MS);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Server Verification")
    .setDescription(
      opts.isDm
        ? "Reply to this message with the code shown in the image."
        : "Type the code shown in the image as a message in this channel.",
    )
    .addFields({ name: "Expires", value: `<t:${Math.floor(shownExpiry / 1000)}:R>` })
    .setImage(`attachment://${name}`);
  if (opts.status) embed.addFields({ name: "Status", value: opts.status });

  return {
    payload: { embeds: [embed], components: [newCodeRow()], files: [file], attachments: [] },
    expiresAt,
    mode,
  };
}

async function grantVerified(
  ctx: AppContext,
  guild: Guild,
  userId: string,
): Promise<{ ok: true } | { ok: false; left: boolean; msg: string }> {
  const roleId = ctx.config.get<string>(guild.id, CONFIG_KEYS.verifiedRoleId);
  if (!roleId) {
    return { ok: false, left: false, msg: "Verification isn't fully configured. Contact a moderator." };
  }
  try {
    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId, "Passed verification");
    return { ok: true };
  } catch (error) {
    // The user solved a DM captcha but has since LEFT the guild — not a misconfig.
    const code = (error as { code?: number }).code;
    const left = code === 10007 || code === 10013; // Unknown Member / Unknown User
    if (!left) {
      ctx.logger.error("verification: role grant failed", {
        guildId: guild.id,
        userId,
        roleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: false, left, msg: "Couldn't grant your role (my role may be too low). Contact a moderator." };
  }
}

// Log a passed verification to the member-log, and flag young/fast accounts to the
// mod-log. `issuedAt` (when the solved code was shown) may be unknown after a restart.
async function logVerified(
  ctx: AppContext,
  guild: Guild,
  user: User,
  issuedAt: number | undefined,
): Promise<void> {
  const now = Date.now();
  const ageDays = Math.floor((now - user.createdTimestamp) / DAY_MS);
  const solveMs = issuedAt !== undefined ? now - issuedAt : undefined;

  const fields = [
    { name: "User", value: `<@${user.id}> (${user.id})` },
    { name: "Account created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>` },
    { name: "Account age", value: `${ageDays}d`, inline: true },
  ];
  if (solveMs !== undefined) fields.push({ name: "Solved in", value: `${(solveMs / 1000).toFixed(1)}s`, inline: true });
  await logMemberEvent(
    ctx,
    guild,
    new EmbedBuilder().setColor(0x2ecc71).setTitle("Member verified").addFields(fields).setTimestamp(new Date(now)),
  );

  const flagDays = ctx.config.getEffective<number>(guild.id, CONFIG_KEYS.verificationFlagYoungDays);
  const flags = verifyFlags(ageDays, flagDays, solveMs ?? Number.MAX_SAFE_INTEGER);
  if (flags.young || flags.fast) {
    const reasons: string[] = [];
    if (flags.young) reasons.push(`account only ${ageDays}d old (flag < ${flagDays}d)`);
    if (flags.fast && solveMs !== undefined) reasons.push(`solved in ${(solveMs / 1000).toFixed(1)}s (scripted?)`);
    await logModAlert(
      ctx,
      guild,
      new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle("🚩 Suspicious verification")
        .addFields(
          { name: "User", value: `<@${user.id}> (${user.id})` },
          { name: "Why", value: reasons.join("\n") },
        ),
    );
  }
}

// Register (or replace) the one live session for a user. Keeps the attempt count
// across re-arms (New Code / a second surface), and preserves the original
// issue time on a pure reuse so "solved in" measures the real read-to-solve gap.
function registerSession(
  ctx: AppContext,
  s: {
    guild: Guild;
    user: User;
    isDm: boolean;
    channelId: string;
    refresh(payload: Payload): Promise<void>;
    expiresAt: number;
    mode: ChallengeMode;
  },
): void {
  const k = key(s.guild.id, s.user.id);
  const prev = sessions.get(k);
  if (prev) clearTimeout(prev.timer);
  const now = Date.now();
  const issuedAt = s.mode === "reuse" ? (prev?.issuedAt ?? now) : now;
  const attempts = prev?.attempts ?? 0;
  const cap = s.isDm ? Number.MAX_SAFE_INTEGER : EPHEMERAL_CAP_MS;
  const delay = Math.max(1000, Math.min(s.expiresAt - now, cap));
  const timer = setTimeout(() => {
    const cur = sessions.get(k);
    if (!cur || cur.timer !== timer) return; // superseded
    sessions.delete(k);
    void cur
      .refresh(terminal("Timed out", "Verification timed out. Run `/verify` to try again.", 0x95a5a6))
      .catch(() => {});
  }, delay);
  timer.unref?.();
  sessions.set(k, {
    guild: s.guild,
    user: s.user,
    isDm: s.isDm,
    channelId: s.channelId,
    attempts,
    issuedAt,
    timer,
    refresh: s.refresh,
  });
}

function endSession(k: string): void {
  const s = sessions.get(k);
  if (s) {
    clearTimeout(s.timer);
    sessions.delete(k);
  }
}

// ── The one validator: a typed code, in a DM or a session's channel ──────────
const onMessage: Listener<Events.MessageCreate> = {
  event: Events.MessageCreate,
  async handle(ctx, message) {
    if (message.author.bot) return;
    const isDm = !message.guildId;
    const guildId = message.guildId ?? ctx.env.guildId;
    const userId = message.author.id;
    const k = key(guildId, userId);
    const session = sessions.get(k);

    // Channel context. A configured verify channel (and threads under it) is bot-owned:
    // every non-staff, non-verified message there is scrubbed to keep it clear (validated
    // as a code first if it is one).
    const inVerify = !isDm && inVerifyChannel(ctx, message);
    const staff = !isDm && (message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false);
    const verifiedRoleId = isDm ? undefined : ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
    const verified = !!verifiedRoleId && memberHasRole(message.member?.roles ?? null, verifiedRoleId);
    const inSessionChannel = !!session && session.channelId === message.channelId;

    // Only a DM, the verify channel, or a live session's channel is ours to touch.
    if (!isDm && !inVerify && !inSessionChannel) return;

    const challenge = getChallenge(ctx.db, guildId, userId);
    const live = challenge !== undefined && challenge.expiresAt >= Date.now();
    const entered = message.content.trim().toUpperCase();
    const isGuess = live && isCodeShaped(entered, challenge!.code.length);

    // Keep the verify channel clear: delete EVERY message from an unverified non-staff
    // user there, whatever it contains (text, links, images, stickers, embeds, mentions).
    // Elsewhere, only delete the code the user typed in a live session's channel.
    if (!isDm && ((inVerify && !staff && !verified) || (isGuess && inSessionChannel))) {
      suppressDeletion(message.id);
      await message.delete().catch(async (error) => {
        suppressedDeletions.delete(message.id);
        ctx.logger.warn("verification: couldn't delete message", {
          guildId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        // If we lack Manage Messages, the "kept clear" guarantee is silently failing —
        // surface it (rate-limited per channel) so an operator can fix the permission.
        if ((error as { code?: number }).code === 50013 && message.guild) {
          await maybeAlert(ctx, message.guild, `scrub-perms:${message.channelId}`, () =>
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("⚠️ Can't keep the verify channel clear")
              .setDescription(
                "I lack **Manage Messages** in the verify channel, so messages there aren't being deleted. Please grant it.",
              ),
          );
        }
      });
    }

    if (!isGuess) {
      if (session && !live) endSession(k);
      return; // scrubbed (if applicable) but not a live code — don't count as an attempt
    }

    if (processing.has(k)) return; // a prior submission is still resolving
    processing.add(k);
    try {
      const guild =
        session?.guild ?? message.guild ?? (await message.client.guilds.fetch(guildId).catch(() => null));
      if (!guild) return;
      const user = session?.user ?? message.author;
      // Show progress on the live surface, or — after a restart, when there is no
      // session — a channel reply that auto-cleans itself in the policed verify channel.
      const present = async (payload: Payload): Promise<void> => {
        if (session) {
          await session.refresh(payload).catch(() => {});
          return;
        }
        const sent = await message.channel.send({ embeds: payload.embeds }).catch(() => null);
        if (sent && inVerify) {
          suppressDeletion(sent.id);
          setTimeout(() => void sent.delete().catch(() => suppressedDeletions.delete(sent.id)), 6000).unref?.();
        }
      };

      if (entered === challenge!.code) {
        const result = await grantVerified(ctx, guild, userId);
        if (!result.ok) {
          if (result.left) {
            // The user solved but has since LEFT — clean up so it can't re-fire; no alert.
            endSession(k);
            deleteChallenge(ctx.db, guildId, userId);
            return;
          }
          // Misconfig or a transient error: keep the challenge + session so a retry (or a
          // fixed role) can still succeed; the alert is rate-limited so it can't flood.
          await present(terminal("Verification failed", result.msg, 0xe74c3c));
          await maybeAlert(ctx, guild, `grant-failed:${userId}`, () =>
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("⚠️ Verification grant failed")
              .setDescription(result.msg)
              .addFields({ name: "User", value: `<@${userId}> (${userId})` }),
          );
          return;
        }
        endSession(k);
        deleteChallenge(ctx.db, guildId, userId);
        await present(terminal("Verified", "✅ You're verified — welcome!", 0x2ecc71));
        await logVerified(ctx, guild, user, session?.issuedAt);
        return;
      }

      // Wrong guess without a live session (post-restart). In a guild channel the message
      // was already scrubbed — stay silent so a stream of wrong codes can't amplify into
      // a bot reply per message. Only guide in a DM (nothing was deleted there).
      if (!session) {
        if (isDm) {
          await present(terminal("Incorrect", "That code is wrong. Run `/verify` to get a fresh code.", 0x95a5a6));
        }
        return;
      }
      const maxAttempts = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationMaxAttempts);
      session.attempts += 1;
      if (session.attempts >= maxAttempts) {
        const attempts = session.attempts;
        endSession(k);
        deleteChallenge(ctx.db, guildId, userId);
        await present(
          terminal("Too many attempts", "You've used all your attempts. Run `/verify` to start over.", 0xe74c3c),
        );
        await maybeAlert(ctx, guild, `exhausted:${userId}`, () =>
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🚩 Captcha attempts exhausted")
            .addFields(
              { name: "User", value: `<@${userId}> (${userId})` },
              { name: "Attempts", value: `${attempts}` },
            ),
        );
        return;
      }
      // Rotate the code (fresh image, same deadline) and reset the read timer.
      const left = maxAttempts - session.attempts;
      const { payload } = await issueCaptcha(ctx, guildId, userId, {
        forceNew: true,
        isDm,
        status: `❌ Incorrect — ${left} attempt${left === 1 ? "" : "s"} left. Try this new code.`,
      });
      session.issuedAt = Date.now();
      await present(payload);
    } catch (error) {
      ctx.logger.error("verification message handling failed", {
        guildId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      processing.delete(k);
    }
  },
};

// ── Entry points ─────────────────────────────────────────────────────────────

const verifyPanel: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("verify-panel")
    .setDescription("Post the verification panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),
  async execute(interaction, ctx) {
    if (!interaction.inGuild() || !interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "Can't post here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Server Verification")
      .setDescription(
        ctx.config.getEffective<string>(interaction.guildId, CONFIG_KEYS.verificationPanelText),
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("verify_start").setLabel("Verify").setStyle(ButtonStyle.Success),
    );
    await interaction.channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
  },
};

// Show a captcha to a member from an interaction (panel button or /verify) and arm
// an in-channel session. Shared by verify_start and /verify.
async function beginInteractiveVerify(
  ctx: AppContext,
  interaction: ButtonInteraction | Parameters<SlashCommand["execute"]>[0],
  guildId: string,
): Promise<void> {
  if (!takeRenderSlot(key(guildId, interaction.user.id))) {
    await interaction.reply({
      content: "You're going too fast — wait a moment and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { payload, expiresAt, mode } = await issueCaptcha(ctx, guildId, interaction.user.id, { isDm: false });
  await interaction.editReply(payload);
  registerSession(ctx, {
    guild: interaction.guild!,
    user: interaction.user,
    isDm: false,
    channelId: interaction.channelId!,
    refresh: async (p) => {
      await interaction.editReply(p);
    },
    expiresAt,
    mode,
  });
}

const verifyCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify yourself to unlock the server.")
    .setContexts(InteractionContextType.Guild),
  async execute(interaction, ctx) {
    const guildId = interaction.guildId ?? ctx.env.guildId;
    const roleId = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
    if (!roleId) {
      await interaction.reply({
        content: "Verification isn't set up yet. Contact a moderator.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (memberHasRole(interaction.member?.roles ?? null, roleId)) {
      await interaction.reply({ content: "You're already verified. ✅", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.guild || !interaction.channelId) {
      await interaction.reply({
        content: "Run `/verify` in a server channel where you can type.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await beginInteractiveVerify(ctx, interaction, guildId);
  },
};

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    if (member.user.bot) return;
    const guildId = member.guild.id;
    if (!ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId)) return;
    if (!ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.verificationDmOnJoin)) return;

    // Don't render/DM someone the account-age gate is about to kick.
    const minDays = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.minAccountAgeDays);
    if (
      minDays > 0 &&
      ctx.config.getEffective<boolean>(guildId, CONFIG_KEYS.accountAgeGateKick) &&
      Date.now() - member.user.createdTimestamp < minDays * DAY_MS
    ) {
      return;
    }

    const { payload, expiresAt, mode } = await issueCaptcha(ctx, guildId, member.id, { isDm: true });
    try {
      const dm = await member.createDM();
      const msg = await dm.send(payload);
      registerSession(ctx, {
        guild: member.guild,
        user: member.user,
        isDm: true,
        channelId: dm.id,
        refresh: async (p) => {
          await msg.edit(p);
        },
        expiresAt,
        mode,
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 50007) {
        ctx.logger.warn("verification DM blocked (DMs closed)", { guildId, userId: member.id });
        await logModAlert(
          ctx,
          member.guild,
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle("⚠️ Couldn't DM verification")
            .setDescription("Their DMs are closed — they can verify with `/verify` in the server.")
            .addFields({ name: "User", value: `<@${member.id}> (${member.id})` }),
        );
      } else {
        ctx.logger.warn("verification DM failed", {
          guildId,
          userId: member.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },
};

// A thread created under the verify channel is itself persistent content (its name
// shows in the channel) and a scrub bypass — delete non-staff threads there.
const onThreadCreate: Listener<Events.ThreadCreate> = {
  event: Events.ThreadCreate,
  async handle(ctx, thread) {
    const guildId = thread.guildId;
    if (!guildId) return;
    const verifyChannelId = ctx.config.get<string>(guildId, CONFIG_KEYS.verificationChannelId);
    if (!verifyChannelId || thread.parentId !== verifyChannelId) return;
    // Allow staff-created threads (pins/instructions); remove everyone else's.
    if (thread.ownerId) {
      const owner = await thread.guild.members.fetch(thread.ownerId).catch(() => null);
      if (owner?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
    }
    await thread.delete("Verify channel is kept clear").catch((error) => {
      ctx.logger.warn("verification: couldn't delete thread in verify channel", {
        guildId,
        threadId: thread.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  },
};

// Warm the captcha wasm on startup so the first interaction never pays the compile
// cost inside the 3-second ack window.
const onReady: Listener<Events.ClientReady> = {
  event: Events.ClientReady,
  once: true,
  async handle() {
    await ensureWasm();
  },
};

const startHandler: ComponentHandler = {
  customId: "verify_start",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    const guildId = button.guildId ?? ctx.env.guildId;
    const roleId = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
    if (!roleId) {
      await button.reply({
        content: "Verification isn't fully configured. Contact a moderator.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (memberHasRole(button.member?.roles ?? null, roleId)) {
      await button.reply({ content: "You're already verified. ✅", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!button.guild || !button.channelId) {
      await button.reply({ content: "Can't verify in this channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    await beginInteractiveVerify(ctx, button, guildId);
  },
};

const newCodeHandler: ComponentHandler = {
  customId: "verify_new",
  type: "button",
  async handle(interaction, ctx) {
    const button = interaction as ButtonInteraction;
    const guildId = button.guildId ?? ctx.env.guildId;
    const existing = getChallenge(ctx.db, guildId, button.user.id);
    if (!existing || existing.expiresAt < Date.now()) {
      await button.reply({ content: "No active verification. Run `/verify` to start.", flags: MessageFlags.Ephemeral });
      return;
    }
    const isDm = button.guildId === null;
    if (!takeRenderSlot(key(guildId, button.user.id))) {
      await button.reply({ content: "You're going too fast — wait a moment.", flags: MessageFlags.Ephemeral });
      return;
    }
    await button.deferUpdate();
    const { payload, expiresAt, mode } = await issueCaptcha(ctx, guildId, button.user.id, {
      forceNew: true,
      isDm,
    });
    await button.editReply(payload);
    // (Re)arm the session — this also revives collection after a restart, and edits
    // via the DM message (no token limit) or the ephemeral reply as appropriate.
    const guild = button.guild ?? (await button.client.guilds.fetch(guildId).catch(() => null));
    if (guild && button.channelId) {
      registerSession(ctx, {
        guild,
        user: button.user,
        isDm,
        channelId: button.channelId,
        refresh: isDm
          ? async (p) => {
              await button.message.edit(p);
            }
          : async (p) => {
              await button.editReply(p);
            },
        expiresAt,
        mode,
      });
    }
  },
};

export const verificationModule: BotModule = {
  name: "verification",
  commands: [verifyPanel, verifyCommand],
  listeners: [onJoin, onMessage, onThreadCreate, onReady] as Listener[],
  components: [startHandler, newCodeHandler],
};
