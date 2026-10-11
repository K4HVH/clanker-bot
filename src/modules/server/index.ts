import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { featureCommand } from "../../core/command";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler } from "../../core/module";
import { logModAlert } from "../../lib/modlog";
import { adoptSource } from "../../server/adopt";
import { type DiscordApi, restApi } from "../../server/api";
import { applyPlan, applySummary, planFor } from "../../server/apply";
import { readLive } from "../../server/live";
import { renderPlan } from "../../server/render";
import { type ServerSpec, validateSpec } from "../../server/spec";
import { SPECS } from "../../server/specs";
import { getSpecName, markApplied, setSpecName } from "../../server/state";

// /server: the server as code. Plan shows what applying the server's spec would change; the Apply
// button runs exactly that plan, refusing if the server changed since it was shown. Owner only:
// a plan can rewrite every permission on the server.

export interface ServerDeps {
  api: (guild: Guild) => DiscordApi;
  specs: Record<string, ServerSpec>;
}

const live: ServerDeps = { api: (guild) => restApi(guild.client.rest), specs: SPECS };

const APPLY = "server:apply";
const FINGERPRINT_CHARS = 32; // of 64: the button's id must fit Discord's 100 characters
const INLINE_MAX = 1900;

type OwnerInteraction = ChatInputCommandInteraction | ButtonInteraction;

async function ownerOnly(interaction: OwnerInteraction): Promise<boolean> {
  if (interaction.guild && interaction.user.id === interaction.guild.ownerId) return true;
  await interaction.reply({ content: "Only the server owner can use /server.", flags: MessageFlags.Ephemeral });
  return false;
}

// The spec this server follows: the one recorded on its first Apply, else the one asked for, else
// the only one in the image.
function specFor(ctx: AppContext, deps: ServerDeps, guildId: string, asked: string | null): { name: string; spec: ServerSpec } | string {
  const name = getSpecName(ctx.db, guildId) ?? asked ?? (Object.keys(deps.specs).length === 1 ? Object.keys(deps.specs)[0] : undefined);
  if (!name) return `Name a spec: ${Object.keys(deps.specs).join(", ") || "none in this build"}.`;
  const spec = deps.specs[name];
  return spec ? { name, spec } : `No spec named "${name}" in this build.`;
}

