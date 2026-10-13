// Builds the whole server: database, auth gate, API routes, render queue,
// housekeeping and the SPA. `createApp()` is what tests use (temp DATA_DIR,
// random port via `startServer`); src/server/index.ts runs it for real.

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import {
  cookieMaxAge,
  isSameOrigin,
  LoginThrottle,
  mintToken,
  passwordChecker,
  readSessionCookie,
  resolveSessionSecret,
  sessionCookie,
  sessionKey,
  shouldRenew,
  verifyToken,
  type Session,
} from "./auth";
import { defaultConfig, type ServerConfig } from "./config";
import type { AppDeps } from "./context";
import { openDatabase, type Db } from "./db";
import { HttpError, MSG } from "./http";
import { clearTmp, startMaintenance } from "./maintenance";
import { RenderQueue } from "./render/queue";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { pageRoutes } from "./routes/pages";
import { planRoutes } from "./routes/plans";
import { serveClient } from "./static";
import { isStorageFull, STORAGE_FULL } from "./storage";

export interface AppHandle {
  app: Hono;
  config: ServerConfig;
  db: Db;
  queue: RenderQueue;
  /** Stop the queue (current page gets `graceMs` to finish), timers, and close the database. */
  close(graceMs?: number): Promise<void>;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Routes reachable without signing in. */
const PUBLIC_API = new Set(["/api/login", "/api/health"]);
/** Rendered page images: too many to log one line each. */
const ASSET_PATH = /^\/api\/pages\/[^/]+\/[^/]+\/(preview\.webp|thumb\.webp|tiles\/)/;

export function createApp(input: Partial<ServerConfig> = {}): AppHandle {
  const config: ServerConfig = { ...defaultConfig(), ...input };
  const { dataDir, log } = config;
  for (const dir of ["uploads", "assets", "tmp", "backups"]) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
  clearTmp(dataDir);

  const db = openDatabase(path.join(dataDir, "app.db"));
  const queue = new RenderQueue({ db, dataDir, timeoutMs: config.renderTimeoutMs, minFreeBytes: config.minFreeBytes, log });
  const deps: AppDeps = {
    config,
    db,
    queue,
    password: passwordChecker(config.password, config.passwordHash),
    throttle: new LoginThrottle(),
    // tied to the password: changing it signs every device out
    secret: sessionKey(resolveSessionSecret(config.sessionSecret, dataDir), config.password, config.passwordHash),
    kickRender: () => {
      if (config.render) queue.kick();
    },
  };
  if (!deps.password.configured) log.error("No APP_PASSWORD or APP_PASSWORD_HASH is set: every API request will answer 503 until one is.");
  if (config.sessionSecret && config.sessionSecret.length < 32) log.error("SESSION_SECRET is shorter than 32 characters — use a long random value.");

  const app = new Hono();

  // One log line per request (rendered page images excepted).
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const p = c.req.path;
    if (ASSET_PATH.test(p) || p.startsWith("/assets/")) return;
    log.info(`${c.req.method} ${p} ${c.res.status} ${Math.round(performance.now() - started)}ms`);
  });

  // The API gate: fail closed without a password, same-origin writes only, a valid session cookie.
  app.use("/api/*", async (c, next) => {
    if (!deps.password.configured) throw new HttpError(503, MSG.notConfigured);
    if (!SAFE_METHODS.has(c.req.method) && !isSameOrigin(c)) throw new HttpError(403, MSG.crossSite);
    let renew: Session | null = null;
    if (!PUBLIC_API.has(c.req.path)) {
      const session = verifyToken(deps.secret, readSessionCookie(c));
      if (!session) throw new HttpError(401, MSG.signIn);
      if (shouldRenew(session) && c.req.path !== "/api/logout") renew = session;
    }
    await next();
    // Keep a device that's in use signed in: re-issue the cookie about once a
    // week (same sign-in time, so the one-year limit still applies).
    if (renew && c.res.status < 400) {
      const renewed = mintToken(deps.secret, Date.now(), renew.issuedAt);
      c.res.headers.append("Set-Cookie", sessionCookie(c, renewed.token, cookieMaxAge(renewed)));
    }
    if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  });

  app.route("/api", authRoutes(deps));
  app.route("/api", healthRoutes(deps));
  app.route("/api", planRoutes(deps));
  app.route("/api", pageRoutes(deps));
  app.all("/api/*", () => {
    throw new HttpError(404, MSG.notFound);
  });

  const client = serveClient(config.clientDir);
  app.get("*", (c) => client(c));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status, { "Cache-Control": "no-store" });
    log.error(`${c.req.method} ${c.req.path} failed`, err);
    // a full disk deserves a message that says so (the editor keeps unsaved work and retries)
    if (isStorageFull(err)) return c.json({ error: STORAGE_FULL.other }, 507, { "Cache-Control": "no-store" });
    return c.json({ error: MSG.serverError }, 500, { "Cache-Control": "no-store" });
  });
  app.notFound((c) => c.json({ error: MSG.notFound }, 404, { "Cache-Control": "no-store" }));

  if (config.render) {
    queue.recover();
    queue.kick();
  }
  const maintenance = config.maintenance ? startMaintenance(db, dataDir, log) : null;

  let closed = false;
  return {
    app,
    config,
    db,
    queue,
    async close(graceMs = 10_000) {
      if (closed) return;
      closed = true;
      maintenance?.stop();
      await queue.stop(graceMs);
      db.close();
    },
  };
}

export interface RunningServer extends AppHandle {
  server: ServerType;
  port: number;
  url: string;
  /** Stop accepting connections, then close the app. */
  shutdown(graceMs?: number): Promise<void>;
}

/** Create the app and listen (port 0 = a free random port, for tests). */
export function startServer(input: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const handle = createApp(input);
  return new Promise((resolve, reject) => {
    const server = serve({
      fetch: handle.app.fetch,
      port: handle.config.port,
      hostname: handle.config.host,
      // A 150 MB upload over stadium Wi-Fi can take a while; Node's default is 5 minutes.
      serverOptions: { requestTimeout: 30 * 60_000 },
    });
    server.once("error", reject);
    server.once("listening", () => {
      const port = (server.address() as AddressInfo).port;
      const shutdown = async (graceMs = 10_000) => {
        await new Promise<void>((done) => {
          server.close(() => done());
          // idle keep-alive sockets would hold close() open
          (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
        });
        await handle.close(graceMs);
      };
      resolve({ ...handle, server, port, url: `http://localhost:${port}`, shutdown });
    });
  });
}
