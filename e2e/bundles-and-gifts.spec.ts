import { type APIRequestContext, type Page, expect, test } from "@playwright/test";

import { seedBundle, seedCatalogBook } from "./support/catalog";
import {
  activeEditionEntitlementCount,
  activeEntitlementBookIds,
  activeEntitlementCount,
  activeEntitlementRowCount,
  createReader,
  enablePayments,
  profileIdForEmail,
  signInAs,
} from "./support/commerce";
import { readGiftDelivery } from "./support/database";
import { countMessagesFor, readLatestLink } from "./support/mailpit";
import { addPublishedEdition, soleEditionId } from "./support/editions";
import { grantEntitlement } from "./support/publication";
import { serverEnvironmentValue } from "./support/server-env";
import { createAnonClient, createServiceRoleClient } from "./support/supabase";

// S9 acceptance, the gift half of the two golden paths (spec 9-10), plus the one cross-feature
// branch the two golden paths do not reach: a bundle bought AS a gift, paid with a 100% code.
//
// The bundle purchase journey the exit criteria name ends at an admin confirming a bank transfer,
// so it lives in e2e/bundle-purchase.spec.ts and runs against the manual web server. Everything
// here needs the simulator, which is the server this project points at.
//
// Token discipline in this file (spec 7.1). The claim path is read from the protected outbox
// payload through e2e/support/database.ts, is held in a local variable, and is never logged, never
// put in a test title, and never written to an artefact. The recipient address is likewise only
// ever typed into a field and passed to a fixture.
//
// A trace is an artefact, and the config's `trace: "retain-on-failure"` plus the two CI retries
// would record the claim navigation - URL and all - into one whenever this spec failed. A live
// token in a CI artefact is a credential somewhere nobody looks for one, so this file, and only
// this file, opts out of trace capture. Every other spec keeps it.
test.use({ trace: "off" });

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const checkoutUrl = /\/en\/checkout\/([0-9a-f-]{36})$/;
const OPS_WORKER_SECRET = serverEnvironmentValue("OPS_WORKER_SECRET");

test.beforeAll(async () => {
  await enablePayments();
});

// The scheduled worker, called the way pg_net calls it: a body-less, session-less POST carrying
// only the bearer secret. This is what actually delivers a gift's claim message.
async function runOperationsWorker(request: APIRequestContext): Promise<{ sent: number }> {
  const response = await request.post("/api/operations/run", {
    headers: { authorization: `Bearer ${OPS_WORKER_SECRET}` },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { outbox: { sent: number; failed: number } };
  expect(body.outbox.failed).toBe(0);
  return { sent: body.outbox.sent };
}

// One group of the claim page. The two groups are plain <section>s carrying an <h2>, and a section
// with no accessible name has no role at all, so they are reached through the heading they own
// rather than through a role that is not there.
function claimGroup(page: Page, heading: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: heading }) });
}

