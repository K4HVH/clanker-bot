// The server tools over REST, from a checkout: preview a spec against any server, build a test
// server from it, or generate a spec from a live server. Production changes go through /server.
//
//   bun run server plan  --guild <id> [--spec medius] [--db ./data/local-server.sqlite] [--deletions] [--prune]
//   bun run server apply --guild <id> [--spec medius] [--db ...] [--deletions]
//   bun run server adopt --guild <id> [--name medius] > servers/medius/index.ts
//
// plan and adopt only read. The database holds this checkout's key-to-id state and bot settings
// for test servers; it is never the production bot's.

import { REST } from "discord.js";
import { createDatabase } from "../src/db/index";
import { ConfigService } from "../src/lib/config";
import { adoptSource } from "../src/server/adopt";
import { restApi } from "../src/server/api";
import { applyPlan, applySummary, planFor } from "../src/server/apply";
import { assertNotProduction } from "../src/server/guard";
import { readLive } from "../src/server/live";
import { countText, renderPlan } from "../src/server/render";
import { SPECS } from "../src/server/specs";
import { markApplied, setSpecName } from "../src/server/state";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const guildId = flag("guild");
  const token = process.env.DISCORD_TOKEN;
  if (!command || !["plan", "apply", "adopt"].includes(command) || !guildId) {
    throw new Error("usage: bun run server plan|apply|adopt --guild <id> [--spec <name>] [--db <path>] [--deletions]");
  }
  if (!token) throw new Error("DISCORD_TOKEN is not set (bun loads .env from the working directory)");
  const api = restApi(new REST().setToken(token));

  if (command === "adopt") {
    const live = await readLive(api, guildId, []);
    process.stdout.write(adoptSource(live, {}, flag("name") ?? "server"));
    return;
  }

  const specName = flag("spec") ?? (Object.keys(SPECS).length === 1 ? Object.keys(SPECS)[0] : undefined);
  const spec = specName ? SPECS[specName] : undefined;
  if (!spec) throw new Error(`name a spec with --spec: ${Object.keys(SPECS).join(", ") || "none in this checkout"}`);
  if (command === "apply") assertNotProduction(guildId, process.env);

  const db = createDatabase(flag("db") ?? "./data/local-server.sqlite");
  const env = { api, db, config: new ConfigService(db), guildId, spec };
  const deletions = process.argv.includes("--deletions");
  const plan = await planFor(env, deletions, process.argv.includes("--prune"));
  console.log(renderPlan(plan, spec));
  console.log(`\nfingerprint ${plan.fingerprint.slice(0, 32)}, ${countText(plan)}`);
  if (command === "apply") {
    // As /server's Apply does: the server follows this spec, so the bot's spec-driven features
    // (publishing, menus, panels) know its channels.
    setSpecName(db, guildId, specName!);
    if (plan.ops.length > 0) {
      const result = await applyPlan({ ...env, reason: "Server plan applied from a checkout" }, plan);
      markApplied(db, guildId, Date.now());
      console.log(`\n${applySummary(result, plan, spec)}`);
      if (result.failed) process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
