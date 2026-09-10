import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";

test("usa valores por defecto cuando el entorno está vacío", () => {
  const config = loadConfig({});

  assert.equal(config.appName, "tesis");
  assert.equal(config.env, "development");
  assert.equal(config.logLevel, "info");
});

test("lee valores válidos del entorno", () => {
  const config = loadConfig({
    APP_NAME: "tesis-dev",
    NODE_ENV: "production",
    LOG_LEVEL: "debug",
  });

  assert.equal(config.appName, "tesis-dev");
  assert.equal(config.env, "production");
  assert.equal(config.logLevel, "debug");
});

test("descarta valores inválidos y cae al por defecto", () => {
  const config = loadConfig({ NODE_ENV: "staging", LOG_LEVEL: "verbose" });

  assert.equal(config.env, "development");
  assert.equal(config.logLevel, "info");
});
