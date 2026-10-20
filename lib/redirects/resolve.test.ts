// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRedirectResolver,
  findPublicRedirect,
  isRedirectEligible,
  isSafeRedirectDestination,
  REDIRECT_CACHE_LIMIT,
  REDIRECT_CACHE_TTL_MS,
} from "@/lib/redirects/resolve";

afterEach(() => vi.restoreAllMocks());

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("isSafeRedirectDestination", () => {
  it.each([
    "/vi/books/new-slug",
    "/en/authors/an-author",
    "/vi",
    "/en/books",
    "/vi/read-sample/a-book",
    "/vi/reading-list",
  ])("accepts the public path %s", (path) => {
    expect(isSafeRedirectDestination(path)).toBe(true);
  });

  it.each([
    ["an empty value", ""],
    ["reader questions in Vietnamese", "/vi/ask?book=abc"],
    ["reader questions in English", "/en/ask?idea=abc"],
    ["a relative path", "vi/books/a"],
    ["a protocol-relative URL", "//evil.example/vi"],
    ["an absolute URL", "https://evil.example/vi"],
    ["a scheme", "javascript:alert(1)"],
    ["a backslash", "/\\evil.example"],
    ["a backslash later in the path", "/vi/books\\a"],
    ["a fragment", "/vi/books/a#top"],
    ["a control character", "/vi/books/a\nLocation: x"],
    ["whitespace", "/vi/books/a b"],
    ["a NUL byte", "/vi/books/a\u0000"],
    ["a delete character", "/vi/books/a\u007f"],
    ["the admin surface", "/admin"],
    ["an admin page", "/admin/books"],
    ["the API", "/api/analytics/events"],
    ["the auth callback", "/auth/callback"],
    ["an internal auth page", "/internal/vi/sign-in"],
    ["a Next.js asset", "/_next/static/chunk.js"],
    ["a localized account page", "/vi/account"],
    ["localized orders", "/en/account/orders"],
    ["a checkout page", "/vi/checkout/abc"],
    ["the library", "/en/library"],
    ["the reader", "/vi/read/abc"],
    ["search", "/en/search"],
    ["sign-in", "/vi/sign-in"],
    ["sign-up", "/en/sign-up"],
    ["password reset", "/vi/password-reset"],
    ["password update", "/en/password-update"],
  ])("rejects %s", (_label, path) => {
    expect(isSafeRedirectDestination(path)).toBe(false);
  });
});

