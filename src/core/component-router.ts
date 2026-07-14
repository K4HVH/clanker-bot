import {
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import type { AppContext } from "./context";
import type { ComponentHandler } from "./module";

type Interaction = MessageComponentInteraction | ModalSubmitInteraction;

export class ComponentRouter {
  private readonly exact = new Map<string, ComponentHandler>();
  private readonly prefix: ComponentHandler[] = [];

  constructor(
    handlers: ComponentHandler[],
    private readonly ctx: AppContext,
  ) {
    for (const h of handlers) {
      if (h.match === "prefix") this.prefix.push(h);
      else this.exact.set(`${h.type}:${h.customId}`, h);
    }
  }

  private static typeOf(interaction: Interaction): "button" | "modal" | "select" {
    if (interaction.isButton()) return "button";
    if (interaction.isModalSubmit()) return "modal";
    return "select";
  }

  async handle(interaction: Interaction): Promise<void> {
    const type = ComponentRouter.typeOf(interaction);
    const id = interaction.customId;
    const handler =
      this.exact.get(`${type}:${id}`) ??
      this.prefix.find(
        (h) => h.type === type && (id === h.customId || id.startsWith(`${h.customId}:`)),
      );
    if (!handler) return;

    try {
      await handler.handle(interaction, this.ctx);
    } catch (error) {
      this.ctx.logger.error("component failed", {
        customId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!interaction.replied && !interaction.deferred && !interaction.isModalSubmit()) {
        await interaction
          .reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  }
}
