import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RetailLinksForm } from "@/components/admin/book-editor/retail-links-form";
import { initialAdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);

const shopee = { id: "l1", retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: true } as const;
const tiki = { id: "l2", retailer: "tiki", label: null, url: "https://tiki.vn/y", priceMinor: 5000, currency: "VND", active: false } as const;

const names = () => Array.from(document.querySelectorAll<HTMLInputElement>("form [name]")).map((el) => el.getAttribute("name"));

describe("RetailLinksForm", () => {
  it("renders existing rows, adds a row, and posts an indexed form", async () => {
    const action = vi.fn().mockResolvedValue(initialAdminFormState);
    render(<RetailLinksForm action={action} links={[shopee]} />);
    expect(screen.getByDisplayValue("https://shopee.vn/x")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Add retailer" }));
    expect(screen.getAllByLabelText("Retailer")).toHaveLength(2);
    expect(screen.getByDisplayValue("2")).toHaveAttribute("name", "linkCount");
  });

  it("shows the label field only for Other", async () => {
    render(<RetailLinksForm action={vi.fn()} links={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add retailer" }));
    expect(screen.queryByLabelText("Label")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Retailer"), "other");
    expect(screen.getByLabelText("Label")).toBeInTheDocument();
  });

  it("re-indexes names with no gap after a row is removed", async () => {
    render(<RetailLinksForm action={vi.fn()} links={[shopee, tiki]} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Remove .*row 1/ }));
    expect(screen.getByDisplayValue("1")).toHaveAttribute("name", "linkCount");
    expect(names().filter((name) => name?.startsWith("links["))).toEqual([
      "links[0].retailer",
      "links[0].url",
      "links[0].priceMinor",
      "links[0].currency",
      "links[0].active",
    ]);
    expect(screen.getByDisplayValue("https://tiki.vn/y")).toHaveAttribute("name", "links[0].url");
  });

  it("moves a row up and keeps its values", async () => {
    render(<RetailLinksForm action={vi.fn()} links={[shopee, tiki]} />);
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: /Move .*row 1 up/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Move .*row 2 up/ }));
    expect(screen.getByDisplayValue("https://tiki.vn/y")).toHaveAttribute("name", "links[0].url");
    expect(screen.getByDisplayValue("https://shopee.vn/x")).toHaveAttribute("name", "links[1].url");
  });

  it("posts the indexed fields and shows a server field error under the matching input", async () => {
    const action = vi.fn().mockResolvedValue({ fieldErrors: { "links.1.url": "Enter an absolute https:// URL." }, formError: null, savedAt: null });
    render(<RetailLinksForm action={action} links={[shopee, tiki]} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save paperback retailers" }));
    const data = action.mock.calls[0][1] as FormData;
    expect(data.get("linkCount")).toBe("2");
    expect(data.get("links[0].url")).toBe("https://shopee.vn/x");
    expect(data.get("links[0].active")).toBe("on");
    expect(data.get("links[1].priceMinor")).toBe("5000");
    expect(data.get("links[1].active")).toBeNull();
    const error = await screen.findByText("Enter an absolute https:// URL.");
    expect(error.closest("li")).toHaveAttribute("aria-label", expect.stringContaining("row 2"));
  });
});
