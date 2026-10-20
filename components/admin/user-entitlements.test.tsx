import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { grantComplimentaryEntitlementAction, revokeComplimentaryEntitlementAction, type EntitlementActionResult } from "@/app/admin/users/[profileId]/entitlements/actions";
import { UserEntitlements } from "./user-entitlements";
import type { AdminUserEntitlementDTO } from "@/lib/data/users";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/admin/users/[profileId]/entitlements/actions", () => ({ grantComplimentaryEntitlementAction: vi.fn(), revokeComplimentaryEntitlementAction: vi.fn() }));
const row: AdminUserEntitlementDTO = { id: "e1", bookId: "b1", bookTitle: "Observe", sourceType: "admin_grant", status: "active", reason: "Reviewer", grantedAt: "2026-09-10", revokedAt: null };
function show(entitlements = [row], books = [{ id: "b1", title: "Observe" }, { id: "b2", title: "Another book" }]) {
  return render(<UserEntitlements profileId="p1" entitlements={entitlements} books={books} />);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(window, "prompt").mockReturnValue("Campaign ended"); });

it("only offers revocation for active complimentary grants", () => {
  show([row, { ...row, id: "e2", status: "revoked" }, { ...row, id: "e3", sourceType: "free_order" }, { ...row, id: "e4", sourceType: "simulated_payment" }]);
  expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  expect(screen.getByRole("table")).toBeVisible();
  // The absolute sr-only table labels need this positioned scroll container; otherwise
  // their static-position geometry can leak through to the document in the real page.
  expect(screen.getByRole("region", { name: "User entitlements" })).toHaveClass("relative", "overflow-x-auto");
});
it("keeps grant inputs after a failure and clears only the reason after a successful retry", async () => {
  vi.mocked(grantComplimentaryEntitlementAction).mockResolvedValueOnce({ ok: false, error: "Identity is not verified." }).mockResolvedValueOnce({ ok: true, entitlementId: "e1" });
  show();
  expect(screen.getByRole("button", { name: "Grant access" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Book"), { target: { value: "b2" } });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Early reviewer" } });
  fireEvent.submit(screen.getByRole("form", { name: "Grant complimentary access" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Identity is not verified."));
  expect(screen.getByLabelText("Book")).toHaveValue("b2");
  expect(screen.getByLabelText("Reason")).toHaveValue("Early reviewer");
  expect(refresh).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Grant access" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
  await waitFor(() => expect(screen.getByTestId("entitlement-message")).toHaveTextContent("Access granted."));
  expect(grantComplimentaryEntitlementAction).toHaveBeenLastCalledWith("p1", "b2", "Early reviewer");
  expect(screen.getByLabelText("Reason")).toHaveValue("");
  expect(refresh).toHaveBeenCalledOnce();
});
it("cancels revoke without submitting", () => {
  vi.mocked(window.prompt).mockReturnValue(null);
  show(); fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(revokeComplimentaryEntitlementAction).not.toHaveBeenCalled();
});
it("prompts for a reason and revokes the selected entitlement", async () => {
  vi.mocked(revokeComplimentaryEntitlementAction).mockResolvedValue({ ok: true, entitlementId: "e1" });
  show(); fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Access revoked."));
  expect(revokeComplimentaryEntitlementAction).toHaveBeenCalledWith("p1", "e1", "Campaign ended");
  expect(refresh).toHaveBeenCalledOnce();
});
it("preserves the revoke reason for retry and hides rejected transport details", async () => {
  vi.mocked(revokeComplimentaryEntitlementAction).mockRejectedValue(new Error("private detail"));
  show(); fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again."));
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(window.prompt).toHaveBeenLastCalledWith(expect.any(String), "Campaign ended");
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled());
  expect(screen.queryByText(/private detail/)).not.toBeInTheDocument();
});
it("disables all mutation controls while awaiting a result", async () => {
  let resolve!: (value: EntitlementActionResult) => void;
  vi.mocked(grantComplimentaryEntitlementAction).mockReturnValue(new Promise((done) => { resolve = done; }));
  show(); fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewer" } });
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" })).toBeDisabled());
  expect(screen.getByLabelText("Reason")).toBeDisabled();
  await act(async () => resolve({ ok: false, error: "Try again." }));
  expect(screen.getByLabelText("Reason")).toBeEnabled();
});
it("explains empty books and entitlements", () => {
  show([], []);
  expect(screen.getByText("No entitlements.")).toBeVisible();
  expect(screen.getByText("No books available to grant.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Grant access" })).toBeDisabled();
});
