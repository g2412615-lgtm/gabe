// Sign-in, the session cookie, the login throttle, the same-origin guard,
// fail-closed start-up, health, and the SPA/static serving rules.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken, verifyToken } from "../../src/server/auth";
import { Client, PASSWORD, signedInClient, startTestServer, tempDir, type TestServer } from "./helpers";

let server: TestServer;
let clientDir: string;

beforeAll(async () => {
  clientDir = tempDir("bpn-client-");
  fs.mkdirSync(path.join(clientDir, "assets"));
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>Blueprint Notes</title><div id=root></div>");
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
    expect(setCookie).toMatch(/^bpn_session=v1\.\d+\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000$/);
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
    for (const bad of [good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), "bpn_session=v1.99999999999999.abc", "bpn_session=garbage", "bpn_session="]) {
      c.cookie = bad;
      expect((await c.get("/api/me")).status).toBe(401);
    }
    const secret = "test-secret-test-secret-test-secret-0000";
    const expired = mintToken(secret, Date.now() - 200 * 86_400_000).token;
    expect(verifyToken(secret, expired)).toBeNull();
    c.cookie = `bpn_session=${expired}`;
    expect((await c.get("/api/me")).status).toBe(401);
  });

  it("renews a cookie that is more than a week old", async () => {
    const c = new Client(server.url);
    const old = mintToken("test-secret-test-secret-test-secret-0000", Date.now() - 10 * 86_400_000).token;
    c.cookie = `bpn_session=${old}`;
    const r = await c.get("/api/me");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/^bpn_session=v1\./);
    expect(c.cookie).not.toBe(`bpn_session=${old}`);
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
