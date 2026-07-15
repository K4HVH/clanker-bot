import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ContainerBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  SectionBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { AppContext } from "../../core/context";
import { CATEGORIES, type Setting, settingsByCategory } from "../../lib/config";

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A setting's description rendered as Discord "subtext" (small, muted) under its label, or
// null when it has none.
function subtext(s: Setting): TextDisplayBuilder | null {
  return s.description ? new TextDisplayBuilder().setContent(`-# ${s.description}`) : null;
}

// Text shown for a scalar (int/text) setting's current value.
function scalarText(setting: Setting, value: unknown): string {
  if (setting.type === "int") return `\`${String(value)}\``;
  const s = String(value ?? "");
  return s ? `\`${truncate(s)}\`` : "*(empty)*";
}

function navRow(currentCategoryId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder().setCustomId("cfg:cat").setPlaceholder("Category…");
  for (const c of CATEGORIES) {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(c.label)
        .setValue(c.id)
        .setDefault(c.id === currentCategoryId),
    );
  }
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function footerRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("cfg:export").setStyle(ButtonStyle.Secondary).setLabel("Export"),
    new ButtonBuilder().setCustomId("cfg:import").setStyle(ButtonStyle.Secondary).setLabel("Import"),
    new ButtonBuilder().setCustomId("cfg:reset").setStyle(ButtonStyle.Danger).setLabel("Reset"),
    new ButtonBuilder().setCustomId("cfg:close").setStyle(ButtonStyle.Secondary).setLabel("Close"),
  );
}

function categoryContainer(ctx: AppContext, guildId: string, categoryId: string): ContainerBuilder {
  const category = CATEGORIES.find((c) => c.id === categoryId);
  if (!category) throw new Error(`unknown category: ${categoryId}`);
  const container = new ContainerBuilder().setAccentColor(category.accentColor);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${category.label}`),
  );

  for (const s of settingsByCategory(categoryId)) {
    if (s.type === "bool") {
      const on = ctx.config.getEffective<boolean>(guildId, s.key);
      const section = new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${s.label}**`),
      );
      const sub = subtext(s);
      if (sub) section.addTextDisplayComponents(sub);
      section.setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`cfg:toggle:${s.key}`)
          .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setLabel(on ? "On" : "Off"),
      );
      container.addSectionComponents(section);
    } else if (s.type === "int" || s.type === "text") {
      const value = scalarText(s, ctx.config.getEffective(guildId, s.key));
      const section = new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${s.label}:** ${value}`),
      );
      const sub = subtext(s);
      if (sub) section.addTextDisplayComponents(sub);
      section.setButtonAccessory(
        new ButtonBuilder().setCustomId(`cfg:edit:${s.key}`).setStyle(ButtonStyle.Secondary).setLabel("Edit"),
      );
      container.addSectionComponents(section);
    } else if (s.type === "channel") {
      const id = ctx.config.get<string>(guildId, s.key);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${s.label}:** ${id ? `<#${id}>` : "*(not set)*"}`),
      );
      const sub = subtext(s);
      if (sub) container.addTextDisplayComponents(sub);
      const select = new ChannelSelectMenuBuilder()
        .setCustomId(`cfg:chan:${s.key}`)
        .setPlaceholder("Select a channel…")
        .setMinValues(0)
        .setMaxValues(1);
      if (s.channelTypes) select.setChannelTypes(s.channelTypes);
      if (id) select.setDefaultChannels(id);
      container.addActionRowComponents(
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select),
      );
    } else if (s.type === "choice") {
      const current = String(ctx.config.getEffective(guildId, s.key) ?? "");
      const chosen = s.choices?.find((c) => c.value === current);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${s.label}:** \`${chosen?.label ?? (current || "—")}\``),
      );
      const sub = subtext(s);
      if (sub) container.addTextDisplayComponents(sub);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`cfg:choice:${s.key}`)
        .setPlaceholder("Select…")
        .setMinValues(1)
        .setMaxValues(1);
      for (const c of s.choices ?? []) {
        select.addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(c.label)
            .setValue(c.value)
            .setDefault(c.value === current),
        );
      }
      container.addActionRowComponents(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      );
    } else if (s.type === "role") {
      const id = ctx.config.get<string>(guildId, s.key);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${s.label}:** ${id ? `<@&${id}>` : "*(not set)*"}`),
      );
      const sub = subtext(s);
      if (sub) container.addTextDisplayComponents(sub);
      const select = new RoleSelectMenuBuilder()
        .setCustomId(`cfg:role:${s.key}`)
        .setPlaceholder("Select a role…")
        .setMinValues(0)
        .setMaxValues(1);
      if (id) select.setDefaultRoles(id);
      container.addActionRowComponents(
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select),
      );
    }
  }
  return container;
}

// The full V2 component tree for a category page (nav select + container + footer).
export function buildPanel(ctx: AppContext, guildId: string, categoryId: string) {
  return [navRow(categoryId), categoryContainer(ctx, guildId, categoryId), footerRow()];
}

// Modal to edit a text/int setting, prefilled with the current value.
export function buildModal(setting: Setting, current: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId("val")
    .setLabel(truncate(setting.label, 45))
    .setStyle(setting.type === "text" ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setValue(current)
    .setRequired(setting.type === "int")
    .setMaxLength(setting.type === "int" ? 19 : 4000);
  if (setting.placeholder) input.setPlaceholder(truncate(setting.placeholder, 100));
  return new ModalBuilder()
    .setCustomId(`cfg:modal:${setting.key}`)
    .setTitle(truncate(setting.label, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}
