import { type ButtonInteraction, MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { AppContext } from "./context";
import type { ComponentHandler } from "./module";

export class ComponentRouter {
  private readonly handlers = new Map<string, ComponentHandler>();

  constructor(
    handlers: ComponentHandler[],
    private readonly ctx: AppContext,
  ) {
    for (const h of handlers) this.handlers.set(`${h.type}:${h.customId}`, h);
  }

  async handle(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<void> {
    const type = interaction.isButton() ? "button" : "modal";
    const handler = this.handlers.get(`${type}:${interaction.customId}`);
    if (!handler) return;
    try {
      await handler.handle(interaction, this.ctx);
    } catch (error) {
      this.ctx.logger.error("component failed", {
        customId: interaction.customId,
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
