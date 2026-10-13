// POST /api/login, POST /api/logout, GET /api/me

import { Hono } from "hono";
import { clientIp, cookieMaxAge, mintToken, sessionCookie } from "../auth";
import type { AppDeps } from "../context";
import { HttpError, isRecord, readJson } from "../http";

const FAILURE_DELAY_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function authRoutes(deps: AppDeps) {
  const r = new Hono();

  r.post("/login", async (c) => {
    const ip = clientIp(c, deps.config.trustProxy);
    if (deps.throttle.isLocked(ip)) throw new HttpError(429, "Too many tries — wait 15 minutes and try again.");
    const body = await readJson(c, 4096);
    const password = isRecord(body) && typeof body.password === "string" ? body.password : "";
    const ok = password.length > 0 && password.length <= 1024 && (await deps.password.check(password));
    if (!ok) {
      deps.throttle.fail(ip);
      await sleep(FAILURE_DELAY_MS); // slows guessing; the owner barely notices
      throw new HttpError(401, "That password isn't right.");
    }
    deps.throttle.succeed(ip);
    const now = Date.now();
    const session = mintToken(deps.secret, now);
    c.header("Set-Cookie", sessionCookie(c, session.token, cookieMaxAge(session, now)));
    return c.json({ ok: true });
  });

  r.post("/logout", (c) => {
    c.header("Set-Cookie", sessionCookie(c, "", 0));
    return c.json({ ok: true });
  });

  // The auth gate in app.ts has already checked the cookie.
  r.get("/me", (c) => c.json({ ok: true }));

  return r;
}
