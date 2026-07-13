import type { BotModule } from "../core/module";
import { configModule } from "./config";
import { pingModule } from "./ping";

// Modules are registered explicitly (no filesystem scanning) so Bun never has to
// glob at runtime, and the set of features is type-checked.
export const modules: BotModule[] = [pingModule, configModule];
