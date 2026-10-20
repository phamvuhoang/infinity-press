import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

import { seedBundle, seedCatalogBook } from "./support/catalog";
import { createReader, enablePayments, signInAs } from "./support/commerce";
import { markOutboxFailedFourTimes } from "./support/database";
import { soleEditionId } from "./support/editions";
import { serverEnvironmentValue } from "./support/server-env";
import { grantEntitlement } from "./support/publication";
import { createServiceRoleClient } from "./support/supabase";

// Task 6 (storefront static caching): the formatting `lib/catalog/price.ts` uses, duplicated
// rather than imported. Nothing under `e2e/` imports the app's `@/lib` tree today, and this is two
// lines - not worth being the first to find out whether Playwright's transform resolves tsconfig
// path aliases the same way Next's does.
const currencyMinorDigits: Record<string, number> = { VND: 0 };
function formatPriceLike(priceMinor: number, currency: string, locale: "vi" | "en"): string {
  const digits = currencyMinorDigits[currency] ?? 2;
  const major = priceMinor / 10 ** digits;
  return new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US", { style: "currency", currency }).format(major);
}

// S5 launch acceptance. Removing canonical or alternate metadata, the JSON-LD escaping, a sitemap or
// robots rule, the stored-redirect lookup, a private noindex layout, the /admin/operations gate or
// one of its rule loaders, the entitlement outbox trigger, the worker's bearer check, or the
// outbox lease must fail here. Mail goes only through the no-network test adapter
// (EMAIL_PROVIDER=test in playwright.config.ts); nothing here can reach Resend.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// The secret the web server under test was given: the shell's (CI exports its own) or the default.
const OPS_WORKER_SECRET = serverEnvironmentValue("OPS_WORKER_SECRET");

// The app's own origin, which is what SITE_URL is set to for the web server under test.
function siteOrigin(page: Page): string {
  return new URL(page.url()).origin;
}

function check<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as NonNullable<T>;
}

// Task 6: what a crawler or answer engine actually receives - the raw response, never a hydrated
// page. request.get() sends no cookies a browser session would have attached and runs no
// JavaScript, which is the point: a page.goto() assertion proves the wrong thing here, because
// hydration could paper over server HTML that never had the content at all.
//
// A tiny hand-rolled reader rather than a DOM library: nothing else under e2e/ parses HTML (the
// existing sitemap test regexes XML the same way), and pulling in a new dependency's types for one
// spec file is not worth it. It only needs to find self-closing <link>/<meta> tags by attribute and
// <script type="application/ld+json"> bodies - not to understand the document.
type RawPage = { status: number; body: string };

async function fetchRaw(request: APIRequestContext, path: string): Promise<RawPage> {
  const response = await request.get(path, { headers: { "user-agent": "Googlebot" } });
  const body = await response.text();
  return { status: response.status(), body };
}

function htmlLang(body: string): string | null {
  return /<html[^>]*\slang="([^"]*)"/i.exec(body)?.[1] ?? null;
}

function titleText(body: string): string | null {
  return /<title>([^<]*)<\/title>/i.exec(body)?.[1] ?? null;
}

// Reads an attribute's value off the first tag whose attributes contain every one of `match`, in
// any order - which is what's needed for e.g. `link[rel="alternate"][hreflang="en"]` without a
// real CSS engine.
function tagAttr(body: string, tagName: string, match: Record<string, string>, want: string): string | null {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  for (const tag of body.matchAll(tagPattern)) {
    // React serializes some HTML attributes in DOM-property casing (hreflang -> hrefLang), so the
    // attribute name is matched case-insensitively; the value is still an exact match.
    const ok = Object.entries(match).every(([name, value]) => new RegExp(`\\b${name}="${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i").test(tag[0]));
    if (!ok) continue;
    const wanted = new RegExp(`\\b${want}="([^"]*)"`, "i").exec(tag[0]);
    if (wanted) return wanted[1];
  }
  return null;
}

function hasRobotsNoindex(body: string): boolean {
  return /<meta\s+name="robots"/i.test(body);
}