test("a purchaser gifts a book, and the recipient signs in, claims it, and reads it", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const slug = `gift-lantern-${suffix}`;
  const title = `Gift Lantern ${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 129000 });

  const purchaser = await createReader("gift-purchaser");
  // Never a pre-existing reader: the point of the journey is that a gift reaches somebody who has
  // no account at all until the claim link brings them here.
  const recipientEmail = `gift-recipient-${suffix}@example.test`;

  await signInAs(page, purchaser.email, `/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];

  // Arrange the gift before paying: the gift block sits above Pay because a paid order can no
  // longer be turned into one.
  await page.getByLabel("Recipient email").fill(recipientEmail);
  await page.getByLabel("Message (optional)").fill("Happy birthday - hope you like this one.");
  await page.getByRole("button", { name: "Save gift" }).click();
  await expect(page.getByText(`This order is a gift for ${recipientEmail}`)).toBeVisible();

  // Configured but not payable-for yet: the claim link exists and is deliberately not due to send.
  const configured = readGiftDelivery(orderId)!;
  expect(configured.giftStatus).toBe("pending");
  expect(configured.sentAt).toBeNull();
  expect(configured.claimPath).toMatch(/^\/en\/gifts\/claim\/[A-Za-z0-9_-]+$/);

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/simulate$`));
  await page.getByRole("button", { name: "Succeed", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/status$`));
  // A gift purchaser is told the gift is on its way, never that an ebook is waiting in their
  // library - it will never be there. The library call to action is absent for the same reason.
  await expect(page.getByRole("heading", { level: 1, name: "Your gift is on its way" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your library" })).toHaveCount(0);

  // The whole point of a gift order: the person who paid gets nothing.
  expect(await activeEntitlementRowCount(purchaser.profileId)).toBe(0);
  const paid = readGiftDelivery(orderId)!;
  expect(paid.giftStatus).toBe("sent");
  expect(paid.sentAt).toBeNull();

  // The message goes out only when the worker runs.
  const run = await runOperationsWorker(request);
  expect(run.sent).toBeGreaterThanOrEqual(1);
  const delivered = readGiftDelivery(orderId)!;
  expect(delivered.sentAt).not.toBeNull();
  expect(delivered.attemptCount).toBe(0);
  expect(delivered.lastErrorCode).toBeNull();
  expect(delivered.providerMessageId).toBe(`test/gift-claim/${delivered.outboxId}`);
  const claimPath = delivered.claimPath!;
  const token = claimPath.split("/").pop()!;

  // That send went through the no-network adapter, so the one mail in the product that carries a
  // live credential in its body has not entered any SMTP inbox.
  expect(await countMessagesFor(recipientEmail)).toBe(0);

  // The recipient opens the link on their own device, signed out and with no account.
  const recipientContext = await browser.newContext();
  const recipientPage = await recipientContext.newPage();
  await recipientPage.goto(claimPath);

  // The bounce carries the token in `next` and in nothing else - no parameter of its own, no
  // cookie - so the single copy the browser keeps is the destination it is already headed for.
  const bounce = new URL(recipientPage.url());
  expect(bounce.pathname).toBe("/en/sign-in");
  expect([...bounce.searchParams.keys()]).toEqual(["next"]);
  expect(bounce.searchParams.get("next")).toBe(claimPath);
  expect((await recipientContext.cookies()).some((cookie) => cookie.value.includes(token))).toBe(false);

  await recipientPage.getByLabel("Email").fill(recipientEmail);
  await recipientPage.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(recipientPage.getByText("Check your email and follow the secure link to continue.")).toBeVisible();
  await recipientPage.goto(await readLatestLink(recipientEmail));

  // Signing in returns them to the claim, which claims on arrival.
  await expect(recipientPage).toHaveURL(new RegExp(`${claimPath}$`));
  await expect(recipientPage.getByRole("heading", { level: 1, name: "Your gift" })).toBeVisible();
  await expect(claimGroup(recipientPage, "Added to your library").getByRole("link", { name: title })).toBeVisible();
  // Nothing was already owned, so that group is absent rather than empty.
  await expect(claimGroup(recipientPage, "Already in your library")).toHaveCount(0);
  // A claim URL is a credential in a link and must never be indexed.
  await expect(recipientPage.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  const recipientProfileId = await profileIdForEmail(recipientEmail);
  expect(await activeEntitlementBookIds(recipientProfileId)).toEqual([bookId]);
  expect(await activeEntitlementRowCount(recipientProfileId)).toBe(1);
  // Still nothing for the purchaser, now that the gift has actually been claimed.
  expect(await activeEntitlementRowCount(purchaser.profileId)).toBe(0);

  // Refreshing is a replay, not a second grant: the same one book, and no second entitlement row.
  await recipientPage.reload();
  await expect(recipientPage.getByRole("heading", { level: 1, name: "Your gift" })).toBeVisible();
  await expect(recipientPage.getByRole("link", { name: title })).toBeVisible();
  expect(await activeEntitlementRowCount(recipientProfileId)).toBe(1);

  // The claimed gift's payload is cleared, so the stored copy of the credential is gone.
  const claimed = readGiftDelivery(orderId)!;
  expect(claimed.giftStatus).toBe("claimed");
  expect(claimed.claimPath).toBeNull();

  await recipientPage.getByRole("link", { name: title }).click();
  await expect(recipientPage).toHaveURL(/\/en\/read\/editions\/[0-9a-f-]{36}$/);
  await expect(recipientPage.getByRole("heading", { level: 1, name: title })).toBeAttached();
  await recipientContext.close();
});

// The highest-risk branch neither golden path reaches: a BUNDLE bought as a GIFT and paid for with
// a 100% code. Three S9 features meet here - multi-item orders, bundle coupon scope, and the gift
// claim - and the claim has to add every member book the recipient is missing while leaving the
// one they already own exactly as it is.
test("a fully discounted bundle gift adds only the books the recipient is missing", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const owned = { slug: `gift-set-owned-${suffix}`, title: `Gift Set Owned ${suffix}` };
  const missing = { slug: `gift-set-missing-${suffix}`, title: `Gift Set Missing ${suffix}` };
  const bundleSlug = `gift-set-${suffix}`;
  const bundleTitle = `Gift Set ${suffix}`;
  const code = `TESTER-${suffix.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase()}`;

  const ownedBook = await seedCatalogBook({ suffix: `${suffix}-o`, localizations: { en: owned }, priceMinor: 129000 });
  const missingBook = await seedCatalogBook({ suffix: `${suffix}-m`, localizations: { en: missing }, priceMinor: 99000 });
  const { bundleId } = await seedBundle({
    suffix,
    bookIds: [ownedBook.bookId, missingBook.bookId],
    localizations: { en: { slug: bundleSlug, title: bundleTitle } },
    priceMinor: 189000,
  });

  // The recipient already has one of the two books. They are a real reader here rather than a
  // stranger because that pre-existing library is the whole point of this case.
  const recipient = await createReader("gift-bundle-recipient");
  await grantEntitlement(ownedBook.bookId, recipient.email);
  expect(await activeEntitlementRowCount(recipient.profileId)).toBe(1);

  // The code is issued through the admin screen: coupons and coupon_bundles have no service-role
  // grant at all, so there is no fixture path into them - which makes this the acceptance test for
  // bundle coupon scope as well.
  const admin = await createReader("gift-bundle-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/coupons");
  await adminPage.getByRole("link", { name: "New coupon" }).click();
  await adminPage.getByLabel("Code").fill(code);
  await adminPage.getByLabel("Percentage off").fill("100");
  // Exact, and scoped to the Bundles fieldset: both fieldsets list every row in the catalog, and
  // getByLabel matches on substring by default.
  await adminPage.getByRole("group", { name: "Bundles" }).getByLabel(bundleTitle, { exact: true }).check();
  await adminPage.getByRole("button", { name: "Create coupon" }).click();
  await expect(adminPage.getByRole("heading", { name: code })).toBeVisible();
  await adminContext.close();

  const purchaser = await createReader("gift-bundle-purchaser");
  await signInAs(page, purchaser.email, `/en/bundles/${bundleSlug}`);
  await page.getByRole("button", { name: "Buy bundle" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];

  await page.getByLabel("Recipient email").fill(recipient.email);
  await page.getByRole("button", { name: "Save gift" }).click();
  await expect(page.getByText(`This order is a gift for ${recipient.email}`)).toBeVisible();

  // The code takes the total to zero, and the order completes inside the RPC. No payment page, no
  // simulator, no transfer: the purchaser goes straight to their library, which for a gift order
  // is the honest destination precisely because nothing has been added to it.
  await page.getByLabel("Enter a code").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/library$/);
  expect(await activeEntitlementRowCount(purchaser.profileId)).toBe(0);
  await expect(page.getByText(bundleTitle)).toHaveCount(0);
  await expect(page.getByText(owned.title)).toHaveCount(0);
  await expect(page.getByText(missing.title)).toHaveCount(0);

  const paid = readGiftDelivery(orderId)!;
  expect(paid.giftStatus).toBe("sent");
  await runOperationsWorker(request);
  const delivered = readGiftDelivery(orderId)!;
  expect(delivered.sentAt).not.toBeNull();
  expect(delivered.lastErrorCode).toBeNull();
  const claimPath = delivered.claimPath!;

  // This recipient already has an account, and journey one above already proves the signed-out
  // bounce, so this one arrives signed in and goes straight to the claim.
  const recipientContext = await browser.newContext();
  const recipientPage = await recipientContext.newPage();
  await signInAs(recipientPage, recipient.email, claimPath);

  await expect(recipientPage.getByRole("heading", { level: 1, name: "Your gift" })).toBeVisible();
  const added = claimGroup(recipientPage, "Added to your library");
  await expect(added.getByRole("link", { name: missing.title })).toBeVisible();
  await expect(added.getByRole("link", { name: owned.title })).toHaveCount(0);
  // The pre-owned book is reported, not hidden and not granted again.
  const alreadyOwned = claimGroup(recipientPage, "Already in your library");
  await expect(alreadyOwned.getByRole("link", { name: owned.title })).toBeVisible();
  await expect(alreadyOwned.getByRole("link", { name: missing.title })).toHaveCount(0);

  expect([...new Set(await activeEntitlementBookIds(recipient.profileId))].sort()).toEqual(
    [ownedBook.bookId, missingBook.bookId].sort(),
  );
  // Two books, three rows: the gift grants its own entitlement beside the recipient's complimentary
  // one for the pre-owned book, so revoking either leaves the other.
  expect(await activeEntitlementRowCount(recipient.profileId)).toBe(3);
  expect(await activeEntitlementCount(recipient.profileId, ownedBook.bookId)).toBe(2);

  await recipientPage.reload();
  await expect(recipientPage.getByRole("heading", { level: 1, name: "Your gift" })).toBeVisible();
  expect(await activeEntitlementRowCount(recipient.profileId)).toBe(3);

  // A bundle is never a library item, however it was paid for or given.
  await recipientPage.goto("/en/library");
  // The shelf list, not a bare text match - see the note in e2e/bundle-purchase.spec.ts. Two
  // entries and no more is the point of this case: the pre-owned book must not have been shelved
  // a second time by the claim.
  const shelf = recipientPage.locator("section[aria-labelledby='shelf-title'] ul");
  await expect(shelf.getByRole("listitem")).toHaveCount(2);
  await expect(shelf.getByRole("listitem").filter({ hasText: owned.title })).toHaveCount(1);
  await expect(shelf.getByRole("listitem").filter({ hasText: missing.title })).toHaveCount(1);
  await expect(recipientPage.getByText(bundleTitle)).toHaveCount(0);
  expect((await recipientPage.goto(`/en/read/${bundleId}`))?.status()).toBe(404);
  await recipientContext.close();
});

// Press: a bundle holds editions, and a gift keeps the editions it was bought with. The bundle here is
// English + Japanese of one work; the recipient already owns the English edition; the admin then
// replaces the bundle's membership before the gift is claimed. The claim must still add exactly the
// Japanese edition - the snapshot - and nothing from the edited bundle.
test("a gift keeps the editions it was bought with, however the bundle is edited before it is claimed", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const bundleSlug = `pair-gift-${suffix}`;
  const bundleTitle = `Pair Gift ${suffix}`;
  const code = `PAIR-${suffix.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase()}`;
  const work = { slug: `pair-work-${suffix}`, title: `Pair Work ${suffix}` };
  const other = { slug: `pair-other-${suffix}`, title: `Pair Other ${suffix}` };
  const japaneseTitle = `対の作品 ${suffix}`;

  const workBook = await seedCatalogBook({ suffix: `${suffix}-w`, localizations: { en: work }, priceMinor: 129000 });
  const otherBook = await seedCatalogBook({ suffix: `${suffix}-x`, localizations: { en: other }, priceMinor: 99000 });
  // The recipient owns the English edition before a second edition of the work exists.
  const recipient = await createReader("pair-recipient");
  await grantEntitlement(workBook.bookId, recipient.email);
  expect(await activeEntitlementRowCount(recipient.profileId)).toBe(1);
  const english = await soleEditionId(workBook.bookId);
  const japanese = await addPublishedEdition(workBook.bookId, "ja", suffix, [["VN", "VND", 150000]], japaneseTitle);
  const otherEdition = await soleEditionId(otherBook.bookId);
  const { bundleId } = await seedBundle({
    suffix,
    bookIds: [],
    editionIds: [english, japanese.editionId],
    localizations: { en: { slug: bundleSlug, title: bundleTitle } },
    priceMinor: 189000,
  });

  const admin = await createReader("pair-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/coupons");
  await adminPage.getByRole("link", { name: "New coupon" }).click();
  await adminPage.getByLabel("Code").fill(code);
  await adminPage.getByLabel("Percentage off").fill("100");
  await adminPage.getByRole("group", { name: "Bundles" }).getByLabel(bundleTitle, { exact: true }).check();
  await adminPage.getByRole("button", { name: "Create coupon" }).click();
  await expect(adminPage.getByRole("heading", { name: code })).toBeVisible();
  await adminContext.close();

  const purchaser = await createReader("pair-purchaser");
  await signInAs(page, purchaser.email, `/en/bundles/${bundleSlug}`);
  // The page says plainly that this is an English + Japanese bundle.
  await expect(page.getByText("Languages in this bundle: English, 日本語.")).toBeVisible();
  await page.getByRole("button", { name: "Buy bundle" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];
  await page.getByLabel("Recipient email").fill(recipient.email);
  await page.getByRole("button", { name: "Save gift" }).click();
  await page.getByLabel("Enter a code").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/library$/);

  // Edit the bundle after the purchase: a different single edition altogether.
  const editor = createAnonClient();
  const { data: link, error: linkError } = await createServiceRoleClient().auth.admin.generateLink({ type: "magiclink", email: admin.email });
  if (linkError) throw linkError;
  const { error: otpError } = await editor.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
  if (otpError) throw otpError;
  const { error: editError } = await editor.rpc("admin_set_bundle_members", { p_bundle_id: bundleId, p_edition_ids: [otherEdition] });
  if (editError) throw editError;

  await runOperationsWorker(request);
  const claimPath = readGiftDelivery(orderId)!.claimPath!;
  const recipientContext = await browser.newContext();
  const recipientPage = await recipientContext.newPage();
  await signInAs(recipientPage, recipient.email, claimPath);

  await expect(recipientPage.getByRole("heading", { level: 1, name: "Your gift" })).toBeVisible();
  await expect(claimGroup(recipientPage, "Added to your library").getByRole("link", { name: japaneseTitle })).toBeVisible();
  await expect(claimGroup(recipientPage, "Already in your library").getByRole("link", { name: work.title })).toBeVisible();
  await expect(recipientPage.getByText(other.title)).toHaveCount(0);

  // Exactly the snapshot: English (held already by a grant, and now by the gift too) and Japanese.
  // Nothing from the edit.
  expect(await activeEntitlementRowCount(recipient.profileId)).toBe(3);
  expect(await activeEditionEntitlementCount(recipient.profileId, english)).toBe(2);
  expect(await activeEditionEntitlementCount(recipient.profileId, japanese.editionId)).toBe(1);
  expect(await activeEditionEntitlementCount(recipient.profileId, otherEdition)).toBe(0);

  // Claiming again changes nothing.
  await recipientPage.reload();
  expect(await activeEntitlementRowCount(recipient.profileId)).toBe(3);
  await recipientContext.close();
});
