// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentProfile } from "@/lib/data/profiles";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const profileRow = {
  id: "profile-1",
  auth_user_id: "auth-1",
  display_name: "Reader One",
  locale: "vi",
};

const getUser = vi.fn();
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "auth-1" } }, error: null });
  maybeSingle.mockResolvedValue({ data: profileRow, error: null });
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser },
    from,
  } as unknown as Awaited<ReturnType<typeof createClient>>);
});

describe("getCurrentProfile", () => {
  it("returns null and reads no rows when nobody is signed in", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });

    expect(await getCurrentProfile()).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("returns only the renderable columns of the caller's own profile", async () => {
    expect(await getCurrentProfile()).toEqual(profileRow);
    expect(from).toHaveBeenCalledWith("profiles");
    expect(select).toHaveBeenCalledWith("id, auth_user_id, display_name, locale");
    expect(eq).toHaveBeenCalledWith("auth_user_id", "auth-1");
  });

  it("returns null when the query errors", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    expect(await getCurrentProfile()).toBeNull();
  });

  it("returns null when the signed-in user has no profile row", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });

    expect(await getCurrentProfile()).toBeNull();
  });
});
