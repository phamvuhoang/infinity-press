// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isAuthorizedWorkerSecret } from "@/lib/ops/worker-auth";

const SECRET = "s".repeat(40);

describe("isAuthorizedWorkerSecret", () => {
  it("rejects a missing authorization header", () => {
    expect(isAuthorizedWorkerSecret(null, SECRET)).toBe(false);
  });

  it("rejects a Basic scheme", () => {
    expect(isAuthorizedWorkerSecret(`Basic ${Buffer.from(`user:${SECRET}`).toString("base64")}`, SECRET)).toBe(false);
  });

  it("rejects the wrong bearer value", () => {
    expect(isAuthorizedWorkerSecret(`Bearer ${"w".repeat(40)}`, SECRET)).toBe(false);
  });

  it("rejects a short bearer value", () => {
    expect(isAuthorizedWorkerSecret("Bearer short", SECRET)).toBe(false);
  });

  it("rejects an empty bearer value", () => {
    expect(isAuthorizedWorkerSecret("Bearer ", SECRET)).toBe(false);
  });

  it("accepts the exact configured secret", () => {
    expect(isAuthorizedWorkerSecret(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects every request when no secret is configured", () => {
    expect(isAuthorizedWorkerSecret(`Bearer ${SECRET}`, null)).toBe(false);
  });
});
