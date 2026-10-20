import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { CatalogFilterForm } from "@/components/catalog/catalog-filter-form";
import { parseCatalogFilters } from "@/lib/catalog/browse";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

it("is a plain GET form that keeps the current filters selected", () => {
  render(
    <CatalogFilterForm
      action="/en/books"
      clearHref="/en/books"
      copy={en.catalog.books}
      filters={parseCatalogFilters({ topic: "habits", price: "free", sort: "title" })}
      options={{ topics: [{ slug: "habits", name: "Habits" }], authors: [], series: [] }}
    />,
  );

  const form = screen.getByRole("button", { name: "Apply" }).closest("form");
  expect(form).toHaveAttribute("method", "get");
  expect(form).toHaveAttribute("action", "/en/books");
  expect(screen.getByLabelText("Topic")).toHaveValue("habits");
  expect(screen.getByLabelText("Price")).toHaveValue("free");
  expect(screen.getByLabelText("Sort by")).toHaveValue("title");
  expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/en/books");
});
