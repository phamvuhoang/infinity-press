import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminGiftsPage from "@/app/admin/gifts/page";
import { requireAdmin } from "@/lib/auth/admin";
import { searchAdminGifts, type AdminGiftDTO } from "@/lib/data/gifts";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/gifts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/gifts")>();
  return { ...original, searchAdminGifts: vi.fn() };
});

const giftId = "f9000000-0000-0000-0000-000000000001";

const gift: AdminGiftDTO = {
  id: giftId,
  orderId: "f8000000-0000-0000-0000-000000000001",
  referenceCode: "IB-A0001",
  purchaserEmail: "purchaser@example.test",
  recipientEmail: "recipient@example.test",
  itemTitles: ["Admin One", "Admin Two"],
  itemCount: 2,
  status: "sent",
  claimLocale: "vi",
  createdAt: "2026-09-22T00:00:00.000Z",
  claimedAt: null,
  revokedAt: null,
  attemptCount: 5,
  lastErrorCode: "smtp_timeout",
  sentAt: null,
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(searchAdminGifts).mockResolvedValue([gift]);
});

it("authorizes before searching, naming its own page as the sign-in destination", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));

  await expect(AdminGiftsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("Forbidden");

  expect(searchAdminGifts).not.toHaveBeenCalled();
});

it("passes the operator's query through and keeps it in the search box", async () => {
  render(await AdminGiftsPage({ searchParams: Promise.resolve({ q: "IB-A0001" }) }));

  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/gifts" });
  expect(searchAdminGifts).toHaveBeenCalledWith("IB-A0001");
  expect(screen.getByRole("searchbox", { name: /order reference/i })).toHaveValue("IB-A0001");
});

it("takes the first value when the query arrives repeated", async () => {
  render(await AdminGiftsPage({ searchParams: Promise.resolve({ q: ["IB-A0001", "other"] }) }));

  expect(searchAdminGifts).toHaveBeenCalledWith("IB-A0001");
});

it("shows the reference, both addresses, what the gift covers, its status and its timestamps", async () => {
  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  const [row] = screen.getAllByRole("row").slice(1);
  expect(within(row).getByRole("link", { name: "IB-A0001" })).toHaveAttribute(
    "href",
    "/admin/orders/f8000000-0000-0000-0000-000000000001",
  );
  expect(row).toHaveTextContent("purchaser@example.test");
  expect(row).toHaveTextContent("recipient@example.test");
  expect(row).toHaveTextContent("Admin One");
  expect(row).toHaveTextContent("Admin Two");
  expect(row).toHaveTextContent("sent");
  expect(within(row).getByText(/5 attempts/)).toBeInTheDocument();
  expect(within(row).getByText(/smtp_timeout/)).toBeInTheDocument();
});

it("summarizes a long list of titles by count rather than printing all of them", async () => {
  vi.mocked(searchAdminGifts).mockResolvedValue([
    { ...gift, itemTitles: ["One", "Two", "Three", "Four"], itemCount: 4 },
  ]);

  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.getByText(/4 books/)).toBeInTheDocument();
});

it("offers resend and reissue for a sent gift", async () => {
  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.getByRole("button", { name: /resend/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /reissue/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/new recipient/i)).toBeRequired();
  expect(screen.getByLabelText(/reason/i)).toBeRequired();
  // The reissue keeps the recipient in the language they were first written to.
  expect(screen.getByLabelText(/language/i)).toHaveValue("vi");
});

it("offers neither action on a claimed gift, and says where its access is withdrawn", async () => {
  vi.mocked(searchAdminGifts).mockResolvedValue([
    { ...gift, status: "claimed", claimedAt: "2026-09-22T01:00:00.000Z", claimLocale: null, attemptCount: null },
  ]);

  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.queryByRole("button", { name: /resend/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reissue/i })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /revoke access on the order/i })).toHaveAttribute(
    "href",
    "/admin/orders/f8000000-0000-0000-0000-000000000001",
  );
});

// Neither RPC accepts anything but a `sent` gift: reissuing an unpaid one would set it to `sent`
// and hand the recipient a claimable link for an order nobody paid for, because claim_gift gates
// on gift status alone.
it("offers neither action on an unpaid gift", async () => {
  vi.mocked(searchAdminGifts).mockResolvedValue([
    { ...gift, status: "pending", claimLocale: null, attemptCount: 0, lastErrorCode: null },
  ]);

  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.queryByRole("button", { name: /resend/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reissue/i })).not.toBeInTheDocument();
  expect(screen.getByText(/waiting for payment/i)).toBeInTheDocument();
});

it("offers neither action on a revoked gift", async () => {
  vi.mocked(searchAdminGifts).mockResolvedValue([
    { ...gift, status: "revoked", revokedAt: "2026-09-22T01:00:00.000Z" },
  ]);

  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.queryByRole("button", { name: /resend/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reissue/i })).not.toBeInTheDocument();
});

it("never renders a claim link", async () => {
  const { container } = render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(container.innerHTML).not.toMatch(/gifts\/claim/);
});

it("explains an empty result", async () => {
  vi.mocked(searchAdminGifts).mockResolvedValue([]);

  render(await AdminGiftsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.getByText("No gifts match this search.")).toBeInTheDocument();
});
