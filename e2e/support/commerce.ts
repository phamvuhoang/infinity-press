import { type Page, expect } from "@playwright/test";

import { createAnonClient, createServiceRoleClient } from "./supabase";

// S3 fixtures. Service role only, and createServiceRoleClient refuses any non-loopback Supabase URL,
// so none of this can touch the shared cloud project.

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

// For .single() reads, whose data is typed nullable even though an error is returned when no row exists.
function checkRow<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  const data = check(result);
  if (data === null || data === undefined) throw new Error("Expected exactly one row");
  return data;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The database half of the payments gate (S3 spec 4.2). The app half is PAYMENT_PROVIDER=simulator
// from playwright.config.ts.
//
// Both halves are written here because commerce_settings carries the provider too (S7):
// create_ebook_order books each order's payments row under commerce_settings.payment_provider, and
// the two suites share one local database. A simulator spec that left `manual` behind from a
// previous run would create orders no simulator surface can see.
export async function enablePayments(): Promise<void> {
  await setCommerceSettings("simulator");
}

async function setCommerceSettings(provider: "simulator" | "manual" | "sepay"): Promise<void> {
  check(
    await createServiceRoleClient()
      .from("commerce_settings")
      .update({ payments_enabled: true, payment_provider: provider })
      .eq("id", true),
  );
}

// The database half of the gate for the manual bank-transfer provider (S7). The app half is the
// second web server in playwright.config.ts, the one started with PAYMENT_PROVIDER=manual.
//
// Both halves must agree: this one decides which provider create_ebook_order books an order under,
// and the server's own one decides which pages and actions the reader and the admin get. Set one
// without the other and orders are created under a provider nothing on the site can act on.
export async function enableManualPayments(): Promise<void> {
  await setCommerceSettings("manual");
}

// The database half of the gate for SePay (S18). The app half is the third web server in
// playwright.config.ts.
export async function enableSepayPayments(): Promise<void> {
  await setCommerceSettings("sepay");
}

// Switches only the database half, for a provider-switch regression. Restores through
// enableSepayPayments in a finally.
export async function setProviderForRegression(provider: "manual" | "sepay"): Promise<void> {
  await setCommerceSettings(provider);
}

// The real authenticated create_ebook_order - the RPC the Buy button calls - as this reader, with
// no browser. A session comes from a magic-link token exchanged on an anon client, so the RPC sees
// auth.uid() exactly as it does in the app and its stale-order cancellation runs unmocked.
export async function bookEbookOrderAs(email: string, bookId: string): Promise<string> {
  const { data: link, error: linkError } = await createServiceRoleClient().auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError) throw linkError;
  const anon = createAnonClient();
  const { error: otpError } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
  if (otpError) throw otpError;
  const { data, error } = await anon.rpc("create_ebook_order", { p_book_id: bookId });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function orderState(orderId: string): Promise<{ status: string; paymentStatus: string; provider: string }> {
  const row = checkRow(
    await createServiceRoleClient()
      .from("orders")
      .select("status, payment_status, payment_provider")
      .eq("id", orderId)
      .single(),
  );
  return { status: row.status as string, paymentStatus: row.payment_status as string, provider: row.payment_provider as string };
}

// Recorded provider events for an order, by provider event ID.
export async function paymentEventCount(orderId: string, providerEventId: string): Promise<number> {
  const service = createServiceRoleClient();
  const payments = check(await service.from("payments").select("id").eq("order_id", orderId));
  const ids = (payments ?? []).map((payment) => payment.id as string);
  if (ids.length === 0) return 0;
  const { count, error } = await service
    .from("payment_events")
    .select("id", { count: "exact", head: true })
    .in("payment_id", ids)
    .eq("provider_event_id", providerEventId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function createReader(prefix: string, options: { admin?: boolean } = {}): Promise<{ email: string; profileId: string }> {
  const service = createServiceRoleClient();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const profile = checkRow(await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single());
  if (options.admin) {
    check(await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" }));
  }
  return { email, profileId: profile.id as string };
}

// A magic-link session without the email round trip. The UI sign-in flow is covered by the main buy
// journey and by magic-link.spec.ts.
export async function signInAs(page: Page, email: string, next: string): Promise<void> {
  const { data, error } = await createServiceRoleClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const locale = next.startsWith("/vi") ? "vi" : "en";
  await page.goto(`/auth/callback?${new URLSearchParams({ token_hash: data.properties.hashed_token, type: "email", next, locale })}`);
  // The legacy /read/{bookId} link resolves to the edition the reader owns, so the landing URL is the
  // edition's own reader page.
  const landing = escapeRegExp(next).replace(/\/read\/[0-9a-f-]{36}$/, "/read\/editions\/[0-9a-f-]{36}");
  await expect(page).toHaveURL(new RegExp(`${landing}$`));
}

export async function profileIdForEmail(email: string): Promise<string> {
  const row = checkRow(
    await createServiceRoleClient().from("customer_identities").select("profile_id").eq("normalized_email", email.toLowerCase()).single(),
  );
  return row.profile_id as string;
}

export async function activeEntitlementCount(profileId: string, bookId: string): Promise<number> {
  const { count, error } = await createServiceRoleClient()
    .from("entitlements")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("book_id", bookId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function orderCountForBook(profileId: string, bookId: string): Promise<number> {
  const { count, error } = await createServiceRoleClient()
    .from("order_items")
    .select("order_id, orders!inner(profile_id)", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("orders.profile_id", profileId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// Every book this profile can read right now. A bundle journey asserts over a SET of books rather
// than one, and a gift journey asserts that the purchaser's set is empty - which
// activeEntitlementCount, asked one book at a time, can only ever approximate.
export async function activeEntitlementBookIds(profileId: string): Promise<string[]> {
  const { data, error } = await createServiceRoleClient()
    .from("entitlements")
    .select("book_id")
    .eq("profile_id", profileId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.book_id as string);
}

// Total active entitlements, however they were granted. `activeEntitlementBookIds().length` would
// answer a different question: this one counts ROWS, so a duplicated grant for one book is visible
// here and invisible there. A claim that ran twice is exactly that shape.
export async function activeEntitlementRowCount(profileId: string): Promise<number> {
  const { count, error } = await createServiceRoleClient()
    .from("entitlements")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return count ?? 0;
}