function jsonLdBlocks(body: string): unknown[] {
  // No `s` flag (the repo targets ES2017): JSON-LD content never contains a literal `<`, same
  // assumption the sitemap test's own XML regexes make, so `[^<]*` stands in for dotAll.
  return [...body.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((match) => JSON.parse(match[1]));
}

// A book or bundle page renders exactly ONE ld+json script whose content is an array
// [entity, breadcrumbs] (components/seo/json-ld.tsx), not one script per entity - the existing
// page.goto() SEO test parses it the same way. This unwraps that single script's first element.
function firstJsonLdEntity(body: string): Record<string, unknown> {
  const [block] = jsonLdBlocks(body) as [unknown[]];
  return block[0] as Record<string, unknown>;
}

type AnalyticsRow = {
  event_name: string;
  dedupe_key: string | null;
  profile_id: string | null;
  book_id: string | null;
  order_id: string | null;
  publication_id: string | null;
  processing_job_id: string | null;
  locale: string | null;
  device_class: string | null;
};

const analyticsColumns =
  "event_name, dedupe_key, profile_id, book_id, order_id, publication_id, processing_job_id, locale, device_class";

// Browser events arrive by beacon after the page has rendered, so the row is polled for rather than
// read once. The filter is the event's own identifying column, never a timestamp.
async function waitForAnalyticsRow(eventName: string, column: "book_id" | "order_id" | "profile_id", value: string) {
  let row: AnalyticsRow | undefined;
  await expect
    .poll(
      async () => {
        const { data, error } = await createServiceRoleClient()
          .from("analytics_events")
          .select(analyticsColumns)
          .eq("event_name", eventName)
          .eq(column, value);
        if (error) throw new Error(error.message);
        row = (data as AnalyticsRow[])[0];
        return data.length;
      },
      { message: `${eventName} row for ${column}=${value}`, timeout: 15_000 },
    )
    .toBe(1);
  return row!;
}

async function runWorker(request: APIRequestContext, authorization?: string) {
  return request.post("/api/operations/run", {
    headers: authorization ? { authorization } : {},
    // A body-less POST with no Origin: the worker is a server-to-server call from pg_net.
  });
}

test.beforeAll(async () => {
  await enablePayments();
});

test("a published book page carries canonical, alternate, Open Graph, and safe structured data", async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const slug = `harbour-seo-${suffix}`;
  const viSlug = `ben-cang-seo-${suffix}`;
  // A title a careless serializer would let close the JSON-LD script element early.
  const title = `Harbour </script><script>window.__s5Breakout = 1</script> ${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title }, vi: { slug: viSlug, title: `Bến cảng ${suffix}` } },
    priceMinor: 129000,
  });

  // An action-error query is a view of the page, never part of its identity.
  await page.goto(`/en/books/${slug}?action-error=unexpected`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  const origin = siteOrigin(page);
  const self = `${origin}/en/books/${slug}`;

  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", self);
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute("href", self);
  await expect(page.locator('link[rel="alternate"][hreflang="vi"]')).toHaveAttribute("href", `${origin}/vi/books/${viSlug}`);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", self);
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "en_US");
  await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveAttribute("content", "vi_VN");
  await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute("content", /\/covers\//);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

  // The title's "</script>" stayed inside the JSON string: nothing it smuggled in ran, and the
  // single structured-data element still parses to exactly the displayed title.
  expect(await page.evaluate(() => (window as unknown as { __s5Breakout?: number }).__s5Breakout)).toBeUndefined();
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).not.toContain("</script>");
  const [book, breadcrumbs] = JSON.parse(scripts[0]) as [Record<string, unknown>, Record<string, unknown>];

  expect(book).toMatchObject({
    "@context": "https://schema.org",
    "@type": "Book",
    name: title,
    url: self,
    inLanguage: "en",
    author: { "@type": "Person", name: `E2E Author ${suffix}`, url: `${origin}/en/authors/e2e-author-en-${suffix}` },
    // S14: `offers` is an array - the ebook Offer first, then one paperback Offer per retailer link.
    offers: [{ "@type": "Offer", priceCurrency: "VND", availability: "https://schema.org/InStock", url: self }],
  });
  expect(typeof (book.offers as { price: unknown }[])[0].price).toBe("number");
  expect(breadcrumbs).toEqual({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Infinity Books Press", item: `${origin}/en` },
      { "@type": "ListItem", position: 2, name: expect.any(String), item: `${origin}/en/books` },
      { "@type": "ListItem", position: 3, name: title, item: self },
    ],
  });

  // The browser beacon records the view with identifiers only.
  const view = await waitForAnalyticsRow("view_book", "book_id", bookId);
  expect(view).toMatchObject({ locale: "en", profile_id: null, order_id: null, publication_id: null, processing_job_id: null });
  expect(view.dedupe_key).toMatch(/^client\/[0-9a-f-]{36}$/);
  expect(view.device_class).toBe("desktop");

  // A sorted catalog and a search both point their canonical at the query-free route.
  await page.goto("/en/books?sort=title");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${origin}/en/books`);
  await expect(page.locator('link[rel="alternate"][hreflang="vi"]')).toHaveAttribute("href", `${origin}/vi/books`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
  await page.goto(`/vi/search?${new URLSearchParams({ q: `ben cang ${suffix}` })}`);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${origin}/vi/search`);
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute("href", `${origin}/en/search`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
});

test("the sitemap lists a book once an admin publishes it, never drafts or private routes, and robots names it", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const slug = `sitemap-harbour-${suffix}`;
  const viSlug = `so-do-ben-cang-${suffix}`;
  const draftSlug = `sitemap-draft-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Sitemap Harbour ${suffix}` }, vi: { slug: viSlug, title: `Sơ đồ ${suffix}` } },
    status: "draft",
  });
  await seedCatalogBook({
    suffix: `${suffix}-draft`,
    localizations: { en: { slug: draftSlug, title: `Sitemap Draft ${suffix}` } },
    status: "draft",
  });

  // Publishing through the editor is what revalidates the cached sitemap (revalidateStorefront).
  const admin = await createReader("sitemap-admin", { admin: true });
  await signInAs(page, admin.email, `/admin/books/${bookId}`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish book" }).click();
  await expect(page.getByTestId("book-publish-message")).toHaveText("Book published.");
  const origin = siteOrigin(page);

  let sitemap = "";
  await expect
    .poll(
      async () => {
        const response = await request.get("/sitemap.xml");
        expect(response.status()).toBe(200);
        sitemap = await response.text();
        return sitemap.includes(`<loc>${origin}/en/books/${slug}</loc>`);
      },
      { message: "the published book reaches the sitemap", timeout: 30_000 },
    )
    .toBe(true);

  expect(sitemap).toContain(`<loc>${origin}/vi/books/${viSlug}</loc>`);
  expect(sitemap).toContain(`<loc>${origin}/en</loc>`);
  expect(sitemap).toContain(`<loc>${origin}/vi/books</loc>`);
  expect(sitemap).not.toContain(draftSlug);
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]));
  expect(locs.length).toBeGreaterThan(0);
  for (const url of locs) {
    expect(url.origin).toBe(origin);
    expect(url.search).toBe("");
    expect(url.pathname).not.toMatch(
      /^\/(admin|api|auth|internal)(\/|$)|^\/(vi|en)\/(account|checkout|library|read|read-sample|search|sign-in|sign-up|password-reset|password-update)(\/|$)/,
    );
  }

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const rules = await robots.text();
  expect(rules).toContain(`Sitemap: ${origin}/sitemap.xml`);
  expect(rules).toContain("Allow: /");
  for (const path of ["/admin", "/api", "/auth", "/internal", "/en/account", "/vi/checkout", "/en/library", "/vi/read/", "/en/read-sample", "/vi/search", "/en/sign-in"]) {
    expect(rules).toContain(`Disallow: ${path}\n`);
  }
});

test("a stored redirect returns 308 to its exact destination and drops the old query", async ({ request }) => {
  const suffix = unique();
  const source = `/en/old-harbour-${suffix}`;
  const destination = `/en/books/new-harbour-${suffix}`;
  const unsafeSource = `/en/escape-${suffix}`;
  const service = createServiceRoleClient();
  check(
    await service.from("redirects").insert([
      { source_path: source, destination_path: destination },
      // Allowed by the table's check constraint, refused by the resolver: a protocol-relative
      // destination would leave the site.
      { source_path: unsafeSource, destination_path: "//evil.example/steal" },
    ]),
  );

  for (const method of ["GET", "HEAD"] as const) {
    const response = await request.fetch(`${source}?utm_source=old-link&ref=1`, { method, maxRedirects: 0 });
    expect(response.status(), method).toBe(308);
    const location = new URL(response.headers()["location"], "http://relative-base.invalid");
    expect(location.pathname).toBe(destination);
    expect(location.search).toBe("");
    expect(response.headers()["x-request-id"]).toBeTruthy();
  }

  const unsafe = await request.get(unsafeSource, { maxRedirects: 0 });
  expect(unsafe.status()).toBe(404);
  expect(unsafe.headers()["location"]).toBeUndefined();
});

test("private surfaces stay non-indexable and only admins open /admin/operations", async ({ page }) => {
  // Signed out, a private customer route lands on sign-in, which is itself noindex.
  await page.goto("/en/library");
  await expect(page).toHaveURL(/\/en\/sign-in\?next=%2Fen%2Flibrary$/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");

  await page.goto("/admin/operations");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fadmin%2Foperations/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");

  const reader = await createReader("ops-denied");
  await signInAs(page, reader.email, "/en/account");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  const denied = await page.goto("/admin/operations");
  expect(denied?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations" })).toHaveCount(0);
});

test("buying and opening the library record begin_checkout and view_library without sensitive values", async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const slug = `checkout-events-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Checkout Events ${suffix}` } },
    priceMinor: 90000,
  });
  const reader = await createReader("events-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);
  const orderId = /\/en\/checkout\/([0-9a-f-]{36})$/.exec(page.url())![1];

  const checkout = await waitForAnalyticsRow("begin_checkout", "order_id", orderId);
  expect(checkout).toEqual({
    event_name: "begin_checkout",
    dedupe_key: `checkout/${orderId}`,
    profile_id: reader.profileId,
    book_id: bookId,
    order_id: orderId,
    publication_id: null,
    processing_job_id: null,
    locale: "en",
    device_class: null,
  });

  await page.goto("/en/library");
  const library = await waitForAnalyticsRow("view_library", "profile_id", reader.profileId);
  expect(library).toMatchObject({
    event_name: "view_library",
    book_id: null,
    order_id: null,
    publication_id: null,
    processing_job_id: null,
    locale: "en",
    device_class: "desktop",
  });
  expect(library.dedupe_key).toMatch(/^client\/[0-9a-f-]{36}$/);
});

test("an admin sees each seeded operational fault with its repair link, but not a deliberate revocation", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const service = createServiceRoleClient();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug: `ops-harbour-${suffix}`, title: `Ops Harbour ${suffix}` } },
  });
  const customer = await createReader("ops-customer");
  const edition = check(await service.from("editions").select("id").eq("book_id", bookId).single());

  // 1. A queued EPUB job nobody has touched for 45 minutes.
  const asset = check(
    await service
      .from("ebook_assets")
      .insert({ edition_id: edition.id, source_storage_key: `e2e/${suffix}/stale.epub`, version: 2, status: "queued" })
      .select("id")
      .single(),
  );
  check(
    await service.from("processing_jobs").insert({
      target_id: asset.id,
      status: "queued",
      correlation_id: `e2e-stale-${suffix}`,
      created_at: minutesAgo(45),
      updated_at: minutesAgo(45),
    }),
  );

  // 2. A completed order that never received its entitlement.
  const order = (status: "completed" | "pending") => ({
    profile_id: customer.profileId,
    status,
    payment_status: status === "completed" ? "succeeded" : "pending",
    market_code: "VN",
    currency: "VND",
    total_minor: 50000,
  });
  const brokenOrder = check(await service.from("orders").insert(order("completed")).select("id").single());

  // 3. A payment event received ten minutes ago and never processed.
  const pendingOrder = check(await service.from("orders").insert(order("pending")).select("id").single());
  const payment = check(
    await service
      .from("payments")
      .insert({ order_id: pendingOrder.id, provider: "simulator", status: "pending", amount_minor: 50000, currency: "VND" })
      .select("id")
      .single(),
  );
  check(
    await service.from("payment_events").insert({
      payment_id: payment.id,
      provider: "simulator",
      provider_event_id: `e2e-unprocessed-${suffix}`,
      payload_hash: "0".repeat(64),
      received_at: minutesAgo(10),
    }),
  );

  // 4. A book-ready email that has failed four times.
  const recipient = await createReader("ops-recipient");
  await grantEntitlement(bookId, recipient.email);
  const outbox = check(
    await service.from("notification_outbox").select("id").eq("profile_id", recipient.profileId).single(),
  );
  markOutboxFailedFourTimes(outbox.id);

  // Not a fault: a completed order whose order-backed entitlement an admin deliberately revoked.
  const revokedOrder = check(await service.from("orders").insert(order("completed")).select("id").single());
  check(
    await service.from("entitlements").insert({
      profile_id: customer.profileId,
      book_id: bookId,
      source_type: "simulated_payment",
      source_order_id: revokedOrder.id,
      status: "revoked",
      revoked_at: new Date().toISOString(),
    }),
  );

  const admin = await createReader("ops-admin", { admin: true });
  await signInAs(page, admin.email, "/admin/operations");
  await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");

  const section = (label: string) =>
    page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(`^${label} \\(\\d+\\)$`) }) });
  const expectRepairLink = async (label: string, href: string) => {
    const link = section(label).locator(`a[href="${href}"]`);
    await expect(link, `${label} -> ${href}`).toHaveCount(1);
    await expect(link).toHaveText("Review");
  };

  await expectRepairLink("Stale EPUB jobs", `/admin/books/${bookId}/editions/${await soleEditionId(bookId)}#epub`);
  await expectRepairLink("Completed orders without an entitlement", `/admin/orders/${brokenOrder.id}`);
  await expectRepairLink("Unprocessed payment events", `/admin/orders/${pendingOrder.id}`);
  await expectRepairLink("Stuck book-ready emails", `/admin/users/${recipient.profileId}`);
  await expect(page.locator(`a[href="/admin/orders/${revokedOrder.id}"]`)).toHaveCount(0);
  // The page is an admin view of IDs and links; no customer email reaches it.
  await expect(page.getByText(customer.email)).toHaveCount(0);
  await expect(page.getByText(recipient.email)).toHaveCount(0);

  // The scheduled worker sees the same four faults and records each rule as an active alert state.
  const run = await runWorker(request, `Bearer ${OPS_WORKER_SECRET}`);
  expect(run.status()).toBe(200);
  const { findings } = (await run.json()) as { findings: Record<string, number> };
  for (const rule of ["stale_epub_job", "missing_order_entitlement", "unprocessed_payment_event", "stuck_notification"]) {
    expect(findings[rule], rule).toBeGreaterThanOrEqual(1);
  }
  const states = check(await service.from("operations_alert_state").select("rule_name, active"));
  expect(Object.fromEntries(states.map((state) => [state.rule_name, state.active]))).toEqual({
    stale_epub_job: true,
    missing_order_entitlement: true,
    unprocessed_payment_event: true,
    stuck_notification: true,
    // S7's rule has a row like every other rule, and this spec seeds no bank transfer report, so it
    // must be evaluated and inactive. Asserting the whole map rather than the four faults is what
    // catches a rule that was added to lib/ops but never given a row to write into - which is
    // exactly what happened, and it made every worker run return 500.
    //
    // It stays inactive across repeated runs on the same database because confirming or declining a
    // transfer releases the reader's claim, so manual-payment.spec.ts leaves none behind. A claim
    // left over from a manual run that died mid-test would show up here as `true`; that is a dirty
    // database, and `npm run db:reset` is the answer to it.
    unreviewed_manual_transfer_claim: false,
    // S13's rule: this spec seeds no reader question, so it is evaluated and inactive.
    stale_reader_question: false,
  });
});

