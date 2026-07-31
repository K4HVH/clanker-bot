import {
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import type { AppContext } from "./context";
import type { SlashCommand } from "./module";

// One action under a feature command. Discord only supports a command-level default
// permission, so `permission` is enforced at RUNTIME per subcommand: that's what lets
// a single `/mod` carry per-verb gates (ban→BanMembers, warn→ModerateMembers, …).
export interface Subcommand {
  description: string;
  permission?: bigint;
  options?: (sub: SlashCommandSubcommandBuilder) => SlashCommandSubcommandBuilder;
  execute(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
}

// Build a guild-only feature command `/<name> <action>` from a map of subcommands.
// Every module wires its commands through this, so command setup is identical
// across the codebase and adding an action is one entry.
export function featureCommand(opts: {
  name: string;
  description: string;
  // Command-level visibility gate. Omit to make the command visible to everyone
  // (use per-subcommand `permission` for the actual enforcement). Admins can still
  // override any of this in Discord's Integrations UI.
  defaultMemberPermissions?: bigint;
  subcommands: Record<string, Subcommand>;
}): SlashCommand {
  const builder = new SlashCommandBuilder()
    .setName(opts.name)
    .setDescription(opts.description)
    .setContexts(InteractionContextType.Guild);
  if (opts.defaultMemberPermissions !== undefined) {
    builder.setDefaultMemberPermissions(opts.defaultMemberPermissions);
  }
  for (const [name, sub] of Object.entries(opts.subcommands)) {
    builder.addSubcommand((s) => {
      s.setName(name).setDescription(sub.description);
      return sub.options ? sub.options(s) : s;
    });
  }

  return {
    data: builder,
    async execute(interaction, ctx) {
      const sub = opts.subcommands[interaction.options.getSubcommand()];
      if (!sub) {
        await interaction.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub.permission !== undefined && !interaction.memberPermissions?.has(sub.permission)) {
        await interaction.reply({
          content: "You don't have permission to use that.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await sub.execute(interaction, ctx);
    },
  };
}
