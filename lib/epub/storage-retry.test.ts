// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  describeStorageError,
  isRetryableStorageError,
  withStorageRetry,
  type StorageRetryPolicy,
} from "@/lib/epub/storage-retry";

// The exact shape supabase-js hands back when `fetch` itself throws: a StorageUnknownError
// carrying the undici TypeError, whose own `cause` carries the real errno. Reproduced by
// hand rather than imported so the test pins the wire shape we actually depend on.
function unknownStorageError(code = "ECONNRESET") {
  const errno = Object.assign(new Error(`read ${code}`), { code, syscall: "read" });
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause: errno });
  return Object.assign(new Error("fetch failed"), {
    name: "StorageUnknownError",
    originalError: fetchError,
  });
}

function apiStorageError(status: number, message = "boom") {
  return Object.assign(new Error(message), { name: "StorageApiError", status, statusCode: String(status) });
}

const testPolicy: StorageRetryPolicy = { attempts: 4, baseDelayMs: 10, sleep: async () => {} };

describe("describeStorageError", () => {
  it("appends the underlying errno that supabase-js flattens away", () => {
    expect(describeStorageError(unknownStorageError("ECONNRESET"))).toBe(
      "fetch failed <- TypeError: fetch failed <- ECONNRESET: read ECONNRESET",
    );
  });

  it("returns the bare message when there is no underlying cause", () => {
    expect(describeStorageError(apiStorageError(400, "invalid key"))).toBe("invalid key");
  });
});

describe("isRetryableStorageError", () => {
  it("retries a transport failure, which carries no HTTP status at all", () => {
    expect(isRetryableStorageError(unknownStorageError())).toBe(true);
  });

  it.each([408, 429, 500, 502, 503])("retries HTTP %i", (status) => {
    expect(isRetryableStorageError(apiStorageError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 413])("does not retry HTTP %i", (status) => {
    expect(isRetryableStorageError(apiStorageError(status))).toBe(false);
  });

  it("does not retry an error it cannot classify as transient", () => {
    expect(isRetryableStorageError({ message: "bucket full" })).toBe(false);
  });
});

describe("withStorageRetry", () => {
  it("retries a transport failure and returns the first successful result", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ error: unknownStorageError() })
      .mockResolvedValueOnce({ error: unknownStorageError() })
      .mockResolvedValueOnce({ error: null, data: { path: "k" } });

    const result = await withStorageRetry(run, testPolicy);

    expect(run).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ error: null, data: { path: "k" } });
  });

  it("backs off exponentially between attempts", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const run = vi.fn().mockResolvedValue({ error: unknownStorageError() });

    await withStorageRetry(run, { attempts: 4, baseDelayMs: 100, sleep });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
  });

  it("gives up after the configured attempt budget and returns the last error", async () => {
    const run = vi.fn().mockResolvedValue({ error: unknownStorageError("ETIMEDOUT") });

    const result = await withStorageRetry(run, testPolicy);

    expect(run).toHaveBeenCalledTimes(4);
    expect(describeStorageError(result.error)).toContain("ETIMEDOUT");
  });

  it("returns a non-retryable error immediately without burning the budget", async () => {
    const run = vi.fn().mockResolvedValue({ error: apiStorageError(404, "not found") });

    const result = await withStorageRetry(run, testPolicy);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({ status: 404 });
  });
});
