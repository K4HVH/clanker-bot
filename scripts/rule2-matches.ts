// Lists messages already in a server that a spec's AutoMod rule would block, for staff to judge.
// Reads only: it fetches channel histories and deletes nothing.
//
//   bun run scripts/rule2-matches.ts --guild <id> [--spec medius] [--rule rule-2]

import { REST } from "discord.js";
import { restApi } from "../src/server/api";
import { ruleMatches } from "../src/server/automod-match";
import { SPECS } from "../src/server/specs";

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Message {
  id: string;
  content: string;
  timestamp: string;
  author: { username: string; bot?: boolean };
}

async function main(): Promise<void> {
  const guildId = flag("guild");
  if (!guildId) throw new Error("usage: bun run scripts/rule2-matches.ts --guild <id> [--spec medius] [--rule rule-2]");
  const rule = SPECS[flag("spec") ?? "medius"]?.automod.find((r) => r.key === (flag("rule") ?? "rule-2"));
  if (!rule) throw new Error("no such spec or rule");
  const api = restApi(new REST().setToken(process.env.DISCORD_TOKEN ?? ""));
  const channels = await api.get<{ id: string; name: string; type: number }[]>(`/guilds/${guildId}/channels`);
  const hits: string[] = [];
  for (const channel of channels.filter((c) => c.type === 0 || c.type === 5)) {
    let before: string | undefined;
    for (;;) {
      const page = await api
        .get<Message[]>(`/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ""}`)
        .catch(() => [] as Message[]);
      if (page.length === 0) break;
      for (const m of page) {
        if (m.author.bot || !ruleMatches(rule, m.content)) continue;
        const text = m.content.replace(/\s+/g, " ").slice(0, 120);
        hits.push(`#${channel.name}  ${m.timestamp.slice(0, 10)}  https://discord.com/channels/${guildId}/${channel.id}/${m.id}  ${text}`);
      }
      before = page[page.length - 1]!.id;
    }
  }
  console.log(hits.length ? hits.join("\n") : "No matches.");
  console.log(`\n${hits.length} message${hits.length === 1 ? "" : "s"} would be blocked by "${rule.name}".`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
