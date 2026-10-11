import { type APIActionRowComponent, type APIButtonComponent, type APIEmbed, ButtonStyle, ComponentType } from "discord.js";
import { CONFIG_KEYS, REGISTRY_BY_KEY } from "./config";

// The ticket and captcha panels: an embed and the one button members press. `/ticket panel`,
// `/verify panel` and a spec's panel posts all build them here, so they match.
export type PanelKind = "ticket" | "verify";

export const PANELS: Record<PanelKind, { title: string; button: string; customId: string; setting: string }> = {
  ticket: { title: "Support", button: "Open Ticket", customId: "ticket_open", setting: CONFIG_KEYS.ticketPanelText },
  verify: { title: "Server Verification", button: "Verify", customId: "verify_start", setting: CONFIG_KEYS.verificationPanelText },
};

export function panelMessage(kind: PanelKind, text: string): { embeds: APIEmbed[]; components: APIActionRowComponent<APIButtonComponent>[] } {
  const p = PANELS[kind];
  return {
    embeds: [{ title: p.title, description: text }],
    components: [
      { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Success, custom_id: p.customId, label: p.button }] },
    ],
  };
}

// The text a panel shows: the spec's setting, else the stored one, else the default.
export function panelText(kind: PanelKind, fromSpec: unknown, stored: unknown): string {
  for (const v of [fromSpec, stored]) if (typeof v === "string" && v !== "") return v;
  return String(REGISTRY_BY_KEY.get(PANELS[kind].setting)?.default ?? "");
}
