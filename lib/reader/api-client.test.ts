import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createReaderApiClient } from "@/lib/reader/api-client";

const publicationId = "c0000000-0000-4000-8000-000000000001";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("createReaderApiClient", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let remint: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let onLostAccess: ReturnType<typeof vi.fn<(status: 401 | 404) => void>>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    remint = vi.fn().mockResolvedValue(undefined);
    onLostAccess = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function client() {
    return createReaderApiClient({ publicationId, remint, onLostAccess });
  }

  it("refuses all later depth work after terminal access loss", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 401 }));
    const api = client();
    await expect(api.request("/first")).rejects.toMatchObject({ status: 401 });
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(api.request("/later", { method: "POST" })).rejects.toMatchObject({ status: 401 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("lets the caller's signal end a request stuck on a hanging remint without losing access", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 404 }));
    remint.mockReturnValue(new Promise<void>(() => {}));
    const controller = new AbortController();
    const pending = client().request("/api/reader/quotes", { method: "POST", signal: controller.signal });
    await vi.waitFor(() => expect(remint).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("Timed out.", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(onLostAccess).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("lets the caller's signal end a request whose body never finishes", async () => {
    fetchSpy.mockResolvedValue(new Response(new ReadableStream({ start() {} }), { status: 200 }));
    const controller = new AbortController();
    const pending = client().request("/api/reader/quotes", { method: "POST", signal: controller.signal });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("Timed out.", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(onLostAccess).not.toHaveBeenCalled();
  });

  it("returns parsed JSON and sends reader requests with same-origin credentials", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ value: 7 }), { status: 200 }));

    await expect(client().request<{ value: number }>("/api/reader/value")).resolves.toEqual({ value: 7 });
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      "/api/reader/value",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("returns undefined for a successful 204 without parsing a body", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      client().request<void>(`/api/reader/annotations/a1?publicationId=${publicationId}`, { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });

  it("converges a 401 response to signed-out without attempting a re-mint", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(client().request("/api/reader/private")).rejects.toMatchObject({ status: 401 });
    expect(remint).not.toHaveBeenCalled();
    expect(onLostAccess).toHaveBeenCalledExactlyOnceWith(401);
  });

  it("re-mints once and retries a request exactly once after a 404", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(client().request("/api/reader/private")).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(remint).toHaveBeenCalledTimes(1);
    expect(onLostAccess).not.toHaveBeenCalled();
  });

  it("shares one in-flight re-mint between parallel 404 responses", async () => {
    const mint = deferred<void>();
    remint.mockReturnValue(mint.promise);
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
    const api = client();

    const first = api.request("/api/reader/first");
    const second = api.request("/api/reader/second");
    await vi.waitFor(() => expect(remint).toHaveBeenCalledTimes(1));
    mint.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(remint).toHaveBeenCalledTimes(1);
    expect(onLostAccess).not.toHaveBeenCalled();
  });

  it("reuses a completed recovery for a late 404 from the previous session generation", async () => {
    const firstInitial = deferred<Response>();
    const lateInitial = deferred<Response>();
    fetchSpy
      .mockReturnValueOnce(firstInitial.promise)
      .mockReturnValueOnce(lateInitial.promise)
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      );
    const api = client();

    const first = api.request("/api/reader/first");
    const late = api.request("/api/reader/late");
    firstInitial.resolve(new Response(null, { status: 404 }));
    await expect(first).resolves.toEqual({ ok: true });
    expect(remint).toHaveBeenCalledTimes(1);

    lateInitial.resolve(new Response(null, { status: 404 }));
    await expect(late).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(remint).toHaveBeenCalledTimes(1);
    expect(onLostAccess).not.toHaveBeenCalled();
  });

  it("converges a repeated 404 after re-mint to revoked access", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(client().request("/api/reader/private")).rejects.toMatchObject({ status: 404 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(remint).toHaveBeenCalledTimes(1);
    expect(onLostAccess).toHaveBeenCalledExactlyOnceWith(404);
  });

  it("converges a failed re-mint to revoked access", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    remint.mockRejectedValue(new Error("mint unavailable"));

    await expect(client().request("/api/reader/private")).rejects.toThrow("mint unavailable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onLostAccess).toHaveBeenCalledExactlyOnceWith(404);
  });

  it.each([
    ["an abort", new DOMException("Aborted", "AbortError")],
    ["a 502", null],
  ])("does not report lost access for %s", async (_name, rejection) => {
    if (rejection) fetchSpy.mockRejectedValue(rejection);
    else fetchSpy.mockResolvedValue(new Response(null, { status: 502 }));

    await expect(client().request("/api/reader/private")).rejects.toBeDefined();
    expect(remint).not.toHaveBeenCalled();
    expect(onLostAccess).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous POST network failure", async () => {
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      client().request("/api/reader/publications/p1/annotations", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(remint).not.toHaveBeenCalled();
    expect(onLostAccess).not.toHaveBeenCalled();
  });
});
