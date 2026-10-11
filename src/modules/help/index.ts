import {
  type ChatInputCommandInteraction,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ThreadChannel,
} from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, Listener, SlashCommand } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { formatAnswers, rankAnswers, type SiteIndex, siteIndex } from "../../lib/help-answers";
import { channelSpecFor } from "../../server/runtime";
import type { ServerSpec } from "../../server/spec";
import { SPECS } from "../../server/specs";

// The help forum: /solved closes a post as answered, and a new post gets matching answers from the
// site's Help page. Both follow the forum's settings in the server's spec.

interface ForumThread {
  id: string;
  parentId: string | null;
  ownerId: string | null;
  appliedTags: string[];
  parent: { availableTags: { id: string; name: string }[] } | null;
  edit(o: { appliedTags?: string[]; archived?: boolean }): Promise<unknown>;
}

export async function markSolved(interaction: ChatInputCommandInteraction, ctx: AppContext, specs: Record<string, ServerSpec> = SPECS): Promise<void> {
  const thread = interaction.channel as unknown as ForumThread | null;
  const guildId = interaction.guildId;
  const forum = guildId && thread?.parentId ? channelSpecFor(ctx.db, guildId, thread.parentId, specs)?.forum : undefined;
  const solved = forum?.solvedTag ? thread?.parent?.availableTags.find((t) => t.name === forum.solvedTag) : undefined;
  if (!thread || !solved) {
    await interaction.reply({ content: "/solved works inside a help post.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (thread.ownerId !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)) {
    await interaction.reply({ content: "Only whoever started this post, or staff, can mark it solved.", flags: MessageFlags.Ephemeral });
    return;
  }
  // A post holds at most 5 tags: Solved takes the last place if it's full.
  const tags = [...thread.appliedTags.filter((t) => t !== solved.id).slice(0, 4), solved.id];
  await interaction.reply({ content: "Marked solved. Post here again to reopen it." });
  await thread.edit({ appliedTags: tags, archived: true });
}

interface NewPost {
  id: string;
  guildId: string;
  parentId: string | null;
  name: string;
  fetchStarterMessage(): Promise<{ content: string } | null>;
  send(o: { content: string }): Promise<unknown>;
}

export async function answerPost(
  ctx: AppContext,
  thread: NewPost,
  specs: Record<string, ServerSpec> = SPECS,
  loadIndex: (url: string) => Promise<SiteIndex | null> = (url) => siteIndex(url),
): Promise<void> {
  if (!thread.parentId || !channelSpecFor(ctx.db, thread.guildId, thread.parentId, specs)?.forum?.answers) return;
  const index = await loadIndex(ctx.config.getEffective<string>(thread.guildId, CONFIG_KEYS.helpIndexUrl));
  if (!index) return;
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const answers = rankAnswers(index, `${thread.name}\n${starter?.content ?? ""}`);
  if (answers.length > 0) await thread.send({ content: formatAnswers(answers) });
}

const solvedCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("solved")
    .setDescription("Mark this help post solved and close it.")
    .setContexts(InteractionContextType.Guild),
  execute: (interaction, ctx) => markSolved(interaction, ctx),
};

const onThreadCreate: Listener<Events.ThreadCreate> = {
  event: Events.ThreadCreate,
  async handle(ctx, thread, newlyCreated) {
    if (!newlyCreated) return;
    await answerPost(ctx, thread as unknown as ThreadChannel & NewPost);
  },
};

export const helpModule: BotModule = {
  name: "help",
  commands: [solvedCommand],
  listeners: [onThreadCreate] as Listener[],
};