test("the worker demands its secret, returns counts only, and sends a new entitlement's email exactly once", async ({ request }) => {
  test.setTimeout(120_000);

  // Missing, wrong, and malformed (the right secret without the Bearer scheme).
  for (const authorization of [undefined, "Bearer wrong-secret-of-sufficient-length-000000000", OPS_WORKER_SECRET]) {
    const denied = await runWorker(request, authorization);
    expect(denied.status()).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized", requestId: expect.any(String) });
  }

  const suffix = unique();
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug: `outbox-harbour-${suffix}`, title: `Outbox Harbour ${suffix}` } },
  });
  const reader = await createReader("outbox-reader");
  await grantEntitlement(bookId, reader.email);
  // A second grant while the first is active succeeds without a new entitlement - and must not
  // queue a second email.
  await grantEntitlement(bookId, reader.email);

  const service = createServiceRoleClient();
  const entitlements = check(
    await service.from("entitlements").select("id, status").eq("profile_id", reader.profileId).eq("book_id", bookId),
  );
  expect(entitlements).toEqual([{ id: expect.any(String), status: "active" }]);
  const rows = check(
    await service.from("notification_outbox").select("id, entitlement_id, template_key").eq("profile_id", reader.profileId),
  );
  expect(rows).toEqual([{ id: expect.any(String), entitlement_id: entitlements[0].id, template_key: "book_ready" }]);
  const outboxId = rows[0].id as string;

  const authorized = `Bearer ${OPS_WORKER_SECRET}`;
  const readRow = async () =>
    check(
      await service
        .from("notification_outbox")
        .select("sent_at, provider_message_id, attempt_count, lease_token")
        .eq("id", outboxId)
        .single(),
    );

  // Two workers at once, repeatedly, until this row goes out: other specs' rows may be ahead of it
  // in the 25-row claim. skip-locked claims keep the two runs from ever holding the same row.
  for (let round = 0; round < 20 && !(await readRow()).sent_at; round += 1) {
    const responses = await Promise.all([runWorker(request, authorized), runWorker(request, authorized)]);
    for (const response of responses) {
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(["alertsSent", "findings", "outbox", "requestId"]);
      expect(Object.keys(body.outbox).sort()).toEqual(["claimed", "failed", "sent"]);
      expect(Object.keys(body.findings).sort()).toEqual([
        "missing_order_entitlement",
        "stale_epub_job",
        "stale_reader_question",
        "stuck_notification",
        "unprocessed_payment_event",
        "unreviewed_manual_transfer_claim",
      ]);
      for (const value of [...Object.values(body.outbox), ...Object.values(body.findings), body.alertsSent]) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(response.headers()["x-request-id"]).toBe(body.requestId);
      // Every claimed row is accounted for once; a row can never be sent without being claimed.
      expect(body.outbox.sent + body.outbox.failed).toBeLessThanOrEqual(body.outbox.claimed);
    }
  }

  const delivered = await readRow();
  expect(delivered).toMatchObject({ provider_message_id: `test/book-ready/${outboxId}`, attempt_count: 0, lease_token: null });
  expect(delivered.sent_at).toBeTruthy();

  // Two more concurrent runs leave the sent row exactly as it was.
  await Promise.all([runWorker(request, authorized), runWorker(request, authorized)]);
  expect(await readRow()).toEqual(delivered);
});

