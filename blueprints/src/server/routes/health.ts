// GET /api/health — public, for an uptime monitor: 200 when the database
// answers and the data folder is writable with room to spare, else 503
// (storage "full": uploads and page renders are refused until storage is added).

import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AppDeps } from "../context";
import { SCHEMA_VERSION, userVersion } from "../db";
import { freeBytes } from "../storage";

export function healthRoutes(deps: AppDeps) {
  const r = new Hono();
  r.get("/health", (c) => {
    let database: "ok" | "error" = "error";
    try {
      deps.db.prepare("SELECT 1").get();
      database = userVersion(deps.db) === SCHEMA_VERSION ? "ok" : "error";
    } catch {
      /* reported below */
    }
    let storage: "ok" | "full" | "error" = "error";
    try {
      const probe = path.join(deps.config.dataDir, "tmp", `.health-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      storage = freeBytes(deps.config.dataDir) < deps.config.minFreeBytes ? "full" : "ok";
    } catch {
      /* reported below */
    }
    const ok = database === "ok" && storage === "ok";
    return c.json({ ok, checks: { database, storage }, time: new Date().toISOString() }, ok ? 200 : 503);
  });
  return r;
}
