import { beforeEach, expect, it, vi } from "vitest";

import MerchandisingPage from "@/app/admin/merchandising/page";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { getMerchandising } from "@/lib/data/merchandising";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ listAdminBooks: vi.fn() }));
vi.mock("@/lib/data/merchandising", () => ({ getMerchandising: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

it("denies merchandising page access before loading its data", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

  await expect(MerchandisingPage()).rejects.toThrow("NEXT_FORBIDDEN");

  expect(getMerchandising).not.toHaveBeenCalled();
  expect(listAdminBooks).not.toHaveBeenCalled();
});
