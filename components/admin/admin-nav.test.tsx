import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { AdminNav } from "@/components/admin/admin-nav";

afterEach(cleanup);

it("links the knowledge editors beside the catalog entities, without a locale prefix", () => {
  render(<AdminNav />);
  const nav = screen.getByRole("navigation", { name: "Admin navigation" });

  expect(within(nav).getByRole("link", { name: "Ideas" })).toHaveAttribute("href", "/admin/ideas");
  expect(within(nav).getByRole("link", { name: "Articles" })).toHaveAttribute("href", "/admin/articles");
  const labels = within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent);
  expect(labels.slice(labels.indexOf("Topics"), labels.indexOf("Topics") + 3)).toEqual(["Topics", "Ideas", "Articles"]);
  expect(within(nav).getByRole("link", { name: "Reviews" })).toHaveAttribute("href", "/admin/reviews");
  expect(within(nav).getByRole("link", { name: "Questions" })).toHaveAttribute("href", "/admin/questions");
  expect(labels.slice(labels.indexOf("Articles"), labels.indexOf("Articles") + 4)).toEqual(["Articles", "Reviews", "Questions", "Quotes"]);
  expect(within(nav).getByRole("link", { name: "Quotes" })).toHaveAttribute("href", "/admin/quotes");
  for (const link of within(nav).getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/admin(\/|$)/);
});
