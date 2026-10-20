// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { requireAdmin } from "@/lib/auth/admin";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { getAdminUser, normalizeEmailQuery, searchUsers } from "@/lib/data/users";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
const profileId = "b1b2c3d4-0000-4000-8000-000000000001";
type SessionClient = Awaited<ReturnType<typeof createClient>>;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>); });

it("escapes LIKE wildcards and backslashes after trimming and lowercasing", () => {
  expect(normalizeEmailQuery("  An_Nguyen%@Example.test ")).toBe("an\\_nguyen\\%@example.test");
  expect(normalizeEmailQuery("a\\b")).toBe("a\\\\b");
});
it.each(["", "ab", "  a% ", "__"])("does not query a short search: %s", async (query) => {
  await expect(searchUsers(query)).resolves.toEqual([]);
  expect(createClient).not.toHaveBeenCalled();
});
it.each([() => searchUsers("abc"), () => getAdminUser(profileId)])("blocks DAL reads before creating a client", async (read) => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
  await expect(read()).rejects.toThrow("NEXT_FORBIDDEN");
  expect(createClient).not.toHaveBeenCalled();
});
it("maps linked identities to minimal search DTOs", async () => {
  const fake = fakeSupabaseClient({ tables: { customer_identities: { data: [
    { profile_id: profileId, normalized_email: "an@example.test", verified_at: "2026-09-01", profile: { display_name: "An" } },
    { profile_id: null, normalized_email: "pending@example.test", verified_at: null, profile: null },
  ], error: null } } });
  vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
  await expect(searchUsers("an@ex")).resolves.toEqual([{ profileId, email: "an@example.test", displayName: "An", verified: true }]);
});
it("builds user details with Vietnamese-first titles and null identity defaults", async () => {
  const row = { id: "e1", book_id: "b1", source_type: "admin_grant", status: "active", reason: "Reviewer", granted_at: "2026-09-10", revoked_at: null };
  const fake = fakeSupabaseClient({ tables: {
    profiles: { data: { id: profileId, display_name: "An" }, error: null },
    user_roles: { data: { role: "admin" }, error: null },
    entitlements: { data: [
      { ...row, book: { canonical_key: "observe", localizations: [{ locale: "en", title: "Observe" }, { locale: "vi", title: "Quan sát" }] } },
      { ...row, id: "e2", book: { canonical_key: "fallback", localizations: [] } },
      { ...row, id: "e3", book: null },
    ], error: null },
  } });
  vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
  const user = await getAdminUser(profileId);
  expect(user).toMatchObject({ profileId, email: null, displayName: "An", verified: false, isAdmin: true });
  expect(user.entitlements[0]).toEqual({ id: "e1", bookId: "b1", bookTitle: "Quan sát", sourceType: "admin_grant", status: "active", reason: "Reviewer", grantedAt: "2026-09-10", revokedAt: null });
  expect(user.entitlements.map((row) => row.bookTitle)).toEqual(["Quan sát", "fallback", "Unknown book"]);
});
it("returns not-found for malformed IDs without reading the database", async () => {
  await expect(getAdminUser("invalid")).rejects.toThrow("NEXT_NOT_FOUND");
  expect(createClient).not.toHaveBeenCalled();
});
it("returns not-found for missing profiles", async () => {
  vi.mocked(createClient).mockResolvedValue(fakeSupabaseClient({}).client as SessionClient);
  await expect(getAdminUser(profileId)).rejects.toThrow("NEXT_NOT_FOUND");
});
it.each(["profiles", "customer_identities", "user_roles", "entitlements"])("hides raw %s failures", async (table) => {
  vi.mocked(createClient).mockResolvedValue(fakeSupabaseClient({ tables: { [table]: { data: null, error: { message: "private SQL detail" } } } }).client as SessionClient);
  await expect(getAdminUser(profileId)).rejects.toThrow("Unable to load user.");
});
it("hides raw search failures", async () => {
  vi.mocked(createClient).mockResolvedValue(fakeSupabaseClient({ tables: { customer_identities: { data: null, error: { message: "private SQL detail" } } } }).client as SessionClient);
  await expect(searchUsers("abc")).rejects.toThrow("Unable to search users.");
});
