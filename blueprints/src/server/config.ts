// Server settings. `loadConfig()` reads the environment (production and
// `npm run dev`); tests build a config directly with `createApp({ ... })`,
// which starts from `defaultConfig()` and never looks at process.env, so a
// developer's shell can't leak into a test run.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PAGES_PER_FILE, MAX_UPLOAD_MB } from "../shared/constants";
import { consoleLogger, type Logger } from "./log";

export interface ServerConfig {
  port: number;
  /** Interface to listen on (undefined = all). */
  host?: string;
  /** Database, uploads, rendered pages, backups. */
  dataDir: string;
  /** The built SPA (vite build → dist/client). */
  clientDir: string;
  /** Plain password (APP_PASSWORD) — or use passwordHash. */
  password: string | null;
  /** scrypt:<salt b64url>:<hash b64url> from scripts/hash-password.mjs (APP_PASSWORD_HASH). Wins over `password`. */
  passwordHash: string | null;
  /** Cookie signing secret. Null → generated once and kept in DATA_DIR/.session-secret. */
  sessionSecret: string | null;
  env: "production" | "development" | "test";
  maxUploadBytes: number;
  maxPagesPerFile: number;
  /** A page render that runs longer than this is stopped and marked failed. */
  renderTimeoutMs: number;
  /** Opening an uploaded PDF to count its pages (inside a worker) may take this long. */
  inspectTimeoutMs: number;
  /** Start the render queue (tests that only exercise sync can switch it off). */
  render: boolean;
  /** Daily backups + purge timers (off in most tests; the functions are exported). */
  maintenance: boolean;
  /** Trust Fly-Client-IP / X-Forwarded-For for the login throttle (true on Fly). */
  trustProxy: boolean;
  log: Logger;
}

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Where the built client lives: next to dist/server in production
 * (dist/server/index.js → dist/client), two levels up from src/server in
 * development (tsx src/server/index.ts → dist/client).
 */
function defaultClientDir(): string {
  return import.meta.url.endsWith(".ts") ? path.resolve(here, "../../dist/client") : path.resolve(here, "../client");
}

export function defaultConfig(): ServerConfig {
  return {
    port: 8080,
    dataDir: path.resolve("data"),
    clientDir: defaultClientDir(),
    password: null,
    passwordHash: null,
    sessionSecret: null,
    env: "development",
    maxUploadBytes: MAX_UPLOAD_MB * 1024 * 1024,
    maxPagesPerFile: MAX_PAGES_PER_FILE,
    renderTimeoutMs: 180_000,
    inspectTimeoutMs: 60_000,
    render: true,
    maintenance: true,
    trustProxy: false,
    log: consoleLogger,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const base = defaultConfig();
  const port = Number(env.PORT);
  const nodeEnv = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  return {
    ...base,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : base.port,
    host: env.HOST || undefined,
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    clientDir: env.CLIENT_DIR ? path.resolve(env.CLIENT_DIR) : base.clientDir,
    password: env.APP_PASSWORD ? env.APP_PASSWORD : null,
    passwordHash: env.APP_PASSWORD_HASH ? env.APP_PASSWORD_HASH.trim() : null,
    sessionSecret: env.SESSION_SECRET ? env.SESSION_SECRET : null,
    env: nodeEnv,
    // Fly sets FLY_APP_NAME on every machine; its proxy overwrites Fly-Client-IP,
    // so the header can be trusted there and nowhere else.
    trustProxy: Boolean(env.FLY_APP_NAME) || env.TRUST_PROXY === "1",
  };
}
