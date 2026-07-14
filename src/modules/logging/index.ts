import { Events } from "discord.js";
import type { BotModule, Listener } from "../../core/module";
import {
  buildMemberJoinEmbed,
  buildMemberLeaveEmbed,
  buildMessageDeleteEmbed,
  buildMessageUpdateEmbed,
  logMemberEvent,
} from "../../lib/modlog";

const onDelete: Listener<Events.MessageDelete> = {
  event: Events.MessageDelete,
  async handle(ctx, message) {
    if (!message.guild || message.author?.bot) return;
    await logMemberEvent(
      ctx,
      message.guild,
      buildMessageDeleteEmbed({
        authorId: message.author?.id,
        channelId: message.channelId,
        content: message.content?.trim() ? message.content : "*(uncached or empty)*",
      }),
    );
  },
};

const onUpdate: Listener<Events.MessageUpdate> = {
  event: Events.MessageUpdate,
  async handle(ctx, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    const before = oldMessage.content ?? "";
    const after = newMessage.content ?? "";
    if (before === after) return;
    await logMemberEvent(
      ctx,
      newMessage.guild,
      buildMessageUpdateEmbed({
        authorId: newMessage.author?.id,
        channelId: newMessage.channelId,
        before: before.trim() ? before : "*(uncached or empty)*",
        after: after.trim() ? after : "*(empty)*",
      }),
    );
  },
};

const onJoin: Listener<Events.GuildMemberAdd> = {
  event: Events.GuildMemberAdd,
  async handle(ctx, member) {
    await logMemberEvent(
      ctx,
      member.guild,
      buildMemberJoinEmbed({ userId: member.id, createdAt: member.user.createdTimestamp }),
    );
  },
};

const onLeave: Listener<Events.GuildMemberRemove> = {
  event: Events.GuildMemberRemove,
  async handle(ctx, member) {
    await logMemberEvent(ctx, member.guild, buildMemberLeaveEmbed({ userId: member.id }));
  },
};

export const loggingModule: BotModule = {
  name: "logging",
  listeners: [onDelete, onUpdate, onJoin, onLeave] as Listener[],
};
