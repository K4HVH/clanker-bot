import { REST, Routes } from "discord.js";
import type { Env } from "../core/env";
import type { BotModule } from "./module";

export function collectCommandData(modules: BotModule[]): unknown[] {
  return modules.flatMap((m) => m.commands ?? []).map((c) => c.data.toJSON());
}

export async function registerGuildCommands(env: Env, modules: BotModule[]): Promise<number> {
  const body = collectCommandData(modules);
  const rest = new REST().setToken(env.token);
  await rest.put(Routes.applicationGuildCommands(env.applicationId, env.guildId), { body });
  return body.length;
}
