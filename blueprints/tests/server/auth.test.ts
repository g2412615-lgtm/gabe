// Sign-in, the session cookie, the login throttle, the same-origin guard,
// fail-closed start-up, health, and the SPA/static serving rules.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken, sessionKey, shouldRenew, verifyToken } from "../../src/server/auth";
import { Client, PASSWORD, signedInClient, startTestServer, tempDir, type TestServer } from "./helpers";

const SECRET = "test-secret-test-secret-test-secret-0000";
/** What the test servers sign cookies with: the secret mixed with the password. */
const KEY = sessionKey(SECRET, PASSWORD, null);
const DAY = 86_400_000;

let server: TestServer;
let clientDir: string;

beforeAll(async () => {
  clientDir = tempDir("bpn-client-");
  fs.mkdirSync(path.join(clientDir, "assets"));
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>KWE Blueprints</title><div id=root></div>");
  fs.writeFileSync(path.join(clientDir, "assets", "app-3f9a.js"), "console.log('app')");
  fs.writeFileSync(path.join(clientDir, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  server = await startTestServer({ clientDir, render: false });
});

afterAll(async () => {
  await server?.stop();
  fs.rmSync(clientDir, { recursive: true, force: true });
});

describe("auth", () => {
  it("requires the session cookie on every API route except login and health", async () => {
    const c = new Client(server.url);
    for (const p of ["/api/plans", "/api/me", "/api/plans/abc", "/api/plans/abc/pages", "/api/sources/abc/original", "/api/pages/a/b/preview.webp"]) {
      const r = await c.get(p);
      expect(r.status, p).toBe(401);
      expect(r.json.error).toBe("Sign in to continue.");
    }
    expect((await c.post("/api/plans/abc/sync", { ops: [] })).status).toBe(401);
    expect((await c.post("/api/logout")).status).toBe(401);
    const h = await c.get("/api/health");
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ ok: true, checks: { database: "ok", storage: "ok" } });
    expect(typeof h.json.time).toBe("string");
  });

  it("rejects a wrong password with a plain message and signs in with the right one", async () => {
    const c = new Client(server.url);
    const bad = await c.login("nope");
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe("That password isn't right.");
    expect(c.cookie).toBe("");

    const ok = await c.login();
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^bpn_session=v2\.\d+\.\d+\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000$/);
    expect(setCookie).not.toMatch(/Secure/); // plain http here

    const me = await c.get("/api/me");
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ ok: true });
    expect(me.headers.get("cache-control")).toBe("no-store");
  });

  it("marks the cookie Secure behind an HTTPS proxy", async () => {
    const c = new Client(server.url);
    const r = await c.post("/api/login", { password: PASSWORD }, { "x-forwarded-proto": "https" });
    expect(r.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("refuses tampered, expired and malformed cookies", async () => {
    const c = await signedInClient(server);
    const good = c.cookie;
    for (const bad of [
      good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"),
      "bpn_session=v2.1.99999999999999.abc",
      "bpn_session=garbage",
      "bpn_session=",
      // the old cookie format (before sessions were tied to the password)
      `bpn_session=v1.${Date.now() + DAY}.${"0".repeat(64)}`,
    ]) {
      c.cookie = bad;
      expect((await c.get("/api/me")).status).toBe(401);
    }
    const expired = mintToken(KEY, Date.now() - 200 * DAY).token;
    expect(verifyToken(KEY, expired)).toBeNull();
    c.cookie = `bpn_session=${expired}`;
    expect((await c.get("/api/me")).status).toBe(401);
    // signed with the bare secret (not tied to the password): refused
    c.cookie = `bpn_session=${mintToken(SECRET).token}`;
    expect((await c.get("/api/me")).status).toBe(401);
  });

  it("renews a cookie that is more than a week old, keeping the sign-in time", async () => {
    const c = new Client(server.url);
    const signedIn = Date.now() - 10 * DAY;
    const old = mintToken(KEY, signedIn).token;
    c.cookie = `bpn_session=${old}`;
    const r = await c.get("/api/me");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/^bpn_session=v2\..*; Max-Age=15552000$/);
    expect(c.cookie).not.toBe(`bpn_session=${old}`);
    const renewed = verifyToken(KEY, c.cookie.slice("bpn_session=".length))!;
    expect(renewed.issuedAt).toBe(signedIn);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 179 * DAY);
    // a fresh cookie isn't re-issued on every request
    const again = await c.get("/api/me");
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("ends a sign-in after a year however often it was renewed", async () => {
    const c = new Client(server.url);
    // signed in 300 days ago, renewed 3 days ago: the renewal stopped at the one-year mark
    const signedIn = Date.now() - 300 * DAY;
    const renewed = mintToken(KEY, Date.now() - 3 * DAY, signedIn);
    expect(renewed.expiresAt).toBe(signedIn + 365 * DAY);
    c.cookie = `bpn_session=${renewed.token}`;
    const r = await c.get("/api/me");
    expect(r.status).toBe(200);
    // re-issuing could not push the expiry out, so it isn't
    expect(r.headers.get("set-cookie")).toBeNull();

    // past the year: refused, even though this token's own expiry is still ahead
    const longAgo = Date.now() - 366 * DAY;
    const forged = mintToken(KEY, longAgo + 300 * DAY, longAgo);
    expect(forged.expiresAt).toBe(longAgo + 365 * DAY);
    expect(verifyToken(KEY, forged.token)).toBeNull();
    c.cookie = `bpn_session=${forged.token}`;
    expect((await c.get("/api/me")).status).toBe(401);
  });

  it("renews about once a week, and not near the one-year limit", () => {
    const now = Date.now();
    const fresh = mintToken(KEY, now);
    expect(shouldRenew(fresh, now)).toBe(false);
    expect(shouldRenew(fresh, now + 6 * DAY)).toBe(false);
    expect(shouldRenew(fresh, now + 8 * DAY)).toBe(true);
    // 360 days in: the expiry is already pinned at the cap
    const late = mintToken(KEY, now + 359 * DAY, now);
    expect(late.expiresAt).toBe(now + 365 * DAY);
    expect(shouldRenew(late, now + 360 * DAY)).toBe(false);
  });

  it("signs every device out when the password changes", async () => {
    const dataDir = tempDir();
    const first = await startTestServer({ dataDir, sessionSecret: null, render: false });
    const kept = (await signedInClient(first)).cookie;
    await first.shutdown(1000);
    /** The signed-in device, talking to whichever server is running now. */
    const device = (s: TestServer) => Object.assign(new Client(s.url), { cookie: kept });

    // same password, restarted: still signed in (the secret is kept in DATA_DIR)
    const same = await startTestServer({ dataDir, sessionSecret: null, render: false });
    expect((await device(same).get("/api/me")).status).toBe(200);
    await same.shutdown(1000);

    const changed = await startTestServer({ dataDir, sessionSecret: null, password: "a brand new password", render: false });
    try {
      const c = device(changed);
      const r = await c.get("/api/me");
      expect(r.status).toBe(401);
      expect(r.json.error).toBe("Sign in to continue.");
      expect((await c.login("a brand new password")).status).toBe(200);
      expect((await c.get("/api/me")).status).toBe(200);
    } finally {
      await changed.stop();
    }
  });

  it("signs every device out when the password hash changes (same password, new salt)", () => {
    const a = sessionKey(SECRET, null, "scrypt:c2FsdA:aGFzaA");
    expect(sessionKey(SECRET, null, "scrypt:c2FsdA:aGFzaA")).toBe(a);
    expect(sessionKey(SECRET, null, "scrypt:b3RoZXI:aGFzaA")).not.toBe(a);
    // the hash wins over a plain password, as it does for sign-in
    expect(sessionKey(SECRET, "anything", "scrypt:c2FsdA:aGFzaA")).toBe(a);
    expect(sessionKey(SECRET, PASSWORD, null)).not.toBe(sessionKey(SECRET, "other", null));
    expect(sessionKey("another-secret-another-secret-0000", PASSWORD, null)).not.toBe(KEY);
  });

  it("logs out by clearing the cookie", async () => {
    const c = await signedInClient(server);
    const r = await c.post("/api/logout");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(r.headers.get("set-cookie")).toMatch(/^bpn_session=; .*Max-Age=0/);
    expect(c.cookie).toBe("");
    expect((await c.get("/api/me")).status).toBe(401);
  });
});

describe("same-origin guard", () => {
  it("refuses cross-site writes and allows same-origin ones", async () => {
    const c = await signedInClient(server);
    const host = new URL(server.url).host;
    const cases: [Record<string, string>, number][] = [
      [{ origin: "https://evil.example" }, 403],
      [{ origin: "null" }, 403],
      [{ "sec-fetch-site": "cross-site" }, 403],
      [{ "sec-fetch-site": "same-site", origin: `http://${host}` }, 403], // a sibling subdomain
      [{ "sec-fetch-site": "same-origin", origin: `http://${host}` }, 200],
      [{ "sec-fetch-site": "none" }, 200],
      [{}, 200], // scripts (curl) send neither header; they still need the cookie
    ];
    for (const [headers, status] of cases) {
      const r = await c.post("/api/me-not-a-route", {}, headers);
      // 403 comes from the guard; anything that passes reaches the router (404)
      expect(r.status, JSON.stringify(headers)).toBe(status === 403 ? 403 : 404);
      if (status === 403) expect(r.json.error).toBe("That request came from another site, so it was refused.");
    }
    // the guard covers sign-in too (no login CSRF)
    const anon = new Client(server.url);
    expect((await anon.post("/api/login", { password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    // reads are not affected
    expect((await c.get("/api/me", { "sec-fetch-site": "cross-site" })).status).toBe(200);
  });
});

describe("login throttle", () => {
  it("locks an address out after 10 wrong passwords, even for the right one", async () => {
    const s = await startTestServer({ render: false });
    try {
      const c = new Client(s.url);
      for (let i = 0; i < 10; i++) expect((await c.login("wrong")).status).toBe(401);
      const locked = await c.login();
      expect(locked.status).toBe(429);
      expect(locked.json.error).toBe("Too many tries — wait 15 minutes and try again.");
      expect(c.cookie).toBe("");
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("delays a failed attempt by about 400 ms", async () => {
    const c = new Client(server.url);
    const t = Date.now();
    await c.login("wrong-again");
    expect(Date.now() - t).toBeGreaterThanOrEqual(380);
  });
});

describe("fail closed", () => {
  it("answers 503 everywhere when no password is configured", async () => {
    const s = await startTestServer({ password: null, passwordHash: null, render: false });
    try {
      const c = new Client(s.url);
      for (const r of [await c.login("anything"), await c.get("/api/plans"), await c.get("/api/health")]) {
        expect(r.status).toBe(503);
        expect(r.json.error).toBe("The app isn't set up yet: no password is configured.");
      }
    } finally {
      await s.stop();
    }
  });

  it("accepts a scrypt APP_PASSWORD_HASH", async () => {
    // scripts/hash-password.mjs output for "harbor lights 42"
    const { execFileSync } = await import("node:child_process");
    const hash = execFileSync(process.execPath, [path.resolve("scripts/hash-password.mjs"), "harbor lights 42"], { encoding: "utf8" }).trim();
    const s = await startTestServer({ password: null, passwordHash: hash, render: false });
    try {
      const c = new Client(s.url);
      expect((await c.login("harbor lights 4")).status).toBe(401);
      expect((await c.login("harbor lights 42")).status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  it("generates and keeps a session secret when none is configured", async () => {
    const dataDir = tempDir();
    const s = await startTestServer({ dataDir, sessionSecret: null, render: false });
    const file = path.join(dataDir, ".session-secret");
    try {
      expect(fs.readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{96}$/);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const c = await signedInClient(s);
      expect((await c.get("/api/me")).status).toBe(200);
    } finally {
      await s.stop();
    }
  });
});

describe("static client", () => {
  it("serves index.html with security headers for app routes", async () => {
    const c = new Client(server.url);
    for (const p of ["/", "/plans/abc123", "/login?next=%2F", "/index.html"]) {
      const r = await c.get(p);
      expect(r.status, p).toBe(200);
      expect(r.text).toContain("<div id=root>");
      expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(r.headers.get("cache-control")).toBe("no-cache");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("referrer-policy")).toBe("same-origin");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  it("caches hashed bundles forever and 404s missing ones", async () => {
    const c = new Client(server.url);
    const js = await c.get("/assets/app-3f9a.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await c.get("/assets/missing-0000.js")).status).toBe(404);
    const icon = await c.get("/icon-192.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
  });

  it("never serves files outside the client folder", async () => {
    const c = new Client(server.url);
    for (const p of ["/..%2f..%2fapp.db", "/%2e%2e/%2e%2e/etc/passwd", "/.session-secret"]) {
      const r = await c.get(p);
      // falls back to the SPA shell — never the file
      expect(r.text).toContain("<div id=root>");
    }
  });

  it("answers unknown API routes with JSON 404", async () => {
    const c = await signedInClient(server);
    const r = await c.get("/api/nothing-here");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "That doesn't exist." });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
