import type { Env } from "../core/env";
import type { BotDatabase } from "../db/index";
import type { ConfigService } from "../lib/config";
import type { Logger } from "./logger";

export interface AppContext {
  db: BotDatabase;
  logger: Logger;
  env: Env;
  config: ConfigService;
}
