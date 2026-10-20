import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { proxy } from "@/proxy";

const findPublicRedirect = vi.fn(async () => null as URL | null);
vi.mock("@/lib/redirects/resolve", () => ({ findPublicRedirect: () => findPublicRedirect() }));
vi.mock("@/lib/supabase/proxy", () => ({ updateSession: vi.fn(async () => new Response(null)) }));

function request(pathname: string) {
  return new NextRequest(new URL(pathname, "http://localhost:3000"));
}

describe("proxy", () => {
  it("redirects a bare / to the default locale", async () => {
    const response = await proxy(request("/"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/en");
  });

  it("keeps the query string when it redirects a bare / to the default locale", async () => {
    const response = await proxy(request("/?utm_source=newsletter"));

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/en?utm_source=newsletter",
    );
  });

  // Regression: Supabase falls back to the bare Site URL when the requested emailRedirectTo is not
  // in its redirect allow-list, so a magic link lands on `/` with the credential instead of on
  // /auth/callback. The `/` redirect used to drop the query, which turned that fallback into a
  // silent sign-in failure - the link opened the home page, signed out.
  it.each([
    ["code", "/?code=pkce_abc123"],
    ["token_hash", "/?token_hash=abc123&type=email"],
  ])("hands a magic link carrying %s on / to the callback route", async (_credential, url) => {
    const response = await proxy(request(url));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`http://localhost:3000/auth/callback${url.slice(1)}`);
  });

  it("passes a supported locale through unchanged", async () => {
    const response = await proxy(request("/vi"));

    expect(response.status).toBe(200);
  });

  // A stored public redirect on `/` must still win over the default `/{defaultLocale}` redirect,
  // so findPublicRedirect() has to run before the `/` check, not after.
  it("lets a stored public redirect on / win over the default locale redirect", async () => {
    findPublicRedirect.mockResolvedValueOnce(new URL("http://localhost:3000/vi/bundles/launch-week"));

    const response = await proxy(request("/"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("http://localhost:3000/vi/bundles/launch-week");
  });
});
