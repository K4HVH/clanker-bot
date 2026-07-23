import { loadEnv } from "./core/env";
import { createClient } from "./core/client";
import type { AppContext } from "./core/context";
import { createLogger } from "./core/logger";
import { registerGuildCommands } from "./core/register-commands";
import { createDatabase } from "./db/index";
import { modules } from "./modules";
import { ConfigService, migrateConfig } from "./lib/config";
import { startScheduler } from "./lib/scheduler";

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const logger = createLogger(env.logLevel);

  const db = createDatabase(env.databasePath);
  migrateConfig(db);
  logger.info("database ready", { databasePath: env.databasePath });

  const config = new ConfigService(db);
  const ctx: AppContext = { db, logger, env, config };

  const registered = await registerGuildCommands(env, modules);
  logger.info("registered guild commands", { count: registered, guildId: env.guildId });

  const client = createClient(modules, ctx);
  const stopScheduler = startScheduler(ctx, client, env.schedulerPollIntervalMs);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    stopScheduler();
    await client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(env.token);
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: "error", msg: "fatal startup error", error: String(error) }),
  );
  process.exit(1);
});
