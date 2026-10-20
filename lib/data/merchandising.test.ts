// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { getMerchandising, setMerchandising } from "@/lib/data/merchandising";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const a = "3a1b2c3d-0000-4000-8000-000000000001";
const b = "3a1b2c3d-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("merchandising", () => {
  it("splits rows into the featured book and the ordered shelf", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        merchandising_slots: {
          data: [
            { slot_key: "home_shelf", book_id: b, position: 1 },
            { slot_key: "home_featured", book_id: a, position: 1 },
            { slot_key: "home_shelf", book_id: a, position: 2 },
          ],
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(getMerchandising()).resolves.toEqual({ featuredBookId: a, shelfBookIds: [b, a] });
  });

  it("replaces a slot through the atomic merchandising RPC", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await setMerchandising({ slotKey: "home_shelf", bookIds: [b, a] });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_merchandising", { p_slot_key: "home_shelf", p_book_ids: [b, a] });
  });
});
