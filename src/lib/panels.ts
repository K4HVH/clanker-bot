import { type APIActionRowComponent, type APIButtonComponent, type APIEmbed, ButtonStyle, ComponentType } from "discord.js";
import { CONFIG_KEYS, REGISTRY_BY_KEY } from "./config";

// The bot's panels: the ticket and captcha panels (an embed and the one button members press) and the
// honeypot's warning (a yellow embed). The panel commands and a spec's panel posts all build them here,
// so they match.
export type PanelKind = "ticket" | "verify" | "honeypot";

interface Panel {
  title?: string;
  color?: number;
  button?: { label: string; customId: string };
  setting: string;
}

export const PANELS: Record<PanelKind, Panel> = {
  ticket: { title: "Support", button: { label: "Open Ticket", customId: "ticket_open" }, setting: CONFIG_KEYS.ticketPanelText },
  verify: { title: "Server Verification", button: { label: "Verify", customId: "verify_start" }, setting: CONFIG_KEYS.verificationPanelText },
  honeypot: { color: 0xf1c40f, setting: CONFIG_KEYS.honeypotPanelText },
};

export function panelMessage(kind: PanelKind, text: string): { embeds: APIEmbed[]; components: APIActionRowComponent<APIButtonComponent>[] } {
  const p = PANELS[kind];
  const embed: APIEmbed = { description: text };
  if (p.title) embed.title = p.title;
  if (p.color !== undefined) embed.color = p.color;
  const components: APIActionRowComponent<APIButtonComponent>[] = p.button
    ? [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Success, custom_id: p.button.customId, label: p.button.label }] }]
    : [];
  return { embeds: [embed], components };
}

// Whether a message of the bot's is this panel: by its button, or for the honeypot by its colour.
export function isPanel(kind: PanelKind, m: { embeds?: { color?: number }[]; components?: { components?: { custom_id?: string }[] }[] }): boolean {
  const p = PANELS[kind];
  if (p.button) return !!m.components?.some((row) => row.components?.some((c) => c.custom_id === p.button!.customId));
  return !m.components?.length && m.embeds?.[0]?.color === p.color;
}

// The text a panel shows: the spec's setting, else the stored one, else the default.
export function panelText(kind: PanelKind, fromSpec: unknown, stored: unknown): string {
  for (const v of [fromSpec, stored]) if (typeof v === "string" && v !== "") return v;
  return String(REGISTRY_BY_KEY.get(PANELS[kind].setting)?.default ?? "");
}
