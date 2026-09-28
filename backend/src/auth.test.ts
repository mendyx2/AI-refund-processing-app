import { describe, expect, it } from "vitest";

import { resolveAuthSecret, signToken, TOKEN_TTL_MS, verifyToken } from "./auth";

const SECRET = "unit-test-secret-0123456789";
const NOW = 1_800_000_000_000;

describe("session tokens", () => {
  it("round-trips a customer id until expiry", () => {
    const token = signToken(42, SECRET, NOW);
    expect(verifyToken(token, SECRET, NOW + 1000)).toEqual({ sub: 42, exp: NOW + TOKEN_TTL_MS });
    expect(verifyToken(token, SECRET, NOW + TOKEN_TTL_MS)).toBeNull();
  });

  it("rejects tampered payloads, wrong secrets and garbage", () => {
    const token = signToken(42, SECRET, NOW);
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 1, exp: NOW + TOKEN_TTL_MS })).toString("base64url");

    expect(verifyToken(`${forgedPayload}.${signature}`, SECRET, NOW)).toBeNull();
    expect(verifyToken(token, "another-secret-entirely", NOW)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", ".", `${token}.extra`]) expect(verifyToken(bad, SECRET, NOW)).toBeNull();
  });
});

describe("resolveAuthSecret", () => {
  it("uses AUTH_SECRET when long enough, otherwise a random ephemeral one", () => {
    expect(resolveAuthSecret({ AUTH_SECRET: "a-long-enough-secret-value" })).toEqual({
      secret: "a-long-enough-secret-value",
      ephemeral: false,
    });
    const short = resolveAuthSecret({ AUTH_SECRET: "short" });
    expect(short.ephemeral).toBe(true);
    expect(short.secret).toHaveLength(64);
    expect(resolveAuthSecret({}).secret).not.toBe(resolveAuthSecret({}).secret);
  });
});
