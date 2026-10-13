// Sign-in for a single owner: one password (plain APP_PASSWORD or a scrypt
// APP_PASSWORD_HASH), and a stateless signed cookie
//
//   bpn_session = v1.<expiresMs>.<hmacSHA256hex(secret, "v1.<expiresMs>")>
//
// Nothing about the session is stored server-side; changing SESSION_SECRET
// (or deleting DATA_DIR/.session-secret) signs every device out. The cookie
// lives 180 days and is quietly renewed while in use, so the iPad stays
// signed in.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

export const SESSION_COOKIE = "bpn_session";
export const SESSION_DAYS = 180;
const SESSION_MS = SESSION_DAYS * 86_400_000;
/** Re-issue the cookie once it is this old, so a device in regular use never reaches the expiry. */
const RENEW_AFTER_MS = 7 * 86_400_000;

// ── session secret ───────────────────────────────────────────────────────

/**
 * The configured SESSION_SECRET, or a random one generated on first boot and
 * kept in DATA_DIR/.session-secret (mode 600) so sign-ins survive restarts.
 */
export function resolveSessionSecret(configured: string | null, dataDir: string): string {
  if (configured) return configured;
  const file = path.join(dataDir, ".session-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first boot */
  }
  const secret = randomBytes(48).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

// ── tokens ───────────────────────────────────────────────────────────────

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function mintToken(secret: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_MS;
  const body = `v1.${expiresAt}`;
  return { token: `${body}.${sign(secret, body)}`, expiresAt };
}

/** The token's expiry when it is genuine and current, else null. */
export function verifyToken(secret: string, token: string | undefined, now = Date.now()): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{1,16}$/.test(parts[1])) return null;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return safeEqual(sign(secret, `v1.${parts[1]}`), parts[2]) ? expiresAt : null;
}

/** True when the cookie was issued more than RENEW_AFTER_MS ago. */
export function shouldRenew(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - now < SESSION_MS - RENEW_AFTER_MS;
}

export function readSessionCookie(c: Context): string | undefined {
  const header = c.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** HTTPS directly, or behind a proxy that terminated TLS (Fly sets X-Forwarded-Proto). */
export function isHttps(c: Context): boolean {
  const xfp = c.req.header("x-forwarded-proto");
  if (xfp) return xfp.split(",")[0].trim().toLowerCase() === "https";
  return new URL(c.req.url).protocol === "https:";
}

export function sessionCookie(c: Context, token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(c) ? "; Secure" : ""}`;
}

// ── passwords ────────────────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, len, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Checks a password against a stored `scrypt:<salt>:<hash>` (scripts/hash-password.mjs). */
export async function verifyScrypt(password: string, stored: string): Promise<boolean> {
  const [algo, saltB, hashB] = stored.split(":");
  if (algo !== "scrypt" || !saltB || !hashB) return false;
  const salt = Buffer.from(saltB, "base64url");
  const expected = Buffer.from(hashB, "base64url");
  if (!salt.length || !expected.length) return false;
  const got = await scryptAsync(password, salt, expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface PasswordCheck {
  configured: boolean;
  check(password: string): Promise<boolean>;
}

export function passwordChecker(plain: string | null, hash: string | null): PasswordCheck {
  if (hash) return { configured: true, check: (pw) => verifyScrypt(pw, hash).catch(() => false) };
  if (plain) {
    // compare digests so the comparison is constant-time whatever the lengths
    const want = createHash("sha256").update(plain).digest();
    return { configured: true, check: async (pw) => timingSafeEqual(createHash("sha256").update(pw).digest(), want) };
  }
  return { configured: false, check: async () => false };
}

// ── login throttle ───────────────────────────────────────────────────────

/**
 * Per-IP failure counter in memory (one machine by design): 10 wrong
 * passwords inside 15 minutes lock that address out for 15 minutes.
 */
export class LoginThrottle {
  private fails = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(
    private readonly maxFails = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  isLocked(ip: string, now = Date.now()): boolean {
    const e = this.fails.get(ip);
    return !!e && e.lockedUntil > now;
  }

  fail(ip: string, now = Date.now()) {
    this.prune(now);
    let e = this.fails.get(ip);
    if (!e || now - e.first > this.windowMs) {
      e = { count: 0, first: now, lockedUntil: 0 };
      this.fails.set(ip, e);
    }
    e.count += 1;
    if (e.count >= this.maxFails) e.lockedUntil = now + this.windowMs;
  }

  succeed(ip: string) {
    this.fails.delete(ip);
  }

  private prune(now: number) {
    if (this.fails.size < 1000) return;
    for (const [ip, e] of this.fails) if (now - e.first > this.windowMs && e.lockedUntil <= now) this.fails.delete(ip);
  }
}

/** The client address for throttling. Proxy headers only count when we know a trusted proxy set them. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fly = c.req.header("fly-client-ip");
    if (fly) return fly.trim();
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "direct";
}

// ── same-origin guard ────────────────────────────────────────────────────

/**
 * Writes must come from this app's own pages. SameSite=Lax alone isn't
 * enough: sibling *.gabeweb.com apps count as "same-site". Browsers send
 * Sec-Fetch-Site and/or Origin on every POST/PATCH; scripts like curl send
 * neither and are allowed (they still need the cookie).
 */
export function isSameOrigin(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.header("origin");
  if (origin) {
    if (origin === "null") return false;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const hosts = [c.req.header("host"), c.req.header("x-forwarded-host")?.split(",")[0].trim()].filter(Boolean);
    if (!hosts.includes(originHost)) return false;
  }
  return true;
}
