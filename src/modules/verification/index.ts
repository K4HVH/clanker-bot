import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Events,
  type Guild,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  type User,
} from "discord.js";
import { featureCommand, type Subcommand } from "../../core/command";
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
import {
  type Challenge,
  deleteChallenge,
  getChallenge,
  setChallenge,
  setChallengeDmMessage,
} from "../../db/verification";

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

// One live verification session per user. The captcha CODE and the attempt count both
// live in SQLite (the source of truth — they survive restarts and are shared across
// surfaces); this holds only transient UX state: which surface to re-render and when the
// shown code was issued (for the "solved in" timing).
interface Session {
  guild: Guild;
  user: User;
  isDm: boolean;
  channelId: string;
  issuedAt: number;
  timer: ReturnType<typeof setTimeout>;
  refresh(payload: Payload): Promise<void>;
}

// A user can have a live captcha on more than one surface at once — the on-join DM AND the
// in-channel panel. Sessions are keyed by user, then by channel, and driven TOGETHER: a
// wrong guess / solve / timeout on any surface updates EVERY open captcha the user has, so
// the surfaces never disagree. (The code + attempt count live in SQLite, shared by all.)
const sessions = new Map<string, Map<string, Session>>();
// Users whose message is mid-processing, so two fast submissions can't interleave.
const processing = new Set<string>();
const key = (guildId: string, userId: string) => `${guildId}:${userId}`;

// Every live session for a user (one per surface they have a captcha open on).
function userSessions(userKey: string): Session[] {
  const m = sessions.get(userKey);
  return m ? [...m.values()] : [];
}

// The session for one specific surface (channel), if any.
function surfaceSession(userKey: string, channelId: string): Session | undefined {
  return sessions.get(userKey)?.get(channelId);
}

// Push a payload to EVERY open surface for the user. `make` is called once PER SURFACE (with
// that surface's Session) so each gets payload text/expiry flavored for it, and its own
// attachment instance — a Buffer can't be safely streamed to two uploads.
async function refreshAll(userKey: string, make: (s: Session) => Payload): Promise<void> {
  await Promise.all(userSessions(userKey).map((s) => s.refresh(make(s)).catch(() => {})));
}

// Tear down every surface for a user (solved / exhausted / left / expired).
function endAllSessions(userKey: string): void {
  const m = sessions.get(userKey);
  if (!m) return;
  for (const s of m.values()) clearTimeout(s.timer);
  sessions.delete(userKey);
}

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

// Reuse / rotate / start a challenge, render it, and return a payload FACTORY + deadline +
// mode. The image is rendered once; `build()` wraps it in a fresh payload each call so the
// same captcha can be pushed to several surfaces at once. Renders BEFORE persisting so a
// failed render leaves no row behind.
async function issueCaptcha(
  ctx: AppContext,
  guildId: string,
  userId: string,
  opts: { forceNew?: boolean; status?: string; attempts?: number },
): Promise<{ build: (isDm: boolean) => Payload; expiresAt: number; mode: ChallengeMode }> {
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
        : now + ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationChallengeMinutes) * 60_000;
  }

  const png = await renderCaptcha(code, difficultyOf(ctx, guildId));
  if (mode !== "reuse") {
    // A brand-new challenge starts the shared attempt budget at 0; a rotation preserves it
    // (New Code doesn't cost an attempt) unless the caller overrides it — a wrong guess
    // passes the incremented count so the budget is spent regardless of which surface it
    // was typed on.
    const attempts = opts.attempts ?? (mode === "new" ? 0 : (existing?.attempts ?? 0));
    setChallenge(ctx.db, guildId, userId, code, expiresAt, attempts);
  }

  const name = `captcha-${imageSeq++}.png`;
  // Build a fresh payload per surface. The instruction text and shown Expires depend on WHICH
  // surface it renders on — a DM message ("Reply to this message"), or an in-channel ephemeral
  // ("Type the code…") capped at the interaction-token life — so the same rotated captcha
  // fanned to both surfaces reads correctly on each. The image/code/status are shared; each
  // surface still needs its own AttachmentBuilder (a Buffer can't be re-streamed to two uploads).
  const build = (isDm: boolean): Payload => {
    const shownExpiry = isDm ? expiresAt : Math.min(expiresAt, Date.now() + EPHEMERAL_CAP_MS);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Server Verification")
      .setDescription(
        isDm
          ? "Reply to this message with the code shown in the image."
          : "Type the code shown in the image as a message in this channel.",
      )
      .addFields({ name: "Expires", value: `<t:${Math.floor(shownExpiry / 1000)}:R>` })
      .setImage(`attachment://${name}`)
      .setFooter({ text: "Can't read it? Tap New Code, or ask a moderator." });
    if (opts.status) embed.addFields({ name: "Status", value: opts.status });
    return {
      embeds: [embed],
      components: [newCodeRow()],
      files: [
        new AttachmentBuilder(Buffer.from(png), {
          name,
          description: "Distorted verification code — an image-based challenge", // non-revealing a11y text
        }),
      ],
      attachments: [],
    };
  };
  return { build, expiresAt, mode };
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