export async function planCommand(interaction: ChatInputCommandInteraction, ctx: AppContext, deps: ServerDeps = live): Promise<void> {
  if (!(await ownerOnly(interaction))) return;
  const guild = interaction.guild!;
  const chosen = specFor(ctx, deps, guild.id, interaction.options.getString("spec"));
  if (typeof chosen === "string") {
    await interaction.reply({ content: chosen, flags: MessageFlags.Ephemeral });
    return;
  }
  // Tests validate every spec before it ships; this catches an image built without them.
  const errors = validateSpec(chosen.spec);
  if (errors.length > 0) {
    await interaction.reply({
      content: `Spec "${chosen.name}" is invalid:\n${errors.map((e) => `- ${e}`).join("\n")}`.slice(0, 2000),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const deletions = interaction.options.getBoolean("deletions") ?? false;
  const prune = interaction.options.getBoolean("prune") ?? false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const plan = await planFor({ api: deps.api(guild), db: ctx.db, config: ctx.config, guildId: guild.id, spec: chosen.spec }, deletions, prune);
  const text = renderPlan(plan, chosen.spec);
  const header = `Spec **${chosen.name}**: ${plan.ops.length} change${plan.ops.length === 1 ? "" : "s"}.`;
  const inline = `${header}\n\`\`\`\n${text}\n\`\`\``;
  const components =
    plan.ops.length > 0
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${APPLY}:${plan.fingerprint.slice(0, FINGERPRINT_CHARS)}:${deletions ? 1 : 0}${prune ? 1 : 0}:${chosen.name}`)
              .setLabel(`Apply ${plan.ops.length} change${plan.ops.length === 1 ? "" : "s"}`)
              .setStyle(ButtonStyle.Danger),
          ),
        ]
      : [];
  await interaction.editReply(
    inline.length <= INLINE_MAX
      ? { content: inline, components }
      : { content: `${header} The plan is attached.`, files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "plan.txt" })], components },
  );
}

// Servers with an Apply running. A second click, or the Apply of a plan made mid-run, would plan
// against a half-built server whose fingerprint still matches and build everything again.
const applying = new Set<string>();

export async function applyButton(interaction: ButtonInteraction, ctx: AppContext, deps: ServerDeps = live): Promise<void> {
  if (!(await ownerOnly(interaction))) return;
  const guild = interaction.guild!;
  if (applying.has(guild.id)) {
    await interaction.reply({ content: "An apply is already running on this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  applying.add(guild.id);
  try {
    // The button goes the moment it's pressed, so it can't be pressed twice.
    await interaction.update({ content: "Applying...", components: [] });
    const [, , shown, flags = "", name] = interaction.customId.split(":");
    const spec = name ? deps.specs[name] : undefined;
    if (!spec) {
      await interaction.editReply({ content: `No spec named "${name}" in this build.`, components: [] });
      return;
    }
    const env = { api: deps.api(guild), db: ctx.db, config: ctx.config, guildId: guild.id, spec };
    const plan = await planFor(env, flags[0] === "1", flags[1] === "1");
    if (plan.fingerprint.slice(0, FINGERPRINT_CHARS) !== shown) {
      await interaction.editReply({ content: "The server changed since this plan. Run /server plan again.", components: [] });
      return;
    }
    setSpecName(ctx.db, guild.id, name!);
    const result = await applyPlan({ ...env, reason: `Server plan applied by ${interaction.user.username}` }, plan);
    markApplied(ctx.db, guild.id, Date.now());
    const summary = applySummary(result, plan, spec);
    await logModAlert(
      ctx,
      guild,
      new EmbedBuilder().setColor(0x5865f2).setTitle(`Applied server plan: ${result.done} change${result.done === 1 ? "" : "s"}.`),
    );
    await interaction.editReply(
      summary.length <= INLINE_MAX
        ? { content: summary, components: [] }
        : {
            content: `Applied ${result.done} change${result.done === 1 ? "" : "s"}. The rest, with what to do by hand, is attached.`,
            files: [new AttachmentBuilder(Buffer.from(summary, "utf8"), { name: "apply.txt" })],
            components: [],
          },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error("server apply failed", { guildId: guild.id, error: message });
    await interaction.editReply({ content: `Apply failed: ${message}`.slice(0, 2000), components: [] }).catch(() => {});
  } finally {
    applying.delete(guild.id);
  }
}

export async function adoptCommand(interaction: ChatInputCommandInteraction, ctx: AppContext, deps: ServerDeps = live): Promise<void> {
  if (!(await ownerOnly(interaction))) return;
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const snapshot = await readLive(deps.api(guild), guild.id, []);
  const name = getSpecName(ctx.db, guild.id) ?? "server";
  const source = adoptSource(snapshot, ctx.config.all(guild.id), name);
  await interaction.editReply({
    content: "A spec matching this server and the bot's settings. Commit it as `servers/<name>/index.ts`.",
    files: [new AttachmentBuilder(Buffer.from(source, "utf8"), { name: "index.ts" })],
  });
}

const applyHandler: ComponentHandler = {
  customId: APPLY,
  type: "button",
  match: "prefix",
  async handle(interaction, ctx) {
    await applyButton(interaction as ButtonInteraction, ctx);
  },
};

export const serverModule: BotModule = {
  name: "server",
  commands: [
    featureCommand({
      name: "server",
      description: "Plan and apply this server's spec.",
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      subcommands: {
        plan: {
          description: "Show what applying the server's spec would change.",
          options: (s) =>
            s
              .addBooleanOption((o) => o.setName("deletions").setDescription("Also delete what the spec no longer lists."))
              .addBooleanOption((o) => o.setName("prune").setDescription("Also delete roles and channels the spec doesn't name."))
              .addStringOption((o) =>
                o
                  .setName("spec")
                  .setDescription("The spec to follow, on a server's first plan.")
                  .addChoices(...Object.keys(SPECS).map((n) => ({ name: n, value: n }))),
              ),
          execute: (interaction, ctx) => planCommand(interaction, ctx),
        },
        adopt: {
          description: "Download a spec matching this server.",
          execute: (interaction, ctx) => adoptCommand(interaction, ctx),
        },
      },
    }),
  ],
  components: [applyHandler],
};
