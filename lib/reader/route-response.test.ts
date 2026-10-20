// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  ReaderDataDeniedError,
  ReaderDataInvalidError,
  ReaderDataUnavailableError,
} from "@/lib/data/reader-annotations";
import { ReaderRequestNotFoundError, ReaderRequestUnauthorizedError } from "@/lib/reader/request-context";
import { readerApiErrorResponse } from "@/lib/reader/route-response";

describe("readerApiErrorResponse", () => {
  it.each([
    [new ReaderRequestUnauthorizedError(), 401, { error: "Authentication required." }],
    [new ReaderRequestNotFoundError(), 404, { error: "Not found." }],
    [new ReaderDataDeniedError(), 404, { error: "Not found." }],
    [new ReaderDataInvalidError(), 400, { error: "Invalid request." }],
  ])("maps a handled reader error to a private response", async (error, status, body) => {
    const response = readerApiErrorResponse(error, "req-shared", "annotation");

    expect(response?.status).toBe(status);
    await expect(response?.json()).resolves.toEqual(body);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response?.headers.get("x-request-id")).toBe("req-shared");
  });

  it("maps an unavailable error without exposing its detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = readerApiErrorResponse(
      new ReaderDataUnavailableError("XX000"),
      "req-shared",
      "search",
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({ error: "Reader request failed.", requestId: "req-shared" });
    expect(log).toHaveBeenCalledWith("Reader search request failed.", {
      requestId: "req-shared",
      code: "XX000",
    });
  });

  it("leaves unexpected programming errors unhandled", () => {
    expect(readerApiErrorResponse(new Error("boom"), "req-shared", "annotation")).toBeNull();
  });
});