// Register (or replace) the live session for ONE surface of a user, leaving their other
// surfaces intact. Preserves the original issue time on a pure reuse so "solved in"
// measures the real read-to-solve gap. Each surface times itself out (they share the
// deadline, so all fire together).
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
  const userKey = key(s.guild.id, s.user.id);
  let m = sessions.get(userKey);
  if (!m) {
    m = new Map();
    sessions.set(userKey, m);
  }
  const prev = m.get(s.channelId);
  if (prev) clearTimeout(prev.timer);
  const now = Date.now();
  const issuedAt = s.mode === "reuse" ? (prev?.issuedAt ?? now) : now;
  const cap = s.isDm ? Number.MAX_SAFE_INTEGER : EPHEMERAL_CAP_MS;
  // Self-rescheduling expiry timer. If it fires while a code submission holds the lock, it
  // RE-ARMS (a short re-check) rather than dying — the submission owns the outcome right now,
  // but if it turns out non-terminal (a wrong-guess rotation keeps the session) the surface
  // must still eventually time out instead of lingering with a dead one-shot timer.
  const armTimeout = (): ReturnType<typeof setTimeout> => {
    const delay = Math.max(1000, Math.min(s.expiresAt - Date.now(), cap));
    const t = setTimeout(() => {
      const bucket = sessions.get(userKey);
      const cur = bucket?.get(s.channelId);
      if (!bucket || !cur || cur.timer !== t) return; // superseded / gone
      if (processing.has(userKey)) {
        cur.timer = armTimeout(); // a submission is resolving — re-check shortly, don't die
        return;
      }
      bucket.delete(s.channelId);
      if (bucket.size === 0) sessions.delete(userKey);
      // If the challenge was already resolved (verified / exhausted / left), drop the surface
      // silently rather than stamp a false "Timed out" over a "Verified".
      if (!getChallenge(ctx.db, s.guild.id, s.user.id)) return;
      void cur
        .refresh(terminal("Timed out", "Verification timed out. Run `/verify` to try again.", 0x95a5a6))
        .catch(() => {});
    }, delay);
    t.unref?.();
    return t;
  };
  const timer = armTimeout();
  m.set(s.channelId, {
    guild: s.guild,
    user: s.user,
    isDm: s.isDm,
    channelId: s.channelId,
    issuedAt,
    timer,
    refresh: s.refresh,
  });
}

