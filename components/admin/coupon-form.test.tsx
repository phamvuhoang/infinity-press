import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { updateCouponAction } from "@/app/admin/coupons/actions";
import { CouponForm } from "@/components/admin/coupon-form";
import type { AdminFormState } from "@/lib/catalog/form";
import { updateCoupon } from "@/lib/data/coupons";
import type { AdminCouponDTO } from "@/lib/data/coupons";

// updateCouponAction (the real Server Action, including the real couponSchema validation) is used
// directly in the deactivation test below, so this closes the loop all the way from the checkbox to
// the data-layer call - not just to the FormData the component produces. Only its dependencies are
// mocked.
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/coupons", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/coupons")>();
  return { ...original, updateCoupon: vi.fn() };
});

afterEach(cleanup);

const noop = async (): Promise<AdminFormState> => ({ fieldErrors: {}, formError: null, savedAt: null });

const books = [{ id: "3a1b2c3d-0000-4000-8000-000000000001", title: "A Book" }];
const bundles = [{ id: "5a1b2c3d-0000-4000-8000-000000000001", title: "The Starter Bundle" }];

function couponFixture(overrides: Partial<AdminCouponDTO> = {}): AdminCouponDTO {
  return {
    id: "4a1b2c3d-0000-4000-8000-000000000001",
    code: "TWENTY",
    kind: "percent",
    percentOff: 20,
    amountOffMinor: null,
    currency: null,
    startsAt: null,
    endsAt: null,
    active: true,
    maxRedemptions: null,
    maxRedemptionsPerProfile: 1,
    note: null,
    createdAt: "2026-09-21T00:00:00Z",
    reservedCount: 0,
    redeemedCount: 0,
    bookIds: [],
    bundleIds: [],
    ...overrides,
  };
}

it("shows an editable code field for a new coupon", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={null} />);
  expect(screen.getByLabelText("Code")).not.toHaveAttribute("readonly");
});

it("makes the code field read-only for an existing coupon", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={couponFixture()} />);
  expect(screen.getByLabelText("Code")).toHaveAttribute("readonly");
});

it("disables the percentage field and explains why once a coupon has a redemption", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={couponFixture({ redeemedCount: 1 })} />);

  expect(screen.getByLabelText("Kind")).toBeDisabled();
  expect(screen.getByLabelText("Percentage off")).toBeDisabled();
  expect(screen.getByText("This code has been used, so its value cannot change.")).toBeInTheDocument();
});

it("leaves kind and value editable for a coupon that has never been reserved or redeemed", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={couponFixture()} />);

  expect(screen.getByLabelText("Kind")).not.toBeDisabled();
  expect(screen.getByLabelText("Percentage off")).not.toBeDisabled();
  expect(screen.queryByText("This code has been used, so its value cannot change.")).not.toBeInTheDocument();
});

// A disabled input is excluded from FormData entirely, so a locked coupon's kind and value must
// still reach the server through a hidden field alongside the disabled one the operator sees.
//
// The locked notice ("This code has been used...") already renders with role="status" before any
// submission happens, so waiting on `findByRole("status")` alone would resolve immediately whether
// or not the submit actually ran - it would pass even if this mechanism were deleted entirely. This
// anchors on FormStatus's own "Saved." element (data-testid="form-saved"), which only appears once
// the action has actually returned a `savedAt`, so the wait is tied to something the submission
// itself produces.
it("still submits the locked kind and value, via hidden fields, alongside the rest of the form", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return { fieldErrors: {}, formError: null, savedAt: Date.now() };
  };
  render(<CouponForm action={save} books={books} bundles={bundles} coupon={couponFixture({ redeemedCount: 1 })} />);

  fireEvent.submit(screen.getByRole("button", { name: "Save coupon" }).closest("form")!);
  await screen.findByTestId("form-saved");

  expect(submissions[0].get("kind")).toBe("percent");
  expect(submissions[0].get("percentOff")).toBe("20");
});

// Spec 7.2: a locked coupon can still be deactivated and have its window shortened - that is the
// exact interaction the hidden-input workaround above exists to protect. This goes through the real
// updateCouponAction (real couponSchema validation included), only mocking requireAdmin, revalidatePath,
// and the data-layer updateCoupon call, so a future change that tightens the lock or drops a hidden
// input fails here instead of only in production.
it("still lets a locked coupon be deactivated, with kind and value unchanged", async () => {
  vi.mocked(updateCoupon).mockResolvedValue(undefined);
  const locked = couponFixture({ redeemedCount: 1, active: true });
  render(<CouponForm action={updateCouponAction.bind(null, locked.id)} books={books} bundles={bundles} coupon={locked} />);

  fireEvent.click(screen.getByLabelText("Active"));
  fireEvent.submit(screen.getByRole("button", { name: "Save coupon" }).closest("form")!);
  await screen.findByTestId("form-saved");

  expect(updateCoupon).toHaveBeenCalledWith(
    locked.id,
    expect.objectContaining({ active: false, kind: "percent", percentOff: 20 }),
  );
});

it("shows amount and currency fields, not a percentage, for a fixed coupon", () => {
  render(
    <CouponForm
      action={noop}
      books={books}
      bundles={bundles}
      coupon={couponFixture({ kind: "fixed", percentOff: null, amountOffMinor: 50000, currency: "VND" })}
    />,
  );

  expect(screen.queryByLabelText("Percentage off")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Amount off (minor units)")).toHaveValue(50000);
  expect(screen.getByLabelText("Currency")).toHaveValue("VND");
});

it("pre-selects the books already scoped to the coupon", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={couponFixture({ bookIds: [books[0].id] })} />);
  expect(screen.getByRole("checkbox", { name: "A Book" })).toBeChecked();
});

// S9 spec 8: two controls, two arrays, and no inference between them. A book being in scope must
// leave its bundles out of scope, or every book-scoped promotion silently discounts the bundles
// that happen to contain that book.
it("keeps the book and bundle scopes independent, in the form and in what it submits", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return { fieldErrors: {}, formError: null, savedAt: Date.now() };
  };
  render(
    <CouponForm action={save} books={books} bundles={bundles} coupon={couponFixture({ bookIds: [books[0].id] })} />,
  );

  expect(screen.getByRole("checkbox", { name: "A Book" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "The Starter Bundle" })).not.toBeChecked();

  fireEvent.click(screen.getByRole("checkbox", { name: "The Starter Bundle" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save coupon" }).closest("form")!);
  await screen.findByTestId("form-saved");

  expect(submissions[0].getAll("bookIds")).toEqual([books[0].id]);
  expect(submissions[0].getAll("bundleIds")).toEqual([bundles[0].id]);
});

it("pre-selects the bundles already scoped to the coupon", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={couponFixture({ bundleIds: [bundles[0].id] })} />);
  expect(screen.getByRole("checkbox", { name: "The Starter Bundle" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "A Book" })).not.toBeChecked();
});

it("tells the operator that selecting nothing means the code applies to everything", () => {
  render(<CouponForm action={noop} books={books} bundles={bundles} coupon={null} />);
  expect(screen.getByText(/Selecting nothing here and nothing under Bundles means the code applies to everything/)).toBeInTheDocument();
});
