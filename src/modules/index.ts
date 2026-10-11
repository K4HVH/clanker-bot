import type { BotModule } from "../core/module";
import { automodModule } from "./automod";
import { configModule } from "./config";
import { guardsModule } from "./guards";
import { helpModule } from "./help";
import { honeypotModule } from "./honeypot";
import { loggingModule } from "./logging";
import { memesModule } from "./memes";
import { moderationModule } from "./moderation";
import { privacyModule } from "./privacy";
import { publishModule } from "./publish";
import { rolesModule } from "./roles";
import { sayModule } from "./say";
import { serverModule } from "./server";
import { tagsModule } from "./tags";
import { ticketsModule } from "./tickets";
import { verificationModule } from "./verification";

// Modules are registered explicitly (no filesystem scanning) so Bun never has to
// glob at runtime, and the set of features is type-checked.
export const modules: BotModule[] = [
  configModule,
  loggingModule,
  moderationModule,
  // Honeypot before automod: the scan() early-return is what actually protects the trap channel,
  // but registering first also means the honeypot's synchronous claim runs before automod's scan.
  honeypotModule,
  automodModule,
  verificationModule,
  guardsModule,
  ticketsModule,
  tagsModule,
  sayModule,
  memesModule,
  serverModule,
  privacyModule,
  rolesModule,
  publishModule,
  helpModule,
];