// ---------------------------------------------------------------------------------------------
// Task 6 (storefront static caching). Everything below runs against the production build that
// playwright.config.ts's default webServer already produces (`npm run build && npm run start`) -
// this repo never pointed this suite at `next dev`. A manifest (Task 5's build guard) can say a
// route prerendered; it cannot say the canonical is right, that <html lang> survived the split
// into three root layouts (Task 1), or that the book's prose is still in the HTML after four
// things moved into the browser (Tasks 2-4). This section asserts on the raw response a crawler or
// answer engine actually gets - request.get(), never page.goto() - and then proves five ways a
// prerendered page can go stale: publish, reprice, unpublish, rename, and translate.

async function saveAdminForm(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  const form = page.locator("form").filter({ has: button });
  await button.click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
}

test("a crawler reads a published book's canonical, alternates, and substance from raw HTML, in both locales", async ({ request }) => {
  test.setTimeout(60_000);
  const suffix = unique();
  const slugs = { en: `crawler-harbour-${suffix}`, vi: `crawler-ben-cang-${suffix}` };
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: {
      en: { slug: slugs.en, title: `Crawler Harbour ${suffix}` },
      vi: { slug: slugs.vi, title: `Bến cảng ${suffix}` },
    },
    priceMinor: 149000,
    withSubstance: true,
  });
  void bookId;

  for (const locale of ["en", "vi"] as const) {
    const other = locale === "en" ? "vi" : "en";
    const path = `/${locale}/books/${slugs[locale]}`;
    const { status, body } = await fetchRaw(request, path);
    expect(status, path).toBe(200);

    expect(htmlLang(body)).toBe(locale);
    expect(titleText(body)).toContain(locale === "en" ? `Crawler Harbour ${suffix}` : `Bến cảng ${suffix}`);
    expect(tagAttr(body, "meta", { name: "description" }, "content")).toBe(`Short copy ${suffix}`);

    const canonical = tagAttr(body, "link", { rel: "canonical" }, "href");
    expect(canonical).toMatch(new RegExp(`${path}$`));
    const selfOrigin = new URL(canonical!).origin;
    expect(tagAttr(body, "link", { rel: "alternate", hreflang: locale }, "href")).toBe(`${selfOrigin}${path}`);
    expect(tagAttr(body, "link", { rel: "alternate", hreflang: other }, "href")).toBe(`${selfOrigin}/${other}/books/${slugs[other]}`);
    expect(tagAttr(body, "link", { rel: "alternate", hreflang: "x-default" }, "href")).toBeTruthy();

    expect(hasRobotsNoindex(body)).toBe(false);

    const book = firstJsonLdEntity(body);
    expect(book["@type"]).toBe("Book");
    expect(book.name).toBe(locale === "en" ? `Crawler Harbour ${suffix}` : `Bến cảng ${suffix}`);

    // The LLMO-relevant assertion: an answer engine reading the page without running JavaScript
    // still gets the substance, and this fails loudly if a future island takes prose with it.
    for (const needle of [
      `Long copy ${suffix}`,
      `Audience copy ${locale} ${suffix}`,
      `Key idea ${locale} ${suffix}`,
      `FAQ question ${locale} ${suffix}`,
      `FAQ answer ${locale} ${suffix}`,
    ]) {
      expect(body, `${path} missing "${needle}"`).toContain(needle);
    }

    // Internal links to the author, series and topic pages.
    expect(body).toContain(`/${locale}/authors/e2e-author-${locale}-${suffix}`);
    expect(body).toContain(`/${locale}/series/e2e-series-${locale}-${suffix}`);
    expect(body).toContain(`/${locale}/topics/e2e-topic-${locale}-${suffix}`);
  }
});

