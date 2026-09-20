import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogger } from "../src/lib/logger.js";

test("emite JSON con nivel, app y mensaje", () => {
  const lines: string[] = [];
  const logger = createLogger({ appName: "tesis", logLevel: "info" }, (line) => lines.push(line));

  logger.info("hola", { id: 1 });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.level, "info");
  assert.equal(entry.app, "tesis");
  assert.equal(entry.message, "hola");
  assert.deepEqual(entry.meta, { id: 1 });
});

test("filtra los niveles por debajo del umbral", () => {
  const lines: string[] = [];
  const logger = createLogger({ appName: "tesis", logLevel: "warn" }, (line) => lines.push(line));

  logger.debug("no");
  logger.info("tampoco");
  logger.warn("sí");
  logger.error("también");

  assert.deepEqual(
    lines.map((line) => JSON.parse(line).level),
    ["warn", "error"],
  );
});

test("omite meta cuando no se pasa", () => {
  const lines: string[] = [];
  const logger = createLogger({ appName: "tesis", logLevel: "debug" }, (line) => lines.push(line));

  logger.debug("sin meta");

  assert.equal("meta" in JSON.parse(lines[0]!), false);
});
