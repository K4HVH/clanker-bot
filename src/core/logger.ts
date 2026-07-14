import type { LogLevel } from "../core/env";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel, sink: (line: string) => void = console.log): Logger {
  const min = ORDER[level];
  const emit = (l: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (ORDER[l] < min) return;
    sink(JSON.stringify({ level: l, msg, ...meta, time: new Date().toISOString() }));
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}
