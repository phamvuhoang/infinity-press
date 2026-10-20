import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EntityBaseForm, EntityLocalizationForm } from "@/components/admin/localized-entity-form";
import type { AdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);

describe("entity forms", () => {
  it("connects validation errors to their base fields and announces failures", async () => {
    const action = vi.fn(async (): Promise<AdminFormState> => ({ fieldErrors: { canonicalSlug: "Choose a different slug." }, formError: "Saving failed.", savedAt: null }));
    render(<EntityBaseForm action={action} defaults={{ canonicalSlug: "taken", name: "Author", status: "draft" }} showStatus submitLabel="Save" />);
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    const field = screen.getByLabelText("Canonical slug");
    await waitFor(() => expect(field).toHaveAccessibleDescription("Choose a different slug."));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Saving failed.")).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("Status")).toHaveRole("combobox");
  });

  it("connects localization errors without conflicting between languages", async () => {
    const action = vi.fn(async (): Promise<AdminFormState> => ({ fieldErrors: { slug: "Slug taken." }, formError: null, savedAt: null }));
    render(<><EntityLocalizationForm action={action} defaults={null} locale="vi" /><EntityLocalizationForm action={action} defaults={null} locale="en" /></>);
    fireEvent.submit(screen.getByRole("button", { name: "Save vi copy" }).closest("form")!);
    await waitFor(() => expect(screen.getByLabelText("Slug (vi)")).toHaveAccessibleDescription("Slug taken."));
    expect(screen.getByLabelText("Slug (en)")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("announces saved copy and hides status during creation", async () => {
    const action = vi.fn(async (): Promise<AdminFormState> => ({ fieldErrors: {}, formError: null, savedAt: 1 }));
    render(<EntityBaseForm action={action} defaults={{ canonicalSlug: "a", name: "A", status: "draft" }} showStatus={false} submitLabel="Create author" />);
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("button", { name: "Create author" }).closest("form")!);
    expect(await screen.findByTestId("form-saved")).toHaveTextContent("Saved.");
    expect(screen.getByTestId("form-saved")).toHaveAttribute("role", "status");
  });

  it("keeps typed copy when a save returns a field error", async () => {
    const action = vi.fn(async (): Promise<AdminFormState> => ({ fieldErrors: { slug: "Slug taken." }, formError: null, savedAt: null }));
    render(<EntityLocalizationForm action={action} defaults={null} locale="en" />);
    fireEvent.change(screen.getByLabelText("Slug (en)"), { target: { value: "taken" } });
    fireEvent.change(screen.getByLabelText("Name (en)"), { target: { value: "Keep this name" } });
    fireEvent.change(screen.getByLabelText("Description (en)"), { target: { value: "Keep this copy" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save en copy" }).closest("form")!);
    await screen.findByText("Slug taken.");
    expect(screen.getByLabelText("Name (en)")).toHaveValue("Keep this name");
    expect(screen.getByLabelText("Description (en)")).toHaveValue("Keep this copy");
  });

  it("keeps edited base fields and status after rejected publishing", async () => {
    const action = vi.fn(async (): Promise<AdminFormState> => ({ fieldErrors: { status: "Add copy first." }, formError: null, savedAt: null }));
    render(<EntityBaseForm action={action} defaults={{ canonicalSlug: "a", name: "A", status: "draft" }} showStatus submitLabel="Save" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New name" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "published" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    await screen.findByText("Add copy first.");
    expect(screen.getByLabelText("Name")).toHaveValue("New name");
    expect(screen.getByLabelText("Status")).toHaveValue("published");
  });
});
