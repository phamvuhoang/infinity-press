// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/auth/callback/route";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();

function callback(query: string) {
  return GET(new NextRequest(`http://127.0.0.1:3000/auth/callback?${query}`));
}

beforeEach(() => {
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  vi.mocked(createClient).mockResolvedValue({
    auth: { exchangeCodeForSession, verifyOtp },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
});

describe("GET /auth/callback", () => {
  it("verifies an email token and continues on the same host", async () => {
    const response = await callback("token_hash=hash-1&type=email&next=%2Fen%2Faccount&locale=en");

    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "hash-1" });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/en/account");
  });

  it("exchanges a PKCE code and continues on the same host", async () => {
    const response = await callback("code=code-1&next=%2Fadmin&locale=en");

    expect(exchangeCodeForSession).toHaveBeenCalledWith("code-1");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("/admin");
  });

  it("returns to sign-in when Supabase rejects the credential", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });

    const response = await callback("token_hash=hash-2&type=email&next=%2Fen%2Faccount&locale=en");

    expect(response.headers.get("location")).toBe(
      "/en/sign-in?next=%2Fen%2Faccount&error=callback",
    );
  });

  it("keeps the failure redirect on the host the browser used", async () => {
    const response = await callback("next=%2Fen%2Faccount&locale=en");

    expect(createClient).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "/en/sign-in?next=%2Fen%2Faccount&error=callback",
    );
  });
});
