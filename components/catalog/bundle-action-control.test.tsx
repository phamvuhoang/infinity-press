import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleActionControl } from "@/components/catalog/bundle-action-control";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const props = {
  buyAction: vi.fn(async () => undefined),
  buyLabel: "Buy bundle",
  copy: en.catalog.actions,
  libraryLabel: "Go to your library",
  libraryPath: "/en/library",
  signInPath: "/en/sign-in?next=%2Fen%2Fbundles%2Fstarter-bundle",
};

describe("BundleActionControl", () => {
  it("links an owner to their library", () => {
    render(<BundleActionControl {...props} action="owned_bundle" signedIn />);
    expect(screen.getByRole("link", { name: "Go to your library" })).toHaveAttribute("href", "/en/library");
  });

  it("sends a signed-out visitor to sign in rather than to a form", () => {
    render(<BundleActionControl {...props} action="buy" signedIn={false} />);
    expect(screen.queryByRole("button", { name: "Buy bundle" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy bundle" })).toHaveAttribute(
      "href",
      "/en/sign-in?next=%2Fen%2Fbundles%2Fstarter-bundle",
    );
  });

  it("gives a signed-in reader an enabled Buy submit button, offered whether or not they own part of the bundle", () => {
    render(<BundleActionControl {...props} action="buy" signedIn />);
    const buy = screen.getByRole("button", { name: "Buy bundle" });
    expect(buy).toBeEnabled();
    expect(buy).toHaveAttribute("type", "submit");
    expect(buy.closest("form")).not.toBeNull();
  });

  it("shows coming soon and unavailable states without a link", () => {
    const { rerender } = render(<BundleActionControl {...props} action="coming_soon" signedIn={false} />);
    expect(screen.getByRole("button", { name: "Coming soon" })).toBeDisabled();
    rerender(<BundleActionControl {...props} action="unavailable" signedIn={false} />);
    expect(screen.getByText("Not available yet")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
