// Entry point.
//   development: tsx src/server/index.ts            (scripts/dev.mjs runs it on :8787)
//   production:  node dist/server/index.js          (bundled by scripts/build-server.mjs)
// Imported (by tests), it only exports; run directly, it starts the server.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./app";
import { loadConfig } from "./config";

export { createApp, startServer, type AppHandle, type RunningServer } from "./app";
export { loadConfig, defaultConfig, type ServerConfig } from "./config";

function runDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return fs.realpathSync(script) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const config = loadConfig();
  const running = await startServer(config);
  config.log.info(`KWE Blueprints listening on port ${running.port} (data in ${config.dataDir})`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    config.log.info(`${signal}: shutting down`);
    // Hard deadline in case something refuses to close.
    setTimeout(() => process.exit(1), 15_000).unref();
    running
      .shutdown(10_000)
      .then(() => process.exit(0))
      .catch((e) => {
        config.log.error("shutdown failed", e);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

if (runDirectly()) {
  main().catch((e) => {
    console.error("KWE Blueprints failed to start:", e);
    process.exit(1);
  });
}