describe("isRedirectEligible", () => {
  it.each(["GET", "HEAD"])("considers a public %s request", (method) => {
    expect(isRedirectEligible(method, "/vi/books/old-slug")).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("never redirects a %s request", (method) => {
    expect(isRedirectEligible(method, "/vi/books/old-slug")).toBe(false);
  });

  it.each([
    "/api/reader/sessions",
    "/api",
    "/auth/callback",
    "/admin",
    "/admin/books",
    "/_next/data/build/vi.json",
    "/_vercel/insights/script.js",
    "/sitemap.xml",
    "/robots.txt",
    "/favicon.ico",
    "/opengraph-image",
    "/vi/books/a/opengraph-image",
    "/brand/logo.svg",
    "/fonts/lora.woff2",
    "/manifest.webmanifest",
    "/brand/cover.JPG",
  ])("bypasses %s", (path) => {
    expect(isRedirectEligible("GET", path)).toBe(false);
  });

  it("does not mistake a path that only starts with a private word for that surface", () => {
    expect(isRedirectEligible("GET", "/administration")).toBe(true);
    expect(isRedirectEligible("GET", "/apis")).toBe(true);
  });

  it("keeps a legacy page path with a file extension eligible", () => {
    expect(isRedirectEligible("GET", "/old-page.html")).toBe(true);
    expect(isRedirectEligible("GET", "/books/index.php")).toBe(true);
  });
});

describe("createRedirectResolver", () => {
  it("returns the destination for an exact hit and null for a miss", async () => {
    const lookup = vi.fn(async (path: string) => (path === "/vi/books/old" ? "/vi/books/new" : null));
    const resolve = createRedirectResolver({ lookup });

    await expect(resolve("/vi/books/old")).resolves.toBe("/vi/books/new");
    await expect(resolve("/vi/books/other")).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledWith("/vi/books/old");
    expect(lookup).toHaveBeenCalledWith("/vi/books/other");
  });

  it("ignores an unsafe stored destination", async () => {
    const resolve = createRedirectResolver({ lookup: async () => "//evil.example/vi" });
    await expect(resolve("/vi/books/old")).resolves.toBeNull();
  });

  it("ignores a destination that points back at its own source", async () => {
    const resolve = createRedirectResolver({ lookup: async () => "/vi/books/old" });
    await expect(resolve("/vi/books/old")).resolves.toBeNull();
  });

  it("caches hits and misses for 60 seconds, then reads the database again", async () => {
    const time = clock();
    const lookup = vi.fn(async (path: string) => (path === "/vi/books/old" ? "/vi/books/new" : null));
    const resolve = createRedirectResolver({ lookup, now: time.now });

    await resolve("/vi/books/old");
    await resolve("/vi/books/missing");
    time.advance(REDIRECT_CACHE_TTL_MS - 1);
    await expect(resolve("/vi/books/old")).resolves.toBe("/vi/books/new");
    await expect(resolve("/vi/books/missing")).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);

    time.advance(1);
    await resolve("/vi/books/old");
    await resolve("/vi/books/missing");
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("sees a changed destination once the cached entry expires", async () => {
    const time = clock();
    let destination: string | null = "/vi/books/first";
    const resolve = createRedirectResolver({ lookup: async () => destination, now: time.now });

    await expect(resolve("/vi/books/old")).resolves.toBe("/vi/books/first");
    destination = "/vi/books/second";
    await expect(resolve("/vi/books/old")).resolves.toBe("/vi/books/first");
    time.advance(REDIRECT_CACHE_TTL_MS);
    await expect(resolve("/vi/books/old")).resolves.toBe("/vi/books/second");
  });

  it("holds at most 500 entries and evicts the oldest first", async () => {
    const lookup = vi.fn(async () => null);
    const resolve = createRedirectResolver({ lookup, now: clock().now });

    for (let index = 0; index <= REDIRECT_CACHE_LIMIT; index += 1) await resolve(`/vi/books/p-${index}`);
    expect(lookup).toHaveBeenCalledTimes(REDIRECT_CACHE_LIMIT + 1);

    // The newest entry is still cached; the very first one was evicted to make room for it.
    await resolve(`/vi/books/p-${REDIRECT_CACHE_LIMIT}`);
    expect(lookup).toHaveBeenCalledTimes(REDIRECT_CACHE_LIMIT + 1);
    await resolve("/vi/books/p-0");
    expect(lookup).toHaveBeenCalledTimes(REDIRECT_CACHE_LIMIT + 2);
  });

  it("does not cache a failed lookup", async () => {
    const lookup = vi
      .fn<(path: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("/vi/books/new");
    const resolve = createRedirectResolver({ lookup, now: clock().now });

    await expect(resolve("/vi/books/old")).rejects.toThrow("offline");
    await expect(resolve("/vi/books/old")).resolves.toBe("/vi/books/new");
  });
});

describe("findPublicRedirect", () => {
  const request = (method: string, url: string) => ({ method, url });

  it("builds the destination on the request origin and drops the query", async () => {
    const resolve = vi.fn(async () => "/vi/books/new");
    const target = await findPublicRedirect(
      request("GET", "https://books.example/vi/books/old?utm_source=x&next=//evil.example"),
      "req-12345678",
      resolve,
    );

    expect(resolve).toHaveBeenCalledWith("/vi/books/old");
    expect(target?.href).toBe("https://books.example/vi/books/new");
  });

  it("builds on a local request origin too", async () => {
    const target = await findPublicRedirect(
      request("HEAD", "http://127.0.0.1:3100/en/topics/old"),
      "req-12345678",
      async () => "/en/topics/new",
    );
    expect(target?.origin).toBe("http://127.0.0.1:3100");
    expect(target?.pathname).toBe("/en/topics/new");
    expect(target?.search).toBe("");
  });

  it("does not look up an ineligible request", async () => {
    const resolve = vi.fn(async () => "/vi/books/new");
    await expect(findPublicRedirect(request("POST", "https://books.example/vi/books/old"), "req-12345678", resolve)).resolves.toBeNull();
    await expect(findPublicRedirect(request("GET", "https://books.example/api/x"), "req-12345678", resolve)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns null on a miss", async () => {
    await expect(
      findPublicRedirect(request("GET", "https://books.example/vi/books/a"), "req-12345678", async () => null),
    ).resolves.toBeNull();
  });

  it("fails open and logs the request ID when the lookup fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const target = await findPublicRedirect(
      request("GET", "https://books.example/vi/books/old"),
      "req-12345678",
      async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      },
    );

    expect(target).toBeNull();
    expect(log).toHaveBeenCalledWith("Public redirect lookup failed.", {
      code: "ECONNREFUSED",
      message: "fetch failed",
      requestId: "req-12345678",
    });
  });
});
