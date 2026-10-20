import "server-only";
import { defaultLocale } from "@/lib/i18n/config";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { createClient } from "@/lib/supabase/server";

export type AdminUserSearchResultDTO = { profileId: string; email: string; displayName: string | null; verified: boolean };

export type AdminUserEntitlementDTO = {
  id: string;
  bookId: string;
  bookTitle: string;
  sourceType: "free_order" | "admin_grant" | "simulated_payment" | "manual_payment" | "sepay_payment";
  status: "active" | "revoked";
  reason: string | null;
  grantedAt: string;
  revokedAt: string | null;
};

export type AdminUserDTO = {
  profileId: string;
  email: string | null;
  displayName: string | null;
  verified: boolean;
  isAdmin: boolean;
  entitlements: AdminUserEntitlementDTO[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeEmailQuery(query: string): string {
  return query.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`);
}

type IdentityRow = {
  profile_id: string | null;
  normalized_email: string;
  verified_at: string | null;
  profile: { display_name: string | null } | null;
};

// Reads go through the session client under the admin read policies from 20260913100000.
export async function searchUsers(query: string): Promise<AdminUserSearchResultDTO[]> {
  await requireAdmin();
  const needle = normalizeEmailQuery(query);
  if (query.trim().length < 3) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customer_identities")
    .select("profile_id, normalized_email, verified_at, profile:profiles ( display_name )")
    .ilike("normalized_email", `%${needle}%`)
    .order("normalized_email")
    .limit(25);
  if (error) throw new Error("Unable to search users.");

  return ((data ?? []) as unknown as IdentityRow[])
    .filter((row): row is IdentityRow & { profile_id: string } => row.profile_id !== null)
    .map((row) => ({
      profileId: row.profile_id,
      email: row.normalized_email,
      displayName: row.profile?.display_name ?? null,
      verified: row.verified_at !== null,
    }));
}

type EntitlementRow = {
  id: string;
  book_id: string;
  source_type: AdminUserEntitlementDTO["sourceType"];
  status: AdminUserEntitlementDTO["status"];
  reason: string | null;
  granted_at: string;
  revoked_at: string | null;
  book: { canonical_key: string; localizations: { locale: string; title: string }[] } | null;
};

function bookTitle(book: EntitlementRow["book"]): string {
  if (!book) return "Unknown book";
  const localized = book.localizations.find((row) => row.locale === defaultLocale) ?? book.localizations[0];
  return localized?.title ?? book.canonical_key;
}

export async function getAdminUser(profileId: string): Promise<AdminUserDTO> {
  await requireAdmin();
  if (!uuidPattern.test(profileId)) notFound();

  const supabase = await createClient();
  const [profile, identity, role, entitlements] = await Promise.all([
    supabase.from("profiles").select("id, display_name").eq("id", profileId).maybeSingle(),
    supabase.from("customer_identities").select("normalized_email, verified_at").eq("profile_id", profileId).maybeSingle(),
    supabase.from("user_roles").select("role").eq("profile_id", profileId).maybeSingle(),
    supabase
      .from("entitlements")
      .select("id, book_id, source_type, status, reason, granted_at, revoked_at, book:books ( canonical_key, localizations:book_localizations ( locale, title ) )")
      .eq("profile_id", profileId)
      .order("granted_at", { ascending: false }),
  ]);

  for (const result of [profile, identity, role, entitlements]) {
    if (result.error) throw new Error("Unable to load user.");
  }
  if (!profile.data) notFound();

  const identityRow = identity.data as { normalized_email: string; verified_at: string | null } | null;
  const profileRow = profile.data as { id: string; display_name: string | null };

  return {
    profileId: profileRow.id,
    email: identityRow?.normalized_email ?? null,
    displayName: profileRow.display_name,
    verified: Boolean(identityRow?.verified_at),
    isAdmin: (role.data as { role: string } | null)?.role === "admin",
    entitlements: ((entitlements.data ?? []) as unknown as EntitlementRow[]).map((row) => ({
      id: row.id,
      bookId: row.book_id,
      bookTitle: bookTitle(row.book),
      sourceType: row.source_type,
      status: row.status,
      reason: row.reason,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    })),
  };
}
