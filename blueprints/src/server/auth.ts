// Sign-in for a single owner: one password (plain APP_PASSWORD or a scrypt
// APP_PASSWORD_HASH), and a stateless signed cookie
//
//   bpn_session = v2.<issuedMs>.<expiresMs>.<hmacSHA256hex(key, "v2.<issuedMs>.<expiresMs>")>
//
// Nothing about the session is stored server-side. The signing key mixes the
// server secret (SESSION_SECRET or DATA_DIR/.session-secret) with a
// fingerprint of the configured password, so changing the password signs
// every device out — the thing to do when an iPad is lost. The cookie lives
// 180 days and is quietly renewed while in use, so the iPad stays signed in,
// but never beyond a year from the sign-in itself (issuedMs rides along).

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

export const SESSION_COOKIE = "bpn_session";
export const SESSION_DAYS = 180;
const SESSION_MS = SESSION_DAYS * 86_400_000;
/** Re-issue the cookie about this often, so a device in regular use never reaches the expiry. */
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

/** However often it is renewed, a sign-in lasts at most this long; then the password is asked for again. */
export const SESSION_MAX_DAYS = 365;
const SESSION_MAX_MS = SESSION_MAX_DAYS * 86_400_000;

/**
 * The key session cookies are signed with: the server secret mixed with a
 * fingerprint of the password setting (the hash wins over the plain
 * password, as in passwordChecker). Any change to either signs every
 * device out.
 */
export function sessionKey(secret: string, password: string | null, passwordHash: string | null): string {
  const credential = passwordHash ? `hash:${passwordHash}` : password ? `plain:${password}` : "none";
  return createHmac("sha256", secret).update(`bpn-session-key\0${credential}`).digest("hex");
}

export interface Session {
  /** When the password was typed (renewals keep it). */
  issuedAt: number;
  expiresAt: number;
}

function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** A cookie value for a sign-in made at `issuedAt` (a renewal passes the original time). */
export function mintToken(key: string, now = Date.now(), issuedAt = now): { token: string } & Session {
  const expiresAt = Math.min(now + SESSION_MS, issuedAt + SESSION_MAX_MS);
  const body = `v2.${issuedAt}.${expiresAt}`;
  return { token: `${body}.${sign(key, body)}`, issuedAt, expiresAt };
}

/** The session when the token is genuine and current, else null. */
export function verifyToken(key: string, token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v2" || !/^\d{1,16}$/.test(parts[1]) || !/^\d{1,16}$/.test(parts[2])) return null;
  const issuedAt = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  if (expiresAt <= now || now - issuedAt >= SESSION_MAX_MS || expiresAt > issuedAt + SESSION_MAX_MS) return null;
  return safeEqual(sign(key, `v2.${parts[1]}.${parts[2]}`), parts[3]) ? { issuedAt, expiresAt } : null;
}

/**
 * True when re-issuing the cookie now would push its expiry out by more than
 * RENEW_AFTER_MS — so about once a week while in use, and no more once the
 * one-year cap is what limits it.
 */
export function shouldRenew(session: Session, now = Date.now()): boolean {
  return Math.min(now + SESSION_MS, session.issuedAt + SESSION_MAX_MS) - session.expiresAt > RENEW_AFTER_MS;
}

/** Max-Age for a cookie carrying this session. */
export function cookieMaxAge(session: Session, now = Date.now()): number {
  return Math.max(0, Math.floor((session.expiresAt - now) / 1000));
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
