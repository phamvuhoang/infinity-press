// @vitest-environment node
import { describe, expect, it } from "vitest";

import { clientIpFrom, createIntakeLimiter } from "./intake-limiter";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("createIntakeLimiter", () => {
  it("allows up to the limit in a window and refuses the rest", () => {
    const time = clock();
    const limiter = createIntakeLimiter({ limit: 3, windowMs: 60_000, maxEntries: 10, now: time.now });

    expect([1, 2, 3, 4, 5].map(() => limiter.allow("203.0.113.7"))).toEqual([true, true, true, false, false]);
  });

  it("starts a new window once the old one elapsed", () => {
    const time = clock();
    const limiter = createIntakeLimiter({ limit: 1, windowMs: 60_000, maxEntries: 10, now: time.now });

    expect(limiter.allow("203.0.113.7")).toBe(true);
    expect(limiter.allow("203.0.113.7")).toBe(false);
    time.advance(59_999);
    expect(limiter.allow("203.0.113.7")).toBe(false);
    time.advance(1);
    expect(limiter.allow("203.0.113.7")).toBe(true);
  });

  it("counts each client separately", () => {
    const limiter = createIntakeLimiter({ limit: 1, windowMs: 60_000, maxEntries: 10, now: clock().now });

    expect(limiter.allow("203.0.113.7")).toBe(true);
    expect(limiter.allow("198.51.100.1")).toBe(true);
    expect(limiter.allow("203.0.113.7")).toBe(false);
  });

  it("never holds more than maxEntries clients, evicting the oldest", () => {
    const limiter = createIntakeLimiter({ limit: 1, windowMs: 60_000, maxEntries: 2, now: clock().now });

    limiter.allow("10.0.0.1");
    limiter.allow("10.0.0.2");
    limiter.allow("10.0.0.3");

    expect(limiter.size()).toBe(2);
    // 10.0.0.1 was evicted, so it starts a fresh window; 10.0.0.3 is still counted.
    expect(limiter.allow("10.0.0.1")).toBe(true);
    expect(limiter.allow("10.0.0.3")).toBe(false);
  });

  it("stores no raw IP address, only a salted hash", () => {
    const limiter = createIntakeLimiter({ limit: 5, windowMs: 60_000, maxEntries: 10, now: clock().now });
    limiter.allow("203.0.113.7");

    const keys = limiter.keysForTesting();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("203.0.113.7");
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a different salt per limiter, so keys cannot be precomputed", () => {
    const a = createIntakeLimiter({ limit: 5, windowMs: 60_000, maxEntries: 10, now: clock().now });
    const b = createIntakeLimiter({ limit: 5, windowMs: 60_000, maxEntries: 10, now: clock().now });
    a.allow("203.0.113.7");
    b.allow("203.0.113.7");

    expect(a.keysForTesting()[0]).not.toBe(b.keysForTesting()[0]);
  });
});

describe("clientIpFrom", () => {
  it("prefers the platform's x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1" });
    expect(clientIpFrom(headers)).toBe("203.0.113.7");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }))).toBe("198.51.100.1");
  });

  it("returns undefined when neither header is present or usable", () => {
    expect(clientIpFrom(new Headers())).toBeUndefined();
    expect(clientIpFrom(new Headers({ "x-forwarded-for": " , " }))).toBeUndefined();
    expect(clientIpFrom(new Headers({ "x-real-ip": "x".repeat(200) }))).toBeUndefined();
  });
});
