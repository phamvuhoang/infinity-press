import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PasswordSignInFallbackPage from "@/app/internal/[lang]/sign-in/page";

async function render(locale: string, searchParams: Record<string, string>) {
  const page = await PasswordSignInFallbackPage({
    params: Promise.resolve({ lang: locale }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(page);
}

describe("internal password sign-in fallback", () => {
  it("renders a localized password form for an English protected destination", async () => {
    const html = await render("en", { next: "/en/library" });

    expect(html).toContain('name="locale"');
    expect(html).toContain('value="en"');
    expect(html).toContain('name="next"');
    expect(html).toContain('value="/en/library"');
    expect(html).toContain('name="password"');
  });

  it("falls back to the selected locale for an unsafe destination", async () => {
    expect(await render("en", { next: "https://evil.test" })).toContain('value="/en/account"');
  });

  it("links to password recovery in the same locale", async () => {
    expect(await render("en", {})).toContain('href="/internal/en/forgot-password"');
  });

  it("shows credential errors in the page language", async () => {
    expect(await render("vi", { error: "credentials" })).toContain(
      "Email hoặc mật khẩu không đúng.",
    );
  });
});
