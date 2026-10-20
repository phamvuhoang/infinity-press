import { describe, expect, it } from "vitest";

import { getRequestId, resolveRequestId } from "@/lib/observability/request-id";

describe("resolveRequestId", () => {
  it("preserves a valid inbound identifier", () => {
    expect(resolveRequestId("req_1234567890")).toBe("req_1234567890");
  });
  it("replaces invalid input", () => {
    expect(resolveRequestId("bad value")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("getRequestId", () => {
  it("reads a valid identifier from the x-request-id header", () => {
    const headers = new Headers({ "x-request-id": "req_1234567890" });
    expect(getRequestId(headers)).toBe("req_1234567890");
  });

  it("generates an identifier when the header is missing", () => {
    expect(getRequestId(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates an identifier when the header value is invalid", () => {
    const headers = new Headers({ "x-request-id": "bad value" });
    expect(getRequestId(headers)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
