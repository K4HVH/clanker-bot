import type { Env } from "../config/env";
import type { BotDatabase } from "../db/client";
import type { ConfigService } from "../services/config.service";
import type { Logger } from "./logger";

export interface AppContext {
  db: BotDatabase;
  logger: Logger;
  env: Env;
  config: ConfigService;
}
