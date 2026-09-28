/**
 * Customer sign-in for the help center: guest order lookup, the pattern most
 * online stores use. A customer proves who they are with their email plus an
 * order number from their receipt, and receives a short-lived signed token.
 * Every customer-facing request is then tied to that token's customer, never to
 * an id the browser sends.
 *
 * Tokens are HMAC-SHA256 signed (no dependency needed). This is a demo-grade
 * scheme: there are no passwords, and staff endpoints are still open (see README).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { HttpError } from "./errors";

export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface TokenPayload {
  /** Customer id. */
  sub: number;
  /** Expiry, epoch ms. */
  exp: number;
}

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signToken(customerId: number, secret: string, now = Date.now(), ttlMs = TOKEN_TTL_MS): string {
  const payload = b64(JSON.stringify({ sub: customerId, exp: now + ttlMs } satisfies TokenPayload));
  const signature = b64(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${signature}`;
}

/** Returns the payload, or null if the token is malformed, forged, or expired. */
export function verifyToken(token: string, secret: string, now = Date.now()): TokenPayload | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;

  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<TokenPayload>;
    if (!Number.isInteger(data.sub) || typeof data.exp !== "number" || data.exp <= now) return null;
    return { sub: data.sub!, exp: data.exp };
  } catch {
    return null;
  }
}

/** AUTH_SECRET, or a random per-process secret (sessions then end on restart). */
export function resolveAuthSecret(env: Record<string, string | undefined>): { secret: string; ephemeral: boolean } {
  const configured = env.AUTH_SECRET?.trim();
  return configured && configured.length >= 16
    ? { secret: configured, ephemeral: false }
    : { secret: randomBytes(32).toString("hex"), ephemeral: true };
}

export const unauthorized = (message = "Please sign in to continue.") => new HttpError(401, "unauthorized", message);

/** Puts the signed-in customer's id in res.locals.customerId, or responds 401. */
export function requireCustomer(secret: string): RequestHandler {
  return (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const payload = token ? verifyToken(token, secret) : null;
    if (!payload) return next(unauthorized("Your session has expired. Please sign in again."));
    res.locals.customerId = payload.sub;
    next();
  };
}

/**
 * Fixed-window, in-memory attempt limiter for sign-in, so order numbers can't
 * be brute-forced. Per process; a multi-instance deployment would need a
 * shared store.
 */
export function attemptLimiter(options: { max: number; windowMs: number; now?: () => number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = options.now ?? Date.now;
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const t = now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + options.windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > options.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - t) / 1000));
      return next(
        new HttpError(429, "too_many_attempts", "Too many sign-in attempts. Please wait a few minutes and try again."),
      );
    }
    next();
  };
}
