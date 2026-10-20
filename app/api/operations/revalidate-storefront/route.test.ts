// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/catalog/revalidate", () => ({ revalidateStorefront: vi.fn() }));

const SITE = "https://books.example.com";
const SECRET = "s".repeat(40);
const REQUEST_ID = "test-request-id-1234";

function env(overrides: Record<string, unknown> = {}) {
  return { opsWorkerSecret: SECRET, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

function request(headers: Record<string, string> = {}) {
  return new NextRequest(`${SITE}/api/operations/revalidate-storefront`, { method: "POST", headers });
}

function authedRequest() {
  return request({ authorization: `Bearer ${SECRET}`, "x-request-id": REQUEST_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
});

describe("POST /api/operations/revalidate-storefront", () => {
  describe("authentication", () => {
    it("rejects every request when the worker secret is not configured, without revalidating", async () => {
      vi.mocked(getServerEnv).mockReturnValue(env({ opsWorkerSecret: null }));

      const response = await POST(authedRequest());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "worker_not_configured", requestId: REQUEST_ID });
      expect(revalidateStorefront).not.toHaveBeenCalled();
    });

    it("rejects a missing authorization header, without revalidating", async () => {
      const response = await POST(request({ "x-request-id": REQUEST_ID }));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized", requestId: REQUEST_ID });
      expect(revalidateStorefront).not.toHaveBeenCalled();
    });

    it("rejects a Basic authorization scheme", async () => {
      const response = await POST(request({ authorization: "Basic dXNlcjpwYXNz", "x-request-id": REQUEST_ID }));

      expect(response.status).toBe(401);
      expect(revalidateStorefront).not.toHaveBeenCalled();
    });

    it("rejects the wrong bearer secret", async () => {
      const response = await POST(request({ authorization: `Bearer ${"w".repeat(40)}`, "x-request-id": REQUEST_ID }));

      expect(response.status).toBe(401);
      expect(revalidateStorefront).not.toHaveBeenCalled();
    });
  });

  it("revalidates the storefront and returns 200 with the request ID, never cached", async () => {
    const response = await POST(authedRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ requestId: REQUEST_ID });
    expect(revalidateStorefront).toHaveBeenCalledOnce();
  });
});