// Rebuild a DM session whose in-memory state was lost (a restart) while the DB challenge
// is still live, so a code typed in a DM rotates and counts down exactly as if the session
// had never dropped — no dead-end "run /verify". Anchors on the original on-join captcha
// message (edited in place) when it still exists, else posts a fresh one to anchor on.
// Returns undefined only if the DM channel is somehow unreachable (then the caller bails).
async function reviveDmSession(
  ctx: AppContext,
  message: Message,
  guild: Guild,
  user: User,
  guildId: string,
  challenge: Challenge,
): Promise<Session | undefined> {
  const channel = message.channel;
  if (!("send" in channel) || !("messages" in channel)) return undefined;

  let anchor: Message | null = null;
  if (challenge.dmMessageId) {
    anchor = await channel.messages.fetch(challenge.dmMessageId).catch(() => null);
  }
  if (!anchor) {
    // Original captcha message is gone — post a lightweight placeholder to anchor on. The
    // caller renders the real (rotated) captcha into it, so we neither render twice nor
    // flash the current code the user just guessed wrong. Remember it for future restarts.
    anchor = await channel
      .send({
        embeds: [
          new EmbedBuilder().setColor(0x5865f2).setTitle("Server Verification").setDescription("Checking your code…"),
        ],
      })
      .catch(() => null);
    if (anchor) setChallengeDmMessage(ctx.db, guildId, user.id, anchor.id);
  }
  if (!anchor) return undefined;

  const msg = anchor;
  registerSession(ctx, {
    guild,
    user,
    isDm: true,
    channelId: message.channelId,
    refresh: async (p) => {
      await msg.edit(p);
    },
    expiresAt: challenge.expiresAt,
    mode: "reuse",
  });
  return surfaceSession(key(guildId, user.id), message.channelId);
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
    // The session for the surface this message is on — keyed by channel, so a DM message can
    // only ever drive a DM session and a guild message only that channel's session. The
    // wrong-code feedback structurally cannot land on the wrong surface.
    const session = surfaceSession(k, message.channelId);

    // Channel context. A configured verify channel (and threads under it) is bot-owned:
    // every non-staff, non-verified message there is scrubbed to keep it clear (validated
    // as a code first if it is one).
    const inVerify = !isDm && inVerifyChannel(ctx, message);
    const staff = !isDm && (message.member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false);
    const verifiedRoleId = isDm ? undefined : ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
    const verified = !!verifiedRoleId && memberHasRole(message.member?.roles ?? null, verifiedRoleId);
    const inSessionChannel = !!session;

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
      if (session && !live) endAllSessions(k);
      // Not a live code — typing does nothing (same in DMs and in-channel). An expired
      // captcha is revived by tapping New Code (or the panel Verify button / /verify).
      return; // scrubbed (if applicable) but not a live code — don't count as an attempt
    }

    if (processing.has(k)) return; // a prior submission is still resolving
    processing.add(k);
    try {
      const guild =
        session?.guild ?? message.guild ?? (await message.client.guilds.fetch(guildId).catch(() => null));
      if (!guild) return;
      const user = session?.user ?? message.author;
      // Push an outcome to EVERY open surface for this user, plus the surface they just
      // acted on even if it has no session (a DM after a restart): in a DM, edit the
      // anchored captcha message in place so the result REPLACES the captcha; otherwise a
      // self-cleaning reply in the policed verify channel. Used for terminal states.
      const broadcast = async (make: () => Payload): Promise<void> => {
        await refreshAll(k, make);
        if (surfaceSession(k, message.channelId)) return; // this surface was already covered
        if (isDm) {
          if (challenge?.dmMessageId && "messages" in message.channel) {
            const anchor = await message.channel.messages.fetch(challenge.dmMessageId).catch(() => null);
            if (anchor) {
              await anchor.edit(make()).catch(() => {});
              return;
            }
          }
          await message.channel.send({ embeds: make().embeds }).catch(() => {});
          return;
        }
        if (inVerify) {
          const sent = await message.channel.send({ embeds: make().embeds }).catch(() => null);
          if (sent) {
            suppressDeletion(sent.id);
            setTimeout(() => void sent.delete().catch(() => suppressedDeletions.delete(sent.id)), 6000).unref?.();
          }
        }
      };

      if (entered === challenge!.code) {
        const result = await grantVerified(ctx, guild, userId);
        if (!result.ok) {
          if (result.left) {
            // The user solved but has since LEFT — clean up so it can't re-fire; no alert.
            endAllSessions(k);
            deleteChallenge(ctx.db, guildId, userId);
            return;
          }
          // Misconfig or a transient error: keep the challenge + sessions so a retry (or a
          // fixed role) can still succeed; the alert is rate-limited so it can't flood.
          await broadcast(() => terminal("Verification failed", result.msg, 0xe74c3c));
          await maybeAlert(ctx, guild, `grant-failed:${userId}`, () =>
            new EmbedBuilder()
              .setColor(0xe74c3c)
              .setTitle("⚠️ Verification grant failed")
              .setDescription(result.msg)
              .addFields({ name: "User", value: `<@${userId}> (${userId})` }),
          );
          return;
        }
        deleteChallenge(ctx.db, guildId, userId);
        const solvedAt = session?.issuedAt ?? userSessions(k)[0]?.issuedAt;
        await broadcast(() => terminal("Verified", "✅ You're verified — welcome!", 0x2ecc71));
        endAllSessions(k);
        await logVerified(ctx, guild, user, solvedAt);
        return;
      }

      // ── Wrong guess ──
      // Make sure the surface the user typed on is live (revive a DM whose session a restart
      // dropped — a guild channel can't be revived without an interaction, so a session-less
      // wrong guess there was already scrubbed above), then rotate the shared code and push
      // the SAME new captcha to EVERY open surface, so the DM and in-channel captchas — and
      // the shared "N left" counter — update together instead of drifting apart.
      let sess = session;
      if (!sess) {
        if (!isDm) return;
        sess = await reviveDmSession(ctx, message, guild, user, guildId, challenge!);
        if (!sess) return;
      }

      // The attempt budget is SHARED across surfaces (it lives on the challenge row), so a
      // wrong guess in a DM counts against the in-channel flow and vice-versa — you can't
      // reset it by switching where you type.
      const maxAttempts = ctx.config.getEffective<number>(guildId, CONFIG_KEYS.verificationMaxAttempts);
      const attempts = challenge!.attempts + 1;
      if (attempts >= maxAttempts) {
        deleteChallenge(ctx.db, guildId, userId);
        await refreshAll(k, () =>
          terminal("Too many attempts", "You've used all your attempts. Run `/verify` to start over.", 0xe74c3c),
        );
        endAllSessions(k);
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
      // Rotate the code (fresh image, same deadline), persisting the incremented shared
      // count, and push it to every open surface at once. The deadline is unchanged, so the
      // existing per-surface timers still stand.
      const left = maxAttempts - attempts;
      const { build } = await issueCaptcha(ctx, guildId, userId, {
        forceNew: true,
        attempts,
        status: `❌ Incorrect — ${left} attempt${left === 1 ? "" : "s"} left. Try this new code.`,
      });
      const rotatedAt = Date.now();
      for (const s of userSessions(k)) s.issuedAt = rotatedAt;
      await refreshAll(k, (s) => build(s.isDm));
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

const panelSub: Subcommand = {
  description: "Post the verification panel in this channel.",
  permission: PermissionFlagsBits.ManageGuild,
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
  const k = key(guildId, interaction.user.id);
  // Serialize with an in-flight code submission (onMessage holds the same lock). Otherwise a
  // "reuse" render here could paint a code that a concurrent wrong-guess rotation has already
  // replaced in storage, leaving this new surface showing a stale, wrong code. Check this
  // BEFORE taking a render slot, so a bounced tap doesn't burn the slot and mis-rate-limit a
  // legitimate retry.
  if (processing.has(k)) {
    await interaction.reply({
      content: "You're mid-verification — give it a second and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!takeRenderSlot(k)) {
    await interaction.reply({
      content: "You're going too fast — wait a moment and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  processing.add(k);
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { build, expiresAt, mode } = await issueCaptcha(ctx, guildId, interaction.user.id, {});
    await interaction.editReply(build(false));
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
  } finally {
    processing.delete(k);
  }
}

const meSub: Subcommand = {
  description: "Verify yourself to unlock the server.",
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

// Manual override: a mod grants the Verified role directly (accessibility fallback
// for someone who genuinely can't read the image, or a trusted-user shortcut).
const userSub: Subcommand = {
  description: "Manually verify a member (grants the Verified role).",
  permission: PermissionFlagsBits.ManageGuild,
  options: (s) =>
    s.addUserOption((o) =>
      o.setName("member").setDescription("The member to verify").setRequired(true),
    ),
  async execute(interaction, ctx) {
    const guildId = interaction.guildId ?? ctx.env.guildId;
    if (!interaction.guild) {
      await interaction.reply({ content: "Run this in the server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const roleId = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
    if (!roleId) {
      await interaction.reply({
        content: "Verification isn't configured (no Verified role set).",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const target = interaction.options.getUser("member", true);
    if (target.bot) {
      await interaction.reply({ content: "Bots don't need verifying.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (memberHasRole(interaction.options.getMember("member")?.roles ?? null, roleId)) {
      await interaction.reply({ content: `<@${target.id}> is already verified.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await grantVerified(ctx, interaction.guild, target.id);
    if (!result.ok) {
      await interaction.editReply(result.left ? "That user isn't in this server." : result.msg);
      return;
    }
    deleteChallenge(ctx.db, guildId, target.id);
    endAllSessions(key(guildId, target.id));
    await interaction.editReply(`✅ Verified <@${target.id}>.`);
    await logMemberEvent(
      ctx,
      interaction.guild,
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("Member manually verified")
        .addFields(
          { name: "User", value: `<@${target.id}> (${target.id})` },
          { name: "By", value: `<@${interaction.user.id}>` },
        )
        .setTimestamp(new Date()),
    );
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

    const { build, expiresAt, mode } = await issueCaptcha(ctx, guildId, member.id, {});
    try {
      const dm = await member.createDM();
      const msg = await dm.send(build(true));
      // Remember which message holds the captcha so a restart can revive this DM in place.
      setChallengeDmMessage(ctx.db, guildId, member.id, msg.id);
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

// Clear a departing member's pending challenge/session so nothing lingers (and a
// kicked raider leaves no orphaned row).
const onLeave: Listener<Events.GuildMemberRemove> = {
  event: Events.GuildMemberRemove,
  async handle(ctx, member) {
    const guildId = member.guild.id;
    deleteChallenge(ctx.db, guildId, member.id);
    endAllSessions(key(guildId, member.id));
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
    // Works even if the current code expired — forceNew below starts a fresh challenge,
    // so tapping New Code always revives a timed-out captcha instead of dead-ending.
    if (!ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId)) {
      await button.reply({
        content: "Verification isn't set up. Contact a moderator.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isDm = button.guildId === null;
    const k = key(guildId, button.user.id);
    // Serialize with an in-flight code submission (onMessage holds the same lock): both rotate
    // the code and edit the same message, so overlapping them could leave the shown captcha
    // out of sync with the stored code. Drop the tap if busy (ack it so Discord doesn't error)
    // — checked BEFORE taking a render slot so a dropped tap doesn't mis-rate-limit a retry.
    if (processing.has(k)) {
      await button.deferUpdate().catch(() => {});
      return;
    }
    if (!takeRenderSlot(k)) {
      await button.reply({ content: "You're going too fast — wait a moment.", flags: MessageFlags.Ephemeral });
      return;
    }
    await button.deferUpdate();
    // Re-check after the deferUpdate await: a code submission could have taken the lock in the
    // meantime. This check and the add() below have no await between them, so acquisition is
    // atomic. (Dropping the tap here is fine — it's ack'd, and tapping again re-issues.)
    if (processing.has(k)) return;
    processing.add(k);
    try {
      const { build, expiresAt, mode } = await issueCaptcha(ctx, guildId, button.user.id, {
        forceNew: true,
      });
      // In a DM the captcha stays on this same message; keep the revive anchor pointed at it
      // (the row may be freshly created if the previous challenge had expired).
      if (isDm) setChallengeDmMessage(ctx.db, guildId, button.user.id, button.message.id);
      await button.editReply(build(isDm));
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
    } finally {
      processing.delete(k);
    }
  },
};

export const verificationModule: BotModule = {
  name: "verification",
  commands: [
    featureCommand({
      name: "verify",
      description: "Verify yourself, or manage verification.",
      subcommands: { me: meSub, panel: panelSub, user: userSub },
    }),
  ],
  listeners: [onJoin, onLeave, onMessage, onThreadCreate, onReady] as Listener[],
  components: [startHandler, newCodeHandler],
};
