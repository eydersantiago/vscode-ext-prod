import type { Config } from "../config.js";

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type Logger = {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
};

export function createLogger(
  config: Pick<Config, "appName" | "logLevel">,
  sink: (line: string) => void = (line) => console.log(line),
): Logger {
  const threshold = ORDER[config.logLevel];

  const emit = (level: keyof typeof ORDER) => (message: string, meta?: unknown) => {
    if (ORDER[level] < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      app: config.appName,
      message,
      ...(meta === undefined ? {} : { meta }),
    };
    sink(JSON.stringify(entry));
  };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
