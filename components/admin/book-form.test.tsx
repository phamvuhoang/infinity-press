import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { BookForm } from "@/components/admin/book-form";

afterEach(cleanup);

it("offers existing authors by stable ID while preserving a new-author name field", () => {
  render(
    <BookForm
      authorOptions={[
        { id: "4a1b2c3d-0000-4000-8000-000000000001", name: "Jane Austen", canonicalSlug: "jane-austen" },
        { id: "4a1b2c3d-0000-4000-8000-000000000002", name: "Jane Austen", canonicalSlug: "jane-austen-essays" },
      ]}
    />,
  );

  const existingAuthor = screen.getByLabelText("Existing author (optional)");
  expect(existingAuthor).toHaveDisplayValue("Create a new author");
  expect(screen.getByRole("option", { name: "Jane Austen (jane-austen)" })).toHaveValue(
    "4a1b2c3d-0000-4000-8000-000000000001",
  );
  expect(screen.getByRole("option", { name: "Jane Austen (jane-austen-essays)" })).toHaveValue(
    "4a1b2c3d-0000-4000-8000-000000000002",
  );
  expect(screen.getByLabelText("Author name")).toBeInTheDocument();
});
