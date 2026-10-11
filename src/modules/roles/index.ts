import { MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import type { AppContext } from "../../core/context";
import type { BotModule, ComponentHandler } from "../../core/module";
import { CONFIG_KEYS } from "../../lib/config";
import { idFor, specFor } from "../../server/runtime";
import type { ServerSpec } from "../../server/spec";
import { SPECS } from "../../server/specs";

// Role menus: a select per question in a spec's menu (custom id roles:<menu>:<question>). Picking gives
// the picked options' roles and takes the question's others. Only verified members can pick.

interface MenuMember {
  roles: { cache: { has(id: string): boolean }; add(id: string): Promise<unknown>; remove(id: string): Promise<unknown> };
}

export async function handleMenu(interaction: StringSelectMenuInteraction, ctx: AppContext, specs: Record<string, ServerSpec> = SPECS): Promise<void> {
  const guildId = interaction.guildId;
  const member = interaction.member as unknown as MenuMember | null;
  if (!guildId || !member) return;
  // Acknowledged at once: adding and removing roles can outlast the 3 seconds Discord gives a reply.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = (content: string) => interaction.editReply({ content });

  const verified = ctx.config.get<string>(guildId, CONFIG_KEYS.verifiedRoleId);
  if (verified && !member.roles.cache.has(verified)) {
    const channel = ctx.config.get<string>(guildId, CONFIG_KEYS.verificationChannelId);
    await reply(channel ? `Verify in <#${channel}> first.` : "Verify first.");
    return;
  }
  const [, menuKey, questionKey] = interaction.customId.split(":");
  const spec = specFor(ctx.db, guildId, specs);
  const question = spec?.menus?.find((m) => m.key === menuKey)?.questions.find((q) => q.key === questionKey);
  if (!spec || !question) {
    await reply("This menu is out of date.");
    return;
  }
  const picked = new Set(interaction.values);
  const added: string[] = [];
  const removed: string[] = [];
  for (const option of question.options) {
    const id = idFor(ctx.db, guildId, "role", option.role);
    if (!id) continue;
    const name = spec.roles.find((r) => r.key === option.role)?.name ?? option.label;
    const has = member.roles.cache.has(id);
    if (picked.has(option.role) && !has) {
      await member.roles.add(id);
      added.push(`${name} added`);
    } else if (!picked.has(option.role) && has) {
      await member.roles.remove(id);
      removed.push(`${name} removed`);
    }
  }
  const changes = [...added, ...removed];
  await reply(changes.length > 0 ? `Done: ${changes.join(", ")}.` : "No change.");
}

const menuHandler: ComponentHandler = {
  customId: "roles",
  type: "select",
  match: "prefix",
  async handle(interaction, ctx) {
    await handleMenu(interaction as StringSelectMenuInteraction, ctx);
  },
};

export const rolesModule: BotModule = {
  name: "roles",
  components: [menuHandler],
};
