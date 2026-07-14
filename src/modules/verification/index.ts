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

function difficultyOf(ctx: AppContext, guildId: string): CaptchaDifficulty {
  const d = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationDifficulty);
  return (d === 1 || d === 3 ? d : 2) as CaptchaDifficulty;
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
): Promise<{ ok: true } | { ok: false; msg: string }> {
  const roleId = ctx.config.get<string>(guild.id, CONFIG_KEYS.verifiedRoleId);
  if (!roleId) return { ok: false, msg: "Verification isn't fully configured. Contact a moderator." };
  try {
    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId, "Passed verification");
    return { ok: true };
  } catch (error) {
    ctx.logger.error("verification: role grant failed", {
      guildId: guild.id,
      userId,
      roleId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, msg: "Couldn't grant your role (my role may be too low). Contact a moderator." };
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

    // In-channel input counts only when a live session expects it in THIS channel.
    // DM input is always eligible, so a DM verify survives a restart that lost the session.
    if (!isDm && (!session || session.channelId !== message.channelId)) return;

    const challenge = getChallenge(ctx.db, guildId, userId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      if (session) endSession(k);
      return;
    }

    const entered = message.content.trim().toUpperCase();
    if (!isCodeShaped(entered, challenge.code.length)) return; // ordinary chat — leave it alone

    // Remove the typed code from the channel (and keep it out of the audit log) for
    // EVERY code-shaped attempt — including a duplicate we won't re-process below.
    if (!isDm) {
      suppressDeletion(message.id);
      await message.delete().catch((error) => {
        suppressedDeletions.delete(message.id);
        ctx.logger.warn("verification: couldn't delete typed code", {
          guildId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (processing.has(k)) return; // a prior submission is still resolving
    processing.add(k);
    try {
      const guild =
        session?.guild ?? message.guild ?? (await message.client.guilds.fetch(guildId).catch(() => null));
      if (!guild) return;
      const user = session?.user ?? message.author;
      const present = async (payload: Payload): Promise<void> => {
        if (session) await session.refresh(payload).catch(() => {});
        else
          await message.channel
            .send({ embeds: payload.embeds, components: payload.components })
            .catch(() => {});
      };

      if (entered === challenge.code) {
        const result = await grantVerified(ctx, guild, userId);
        if (!result.ok) {
          await present(terminal("Verification failed", result.msg, 0xe74c3c));
          // Surface the one server-wide-breaking misconfig (role too high / perms) to mods.
          await logModAlert(
            ctx,
            guild,
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

      // Wrong guess. Without a live session (post-restart DM), just guide them.
      if (!session) {
        await message.channel
          .send({ content: "❌ Incorrect. Tap **New Code** on the captcha above, or run `/verify`." })
          .catch(() => {});
        return;
      }
      const maxAttempts = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationMaxAttempts);
      session.attempts += 1;
      if (session.attempts >= maxAttempts) {
        endSession(k);
        deleteChallenge(ctx.db, guildId, userId);
        await present(
          terminal("Too many attempts", "You've used all your attempts. Run `/verify` to start over.", 0xe74c3c),
        );
        await logModAlert(
          ctx,
          guild,
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("🚩 Captcha attempts exhausted")
            .addFields(
              { name: "User", value: `<@${userId}> (${userId})` },
              { name: "Attempts", value: `${session.attempts}` },
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
  listeners: [onJoin, onMessage, onReady] as Listener[],
  components: [startHandler, newCodeHandler],
};
