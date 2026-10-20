import { describe, expect, it } from "vitest";

import { coverPublicUrl } from "@/lib/catalog/covers";

describe("coverPublicUrl", () => {
  it("builds the public object URL for the covers bucket", () => {
    expect(coverPublicUrl("books/abc/def.png", "http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321/storage/v1/object/public/covers/books/abc/def.png",
    );
  });

  it("tolerates a trailing slash on the project URL", () => {
    expect(coverPublicUrl("books/abc/def.png", "https://example.supabase.co/")).toBe(
      "https://example.supabase.co/storage/v1/object/public/covers/books/abc/def.png",
    );
  });
});
