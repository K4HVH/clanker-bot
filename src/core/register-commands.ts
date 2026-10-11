import { type REST, Routes } from "discord.js";
import type { BotModule } from "./module";

export function collectCommandData(modules: BotModule[]): unknown[] {
  return modules
    .flatMap((m) => [...(m.commands ?? []), ...(m.contextCommands ?? [])])
    .map((c) => c.data.toJSON());
}

// Guild commands, not global ones: they appear in a guild at once, where global commands can take
// an hour. Called for every guild the bot is in, so a server set up from a spec has /server too.
export async function registerGuildCommands(
  rest: Pick<REST, "put">,
  applicationId: string,
  guildId: string,
  modules: BotModule[],
): Promise<number> {
  const body = collectCommandData(modules);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
  return body.length;
}
