// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { getSessionUser } from "@/lib/auth/session";
import { InvalidProgressInputError, ProgressDeniedError, saveProgress } from "@/lib/reader/progress";
import type { ReaderLocator } from "@/lib/reader/types";

vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/reader/progress", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reader/progress")>("@/lib/reader/progress");
  return { ...actual, saveProgress: vi.fn() };
});

const publicationId = "c0000000-0000-0000-0000-000000000001";

const locator: ReaderLocator = {
  href: "OEBPS/text/chapter2.xhtml",
  progression: 0.375,
  totalProgression: 0.62,
  locations: { position: 17 },
};

const stored = {
  locator,
  totalProgression: locator.totalProgression,
  deviceId: "device-a",
  clientSequence: 7,
  updatedAt: "2026-09-12T10:00:00.000Z",
};

function request(body: string) {
  return new NextRequest("http://localhost/api/reader/progress", { method: "POST", body });
}

beforeEach(() => {
  // Ruling CG: resetAllMocks clears implementations installed by importActual, not just call
  // records, and must run before the defaults below.
  vi.resetAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue({ id: "auth-user-1" } as unknown as Awaited<
    ReturnType<typeof getSessionUser>
  >);
  vi.mocked(saveProgress).mockResolvedValue(stored);
});

describe("POST /api/reader/progress", () => {
  it("returns 401 for an anonymous caller and never saves", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const response = await POST(
      request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 7 })),
    );

    expect(response.status).toBe(401);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it("saves the position and answers with the effective stored progress", async () => {
    const response = await POST(
      request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 7 })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(stored);
    expect(saveProgress).toHaveBeenCalledExactlyOnceWith({
      publicationId,
      locator,
      deviceId: "device-a",
      clientSequence: 7,
    });
  });

  it("returns the winning row when the caller's save lost reconciliation", async () => {
    // Not an error: the save was refused, and the client needs the position that won so it can
    // reconcile instead of believing a write that never happened.
    const winner = { ...stored, deviceId: "device-b", locator: { ...locator, href: "OEBPS/text/ch9.xhtml" } };
    vi.mocked(saveProgress).mockResolvedValue(winner);

    const response = await POST(
      request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 1 })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(winner);
  });

  it("answers every authorization refusal with one indistinguishable 404", async () => {
    vi.mocked(saveProgress).mockRejectedValue(new ProgressDeniedError());

    const response = await POST(
      request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 7 })),
    );

    expect(response.status).toBe(404);
    // No 403 on this path: "exists but forbidden" is exactly the existence oracle the single 404
    // avoids, so an unentitled reader's request looks like one for a publication that isn't there.
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
  });

  it("answers a malformed body with 400 rather than 404 or 500", async () => {
    vi.mocked(saveProgress).mockRejectedValue(new InvalidProgressInputError("locator"));

    const response = await POST(
      request(JSON.stringify({ publicationId, locator: { href: "" }, deviceId: "device-a", clientSequence: 7 })),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON at all, before any save", async () => {
    const response = await POST(request("not json"));

    expect(response.status).toBe(400);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it("rejects a missing publication id before any save", async () => {
    const response = await POST(
      request(JSON.stringify({ locator, deviceId: "device-a", clientSequence: 7 })),
    );

    expect(response.status).toBe(400);
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it("never caches a response, on any path", async () => {
    const ok = await POST(
      request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 7 })),
    );
    vi.mocked(saveProgress).mockRejectedValue(new ProgressDeniedError());
    const denied = await POST(
      request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 7 })),
    );

    // A reader's position is per-user data and a denial is per-user too; neither may land in a
    // shared cache.
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("lets an unexpected fault surface rather than reporting it as a refusal", async () => {
    // A database outage must not be laundered into a 404 an operator reads as normal.
    vi.mocked(saveProgress).mockRejectedValue(new Error("connection reset"));

    await expect(
      POST(request(JSON.stringify({ publicationId, locator, deviceId: "device-a", clientSequence: 7 }))),
    ).rejects.toThrow("connection reset");
  });
});
