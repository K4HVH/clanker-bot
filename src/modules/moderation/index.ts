import type { BotModule } from "../../core/module";
import { banCommand } from "./ban";
import { caseCommand } from "./case";
import { historyCommand } from "./history";
import { kickCommand } from "./kick";
import { noteCommand } from "./note";
import { timeoutCommand } from "./timeout";
import { unbanCommand } from "./unban";
import { warnCommand } from "./warn";

export const moderationModule: BotModule = {
  name: "moderation",
  commands: [
    warnCommand,
    noteCommand,
    timeoutCommand,
    kickCommand,
    banCommand,
    unbanCommand,
    caseCommand,
    historyCommand,
  ],
};
