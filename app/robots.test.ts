// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import robots from "./robots";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/config/build-environment", () => ({ deferPrerenderWithoutServerEnv: vi.fn(async () => undefined) }));

beforeEach(() => {
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: "https://books.example" } as ReturnType<typeof getServerEnv>);
});

it("allows the storefront and points crawlers at the sitemap", async () => {
  const result = await robots();
  expect(result.sitemap).toBe("https://books.example/sitemap.xml");
  expect(result.rules).toEqual([expect.objectContaining({ userAgent: "*", allow: "/" })]);
});

it("disallows application and private surfaces for both locales", async () => {
  const [rule] = [(await robots()).rules].flat();
  expect(rule.disallow).toEqual([
    "/admin",
    "/api",
    "/auth",
    "/internal",
    "/vi/account",
    "/vi/ask",
    "/vi/checkout",
    "/vi/library",
    "/vi/read/",
    "/vi/read-sample",
    "/vi/search",
    "/vi/sign-in",
    "/vi/sign-up",
    "/vi/password-reset",
    "/vi/password-update",
    "/en/account",
    "/en/ask",
    "/en/checkout",
    "/en/library",
    "/en/read/",
    "/en/read-sample",
    "/en/search",
    "/en/sign-in",
    "/en/sign-up",
    "/en/password-reset",
    "/en/password-update",
  ]);
});