test("a book localized in only one locale emits no alternate for the other", async ({ request }) => {
  const suffix = unique();
  const slug = `solo-ben-cang-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { vi: { slug, title: `Solo ${suffix}` } }, priceMinor: 50000 });

  const { status, body } = await fetchRaw(request, `/vi/books/${slug}`);
  expect(status).toBe(200);
  expect(tagAttr(body, "link", { rel: "alternate", hreflang: "vi" }, "href")).toBeTruthy();
  expect(tagAttr(body, "link", { rel: "alternate", hreflang: "en" }, "href")).toBeNull();
  // vi is defaultLocale (lib/i18n/config.ts), so x-default falls back to the one page this book has.
  expect(tagAttr(body, "link", { rel: "alternate", hreflang: "x-default" }, "href")).toBe(
    tagAttr(body, "link", { rel: "alternate", hreflang: "vi" }, "href"),
  );
});

test.describe("freshness matrix - each row seeds through the admin path, then re-fetches the raw page", () => {
  test("publishing a new book makes its detail page answer 200 with correct metadata and reach the sitemap", async ({ page, request }) => {
    test.setTimeout(90_000);
    const suffix = unique();
    const slug = `fresh-publish-${suffix}`;
    const title = `Fresh Publish ${suffix}`;
    const { bookId } = await seedCatalogBook({
      suffix,
      localizations: { en: { slug, title } },
      priceMinor: 80000,
      status: "draft",
    });

    // Before publishing, the page is not indexable - it doesn't exist yet, publicly.
    const before = await request.get(`/en/books/${slug}`);
    expect(before.status()).toBe(404);

    const admin = await createReader("fresh-publish-admin", { admin: true });
    await signInAs(page, admin.email, `/admin/books/${bookId}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Publish book" }).click();
    await expect(page.getByTestId("book-publish-message")).toHaveText("Book published.");

    // This is the plan's narrowest and most important check: does revalidatePath("/[lang]",
    // "layout") actually reach a prerendered /[lang]/books/[slug]? If this row fails, that is the
    // defect to report - not a reason to shorten `revalidate`.
    await expect
      .poll(async () => (await request.get(`/en/books/${slug}`)).status(), {
        message: "the published book's own page answers 200",
        timeout: 30_000,
      })
      .toBe(200);

    const { body } = await fetchRaw(request, `/en/books/${slug}`);
    expect(titleText(body)).toContain(title);
    expect(hasRobotsNoindex(body)).toBe(false);

    await expect
      .poll(async () => (await (await request.get("/sitemap.xml")).text()).includes(`<loc>${new URL(page.url()).origin}/en/books/${slug}</loc>`), {
        message: "the published book reaches the sitemap",
        timeout: 30_000,
      })
      .toBe(true);
  });

  test("changing an offer price changes the visible price and the JSON-LD offers.price together", async ({ page, request }) => {
    test.setTimeout(60_000);
    const suffix = unique();
    const slug = `fresh-reprice-${suffix}`;
    const { bookId } = await seedCatalogBook({
      suffix,
      localizations: { en: { slug, title: `Fresh Reprice ${suffix}` } },
      priceMinor: 100000,
    });

    const before = await fetchRaw(request, `/en/books/${slug}`);
    expect(before.body).toContain(formatPriceLike(100000, "VND", "en"));
    const beforeLd = firstJsonLdEntity(before.body) as unknown as { offers: { price: number }[] };
    expect(beforeLd.offers[0].price).toBe(100000);

    const admin = await createReader("fresh-reprice-admin", { admin: true });
    await signInAs(page, admin.email, `/admin/books/${bookId}/editions/${await soleEditionId(bookId)}`);
    await page.locator("#offer-priceMinor").fill("175000");
    await saveAdminForm(page, "Save offer");

    await expect
      .poll(async () => (await fetchRaw(request, `/en/books/${slug}`)).body.includes(formatPriceLike(175000, "VND", "en")), {
        message: "the repriced page shows the new visible price",
        timeout: 30_000,
      })
      .toBe(true);

    const after = await fetchRaw(request, `/en/books/${slug}`);
    expect(after.body).not.toContain(formatPriceLike(100000, "VND", "en"));
    const afterLd = firstJsonLdEntity(after.body) as unknown as { offers: { price: number }[] };
    expect(afterLd.offers[0].price).toBe(175000);
  });

  test("unpublishing a book stops its detail page being served as an indexable product page", async ({ page, request }) => {
    test.setTimeout(60_000);
    const suffix = unique();
    const slug = `fresh-unpublish-${suffix}`;
    const { bookId } = await seedCatalogBook({
      suffix,
      localizations: { en: { slug, title: `Fresh Unpublish ${suffix}` } },
      priceMinor: 60000,
    });

    expect((await request.get(`/en/books/${slug}`)).status()).toBe(200);

    const admin = await createReader("fresh-unpublish-admin", { admin: true });
    await signInAs(page, admin.email, `/admin/books/${bookId}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Unpublish book" }).click();
    await expect(page.getByTestId("book-publish-message")).toHaveText("Book unpublished.");

    await expect
      .poll(async () => (await request.get(`/en/books/${slug}`)).status(), {
        message: "the unpublished book's page stops answering 200",
        timeout: 30_000,
      })
      .toBe(404);

    const sitemap = await (await request.get("/sitemap.xml")).text();
    expect(sitemap).not.toContain(slug);
  });

  test("changing a slug redirects the old URL and serves the new one", async ({ page, request }) => {
    test.setTimeout(60_000);
    const suffix = unique();
    const oldSlug = `fresh-slug-old-${suffix}`;
    const newSlug = `fresh-slug-new-${suffix}`;
    const { bookId } = await seedCatalogBook({
      suffix,
      localizations: { en: { slug: oldSlug, title: `Fresh Slug ${suffix}` } },
      priceMinor: 40000,
    });
    // Deliberately no request for the old slug here first: proxy.ts's stored-redirect lookup
    // (lib/redirects/resolve.ts) caches a miss for REDIRECT_CACHE_TTL_MS (60s) per exact path,
    // process-local. Asking about a path before its redirect exists would poison that cache with a
    // negative entry and make the assertion below flaky for up to a minute - a real gotcha, not a
    // defect (the cache's own comment says correctness never depends on it, only latency does).

    const admin = await createReader("fresh-slug-admin", { admin: true });
    await signInAs(page, admin.email, `/admin/books/${bookId}`);
    await page.getByLabel("Slug (en)").fill(newSlug);
    await saveAdminForm(page, "Save en copy");

    await expect
      .poll(async () => (await request.get(`/en/books/${newSlug}`)).status(), {
        message: "the renamed book's new URL answers 200",
        timeout: 30_000,
      })
      .toBe(200);

    const redirected = await request.get(`/en/books/${oldSlug}`, { maxRedirects: 0 });
    expect(redirected.status()).toBe(308);
    expect(new URL(redirected.headers()["location"], "http://relative-base.invalid").pathname).toBe(`/en/books/${newSlug}`);
  });

  // Press: a page exists for a locale only when the work resolves to a readable edition there, so the
  // work starts in the platform's default language (the default edition's language) and gains a
  // second localization of its page.
  test("adding the other locale's translation makes both pages' hreflang point at each other", async ({ page, request }) => {
    test.setTimeout(60_000);
    const suffix = unique();
    const enSlug = `fresh-translate-en-${suffix}`;
    const { bookId } = await seedCatalogBook({
      suffix,
      localizations: { en: { slug: enSlug, title: `Fresh Translate EN ${suffix}` } },
      priceMinor: 45000,
    });

    const before = await fetchRaw(request, `/en/books/${enSlug}`);
    expect(tagAttr(before.body, "link", { rel: "alternate", hreflang: "vi" }, "href")).toBeNull();

    const viSlug = `fresh-translate-${suffix}`;
    const admin = await createReader("fresh-translate-admin", { admin: true });
    await signInAs(page, admin.email, `/admin/books/${bookId}`);
    await page.getByLabel("Title (vi)", { exact: true }).fill(`Fresh Translate ${suffix}`);
    await page.getByLabel("Slug (vi)").fill(viSlug);
    await page.getByLabel("Description (vi)", { exact: true }).fill(`Bản tiếng Việt ${suffix}`);
    await saveAdminForm(page, "Save vi copy");

    await expect
      .poll(
        async () => tagAttr((await fetchRaw(request, `/en/books/${enSlug}`)).body, "link", { rel: "alternate", hreflang: "vi" }, "href"),
        { message: "the en page gains a vi alternate", timeout: 30_000 },
      )
      .toContain(`/vi/books/${viSlug}`);

    // The vi page shows the same (English) edition under Vietnamese copy: its own page, pointing back.
    const vi = await fetchRaw(request, `/vi/books/${viSlug}`);
    expect(tagAttr(vi.body, "link", { rel: "alternate", hreflang: "en" }, "href")).toContain(`/en/books/${enSlug}`);
  });
});

test("a signed-in reader never sees a flash of Sign in, and the header corrects a book from buy to read", async ({ page }) => {
  test.setTimeout(60_000);
  const suffix = unique();
  const slug = `owner-correction-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Owner Correction ${suffix}` } },
    priceMinor: 90000,
  });
  const reader = await createReader("owner-correction-reader");
  await grantEntitlement(bookId, reader.email);

  await signInAs(page, reader.email, `/en/books/${slug}`);

  // Scoped to the header's own landmark: the home page a sign-out redirects to also has an
  // unrelated "Library" link in its body copy (app/[lang]/(public)/page.tsx), always present
  // regardless of auth state, which an unscoped role query would collide with.
  const nav = page.getByRole("navigation", { name: "Primary navigation" });

  // The prerendered page said "buy" (an anonymous visitor's view) - the island must correct it to
  // what the signed-in owner can actually do, without ever having shown the anonymous sign-in
  // prompt on the way there.
  await expect(page.getByRole("link", { name: "Read now" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);

  // The header's account nav: an owner who is signed in sees Library, never a flash of Sign in.
  await expect(nav.getByRole("link", { name: "Library" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);

  // A real sign-out click flips the nav via the browser's own auth state, not a guess made ahead
  // of the server confirming it.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(nav.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Library" })).toHaveCount(0);
});

test("a bundle that exists but is not localized in the requested locale 404s from its action-state route", async ({ request }) => {
  test.setTimeout(60_000);
  const suffix = unique();
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { vi: { slug: `bundle-member-${suffix}`, title: `Bundle Member ${suffix}` } },
    priceMinor: 30000,
  });
  const { bundleId } = await seedBundle({
    suffix,
    bookIds: [bookId],
    // Localized in vi only - this fixture didn't exist anywhere in the seed catalog before Task 6;
    // Task 4 accepted the 404 behaviour on reasoning and deferred exercising it here.
    localizations: { vi: { slug: `bundle-solo-${suffix}`, title: `Bundle Solo ${suffix}` } },
    priceMinor: 120000,
  });

  const missingLocale = await request.get(`/api/catalog/bundles/${bundleId}/action-state?locale=en`);
  expect(missingLocale.status()).toBe(404);

  const validLocale = await request.get(`/api/catalog/bundles/${bundleId}/action-state?locale=vi`);
  expect(validLocale.status()).toBe(200);
});
