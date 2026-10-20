import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CouponForm } from "@/components/commerce/coupon-form";

const copy = {
  legend: "Promotion code",
  label: "Enter a code",
  apply: "Apply",
  applying: "Applying…",
  remove: "Remove",
  removing: "Removing…",
  subtotal: "Subtotal",
  discount: "Discount",
  applied: "Code {code} applied.",
  invalid: "This code cannot be used.",
  rateLimited: "Too many codes have been tried. Wait a few minutes and try again.",
  unavailable: "This order cannot take a code right now.",
};

const noop = vi.fn(async () => ({ status: "idle" }) as const);

afterEach(cleanup);

describe("CouponForm", () => {
  it("offers the code field when no code is applied", () => {
    render(<CouponForm appliedCode={null} applyAction={noop} copy={copy} removeAction={noop} />);
    expect(screen.getByLabelText("Enter a code")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("shows the applied code and the remove control instead of the field", () => {
    render(<CouponForm appliedCode="TWENTY" applyAction={noop} copy={copy} removeAction={noop} />);
    expect(screen.getByText("Code TWENTY applied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Enter a code")).not.toBeInTheDocument();
  });
});
