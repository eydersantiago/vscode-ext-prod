import { loadConfig } from "./config.js";
import { createLogger } from "./lib/logger.js";

export function main(): void {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info("proyecto tesis iniciado", { env: config.env });
}

// Solo ejecuta al invocarse como entrypoint, no al importarse desde los tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
