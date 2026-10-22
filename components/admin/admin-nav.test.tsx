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
  expect(labels.slice(labels.indexOf("Topics"), labels.indexOf("Topics") + 4)).toEqual(["Topics", "Ideas", "Journeys", "Articles"]);
  expect(within(nav).getByRole("link", { name: "Journeys" })).toHaveAttribute("href", "/admin/journeys");
  expect(within(nav).getByRole("link", { name: "Reviews" })).toHaveAttribute("href", "/admin/reviews");
  expect(within(nav).getByRole("link", { name: "Translation reports" })).toHaveAttribute("href", "/admin/feedback");
  expect(within(nav).getByRole("link", { name: "Questions" })).toHaveAttribute("href", "/admin/questions");
  expect(labels.slice(labels.indexOf("Articles"), labels.indexOf("Articles") + 5)).toEqual(["Articles", "Reviews", "Translation reports", "Questions", "Quotes"]);
  expect(within(nav).getByRole("link", { name: "Quotes" })).toHaveAttribute("href", "/admin/quotes");
  expect(within(nav).getByRole("link", { name: "Growth" })).toHaveAttribute("href", "/admin/growth");
  for (const link of within(nav).getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/admin(\/|$)/);
});
