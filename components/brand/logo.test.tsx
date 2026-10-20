import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Logo } from "@/components/brand/logo";

describe("Logo", () => {
  it("is a text wordmark linking home, with no image asset", () => {
    const { container } = render(<Logo href="/en" />);
    const link = screen.getByRole("link", { name: "Infinity Books Press" });
    expect(link).toHaveAttribute("href", "/en");
    expect(container.querySelector("img")).toBeNull();
  });
});
