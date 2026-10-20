import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionErrorBanner } from "@/components/catalog/action-error-banner";

const searchParams = { value: new URLSearchParams() };
vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams.value }));

const messages = { "already-owned": "You already own this book.", "offer-gone": "This offer has ended." };

afterEach(cleanup);

describe("ActionErrorBanner", () => {
  it("says nothing when the URL carries no error", () => {
    searchParams.value = new URLSearchParams();
    const { container } = render(<ActionErrorBanner messages={messages} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the error named in the URL", () => {
    searchParams.value = new URLSearchParams({ "action-error": "already-owned" });
    render(<ActionErrorBanner messages={messages} />);
    expect(screen.getByRole("alert")).toHaveTextContent("You already own this book.");
  });

  it("ignores a code it has no message for, rather than rendering an empty alert", () => {
    searchParams.value = new URLSearchParams({ "action-error": "not-a-real-code" });
    const { container } = render(<ActionErrorBanner messages={messages} />);
    expect(container).toBeEmptyDOMElement();
  });
});
