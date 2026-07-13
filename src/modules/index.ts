import type { BotModule } from "../core/module";
import { automodModule } from "./automod";
import { configModule } from "./config";
import { guardsModule } from "./guards";
import { loggingModule } from "./logging";
import { moderationModule } from "./moderation";
import { pingModule } from "./ping";
import { tagsModule } from "./tags";
import { ticketsModule } from "./tickets";
import { verificationModule } from "./verification";
import { welcomeModule } from "./welcome";

// Modules are registered explicitly (no filesystem scanning) so Bun never has to
// glob at runtime, and the set of features is type-checked.
export const modules: BotModule[] = [
  pingModule,
  configModule,
  loggingModule,
  moderationModule,
  automodModule,
  verificationModule,
  guardsModule,
  ticketsModule,
  tagsModule,
  welcomeModule,
];
