import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { confirmManualPaymentAction, declineManualPaymentAction } from "@/app/admin/orders/[orderId]/manual-actions";
import { ManualPaymentDecision } from "./manual-payment-decision";

vi.mock("@/app/admin/orders/[orderId]/manual-actions", () => ({
  confirmManualPaymentAction: vi.fn(),
  declineManualPaymentAction: vi.fn(),
}));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";

function renderPanel() {
  return render(<ManualPaymentDecision currency="VND" expectedAmountMinor={129000} orderId={ORDER_ID} />);
}

function fillReference(value: string) {
  fireEvent.change(screen.getByLabelText("Bank reference"), { target: { value } });
}

function fillAmount(value: string) {
  fireEvent.change(screen.getByLabelText("Amount received"), { target: { value } });
}

async function submitConfirm(expectedCallCount: number) {
  fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
  await waitFor(() => expect(confirmManualPaymentAction).toHaveBeenCalledTimes(expectedCallCount));
}

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(declineManualPaymentAction).mockResolvedValue({ status: "idle" });
});

it("exposes the six controls Task 12's end-to-end spec drives by accessible name", () => {
  renderPanel();
  expect(screen.getByLabelText("Bank reference")).toBeInTheDocument();
  expect(screen.getByLabelText("Reason")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Mark as not received" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Decline payment" })).toBeInTheDocument();
});

it("keeps confirm disabled on a mismatch until the override is ticked", async () => {
  vi.mocked(confirmManualPaymentAction).mockResolvedValue({ status: "mismatch", receivedMinor: 100000, expectedMinor: 129000 });
  renderPanel();
  fillReference("VCB-1");
  fillAmount("100000");

  await submitConfirm(1);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeDisabled();

  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();

  // Clicking the disabled button earlier must not have dispatched a second attempt.
  expect(confirmManualPaymentAction).toHaveBeenCalledTimes(1);
});

it("hides the stale banner and override the moment the amount no longer matches it, so a ticked override cannot be re-ticked back in", async () => {
  vi.mocked(confirmManualPaymentAction).mockResolvedValue({ status: "mismatch", receivedMinor: 100000, expectedMinor: 129000 });
  renderPanel();
  fillReference("VCB-1");
  fillAmount("100000");

  await submitConfirm(1);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();

  // The admin second-guesses the number on screen and edits it, without submitting first. The
  // banner and its override described 100,000 against 129,000; the field no longer says 100,000, so
  // neither the banner nor the override describes anything the admin can currently see.
  fillAmount("50000");

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  // The fix is that there is nothing left to re-tick, not merely that a tick got cleared: an admin
  // who sees a checkbox go unticked will often just tick it again as a reflex. With the checkbox
  // gone, that reflex has nothing to act on.
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  // Confirm is enabled again, but only because there is no mismatch left to gate it - submitting now
  // asks the server for a fresh verdict on 50,000, it does not smuggle through the old override.
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();

  await submitConfirm(2);
  const secondCallFormData = vi.mocked(confirmManualPaymentAction).mock.calls[1]![2] as FormData;
  expect(secondCallFormData.get("amount")).toBe("50000");
  expect(secondCallFormData.get("accept-mismatch")).toBeNull();
});

it("restores the banner, unticked, when the amount is edited back to the value it describes", async () => {
  vi.mocked(confirmManualPaymentAction).mockResolvedValue({ status: "mismatch", receivedMinor: 100000, expectedMinor: 129000 });
  renderPanel();
  fillReference("VCB-1");
  fillAmount("100000");

  await submitConfirm(1);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("checkbox"));

  fillAmount("50000");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  // Editing back to the exact number the banner described legitimately brings the banner back - but
  // it comes back unticked. Returning to a number is not the same as having just accepted it; the
  // admin ticks it again, deliberately, before Confirm re-enables.
  fillAmount("100000");
  await screen.findByRole("alert");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeDisabled();

  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();
});

it("does not let a tick ticked before an unrelated failure survive into a later, different mismatch", async () => {
  vi.mocked(confirmManualPaymentAction)
    .mockResolvedValueOnce({ status: "mismatch", receivedMinor: 100000, expectedMinor: 129000 })
    .mockResolvedValueOnce({ status: "error", message: "Something went wrong. Try again." })
    .mockResolvedValueOnce({ status: "mismatch", receivedMinor: 75000, expectedMinor: 129000 });
  renderPanel();
  fillReference("VCB-1");
  fillAmount("100000");

  await submitConfirm(1);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();

  // An unrelated failure - not a new mismatch - comes back on the second attempt, for the same
  // amount.
  await submitConfirm(2);
  await screen.findByText("Something went wrong. Try again.");

  // The admin tries a different amount, which lands on a fresh, different mismatch. Its checkbox
  // must start unticked.
  fillAmount("75000");
  await submitConfirm(3);
  // The previous error alert remains until the new action result is rendered.
  expect(await screen.findByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Confirm payment" })).toBeDisabled();
});

// The sixth accessible name - the queue's reference link, named by the reference code itself - is
// not this component's concern; it is rendered and asserted in app/admin/payments/page.test.tsx.
