/**
 * Configuración del proyecto, leída del entorno con valores por defecto.
 */
export type Config = {
  appName: string;
  env: "development" | "test" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
};

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const ENVS = ["development", "test", "production"] as const;

function pick<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  return allowed.includes(value ?? "") ? (value as T[number]) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    appName: env.APP_NAME?.trim() || "tesis",
    env: pick(env.NODE_ENV, ENVS, "development"),
    logLevel: pick(env.LOG_LEVEL, LOG_LEVELS, "info"),
  };
}
