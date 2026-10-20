import { describe, expect, it } from "vitest";

import { isLoopbackUrl } from "@/lib/config/url";

describe("isLoopbackUrl", () => {
  it("detects local hosts", () => {
    expect(isLoopbackUrl("http://127.0.0.1:54321/storage/v1/object/public/covers/a.png")).toBe(true);
    expect(isLoopbackUrl("http://localhost:54321/x")).toBe(true);
    expect(isLoopbackUrl("https://abc.supabase.co/x")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
