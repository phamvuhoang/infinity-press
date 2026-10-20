import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CheckoutSepayPage from "@/app/[lang]/(account)/checkout/[orderId]/sepay/page";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({ findOrderIdByReference: vi.fn() }));
// The real component submits the form on mount, which jsdom cannot do.
vi.mock("@/app/[lang]/(account)/checkout/[orderId]/sepay/auto-submit-form", () => ({
  AutoSubmitForm: ({ action, fields, children }: { action: string; fields: Array<[string, string]>; children: React.ReactNode }) => (
    <form action={action} data-testid="sepay-form" method="post">
      {fields.map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} readOnly />
      ))}
      {children}
    </form>
  ),
}));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bundleId: null,
  title: "A Book",
  items: [{ bookId: "30000000-0000-4000-8000-000000000001", title: "A Book", hasActiveEntitlement: false }],
  status: "pending",
  paymentStatus: "pending",
  totalMinor: 89000,
  currency: "VND",
  subtotalMinor: 89000,
  discountMinor: 0,
  couponCode: null,
  createdAt: "2026-10-12T00:00:00Z",
  hasAllActiveEntitlements: false,
  referenceCode: "IB-7K2MX",
  provider: "sepay",
  claimedAt: null,
  declinedAt: null,
  declineReason: null,
};

const params = Promise.resolve({ lang: "en", orderId: ORDER_ID });
const STATUS = `/en/checkout/${ORDER_ID}/status`;
const sepay = { merchantId: "MERCHANT_TEST", secretKey: "secret_test_key", env: "sandbox" } as const;

function env(overrides: Record<string, unknown> = {}) {
  return { appEnv: "test", paymentProvider: "sepay", siteUrl: "https://books.test", sepay, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("CheckoutSepayPage", () => {
  it("renders the signed form for SePay's sandbox, in signing order, without the secret", async () => {
    const { container } = render(await CheckoutSepayPage({ params }));

    const form = screen.getByTestId("sepay-form");
    expect(form).toHaveAttribute("action", "https://pay-sandbox.sepay.vn/v1/checkout/init");
    const names = Array.from(form.querySelectorAll("input")).map((input) => input.name);
    expect(names).toEqual([
      "operation", "payment_method", "order_invoice_number", "order_amount", "currency",
      "order_description", "success_url", "error_url", "cancel_url", "merchant", "signature",
    ]);
    expect(form.querySelector<HTMLInputElement>('input[name="order_invoice_number"]')!.value).toBe("IB-7K2MX-89000");
    expect(form.querySelector<HTMLInputElement>('input[name="order_amount"]')!.value).toBe("89000");
    expect(form.querySelector<HTMLInputElement>('input[name="success_url"]')!.value).toBe(
      `https://books.test${STATUS}?sepay=success`,
    );
    expect(container.innerHTML).not.toContain("secret_test_key");
    expect(screen.getByRole("button", { name: "Continue to SePay" })).toBeInTheDocument();
  });

  it("asks for a signed-in reader itself", async () => {
    await CheckoutSepayPage({ params });
    expect(requireUser).toHaveBeenCalledWith("en", `/en/checkout/${ORDER_ID}/sepay`);
  });

  it("is not found for an order the reader does not own", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(CheckoutSepayPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["the order is already completed", { status: "completed", paymentStatus: "succeeded" }, {}],
    ["the reader already owns everything in it", { hasAllActiveEntitlements: true }, {}],
    ["the order was booked under another provider", { provider: "manual" }, {}],
    ["the deployment runs another provider", {}, { paymentProvider: "manual" }],
    ["the order is not in VND", { currency: "USD" }, {}],
  ])("sends the reader to the status page when %s", async (_label, orderOverrides, envOverrides) => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, ...orderOverrides } as CustomerOrderDTO);
    vi.mocked(getServerEnv).mockReturnValue(env(envOverrides));
    await expect(CheckoutSepayPage({ params })).rejects.toThrow(`NEXT_REDIRECT ${STATUS}`);
  });
});
