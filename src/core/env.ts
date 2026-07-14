export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Env {
  token: string;
  applicationId: string;
  guildId: string;
  databasePath: string;
  logLevel: LogLevel;
  schedulerPollIntervalMs: number;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function loadEnv(source: Record<string, string | undefined>): Env {
  const required = (name: string): string => {
    const value = source[name];
    if (!value || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  const level = source.LOG_LEVEL ?? "info";
  if (!LEVELS.includes(level as LogLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${level} (expected one of ${LEVELS.join(", ")})`);
  }

  const pollRaw = source.SCHEDULER_POLL_INTERVAL_MS ?? "30000";
  const schedulerPollIntervalMs = Number.parseInt(pollRaw, 10);
  if (!Number.isInteger(schedulerPollIntervalMs) || schedulerPollIntervalMs < 5000 || schedulerPollIntervalMs > 300_000) {
    throw new Error(`Invalid SCHEDULER_POLL_INTERVAL_MS: ${pollRaw} (expected 5000-300000)`);
  }

  return {
    token: required("DISCORD_TOKEN"),
    applicationId: required("DISCORD_APPLICATION_ID"),
    guildId: required("DISCORD_GUILD_ID"),
    databasePath: source.DATABASE_PATH ?? "./data/clanker.sqlite",
    logLevel: level as LogLevel,
    schedulerPollIntervalMs,
  };
}
