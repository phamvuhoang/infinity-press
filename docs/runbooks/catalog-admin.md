# Runbook: catalog admin

Catalog work happens under `/admin` and requires an admin account. Each page and action checks
that role independently. Successful catalog mutations write `audit_logs`; rejected validation
does not count as a saved change. Keep the request ID from an error when investigating server logs.

## Build a launch book

1. Create authors, series, and topics under their own menus. Each starts as a draft. Add Vietnamese
   and/or English copy, then choose **Published** and save. Publishing without copy is rejected.
2. Open `/admin/books/new`. Choose an existing author by the option that shows both name and
   canonical slug, or leave the selector on **Create a new author** and enter **Author name**.
   A typed name reuses a unique exact match, ignoring case and surrounding whitespace; otherwise
   it creates a draft author. If duplicate display names exist, use the selector so the stable
   author ID determines the choice. Add localized copy in the author editor before publishing a
   book whose author was created here. Create the book with its initial localization, edition,
   and offer.
3. Work through the book editor at `/admin/books/<id>`, saving each section:
   - **Details:** canonical key, book language, primary author. Author options include canonical
     slugs so duplicate display names remain distinguishable.
   - **Localizations:** title, slug, description, audience, key ideas (`Title | summary`, one per
     line), FAQ (`Q:` / `A:` blocks separated by a blank line), SEO title and description. One form
     per interface language (Vietnamese, English, Japanese).
   - **Editions:** one entry per language translation, each with its own page at
     `/admin/books/<id>/editions/<editionId>`. Add one by choosing its language. On the edition page:
     ISBN without dashes, edition number, publication date, credits (`translator: Name`, one per
     line), a translation introduction, and offers. A price is entered in minor units and is never
     implied: zero is an explicit free edition, a blank price is refused, and 500 JPY is 500. A new
     offer is prefilled from the language's pricing template when the admin has set one, and the
     templates never change an existing offer. The first offer becomes the default; use **Make
     default offer** to change it. **Make default** names the edition readers get for that language.
     An edition that already has orders or readers keeps its language.
   - **Cover:** JPEG, PNG, or WebP up to 5 MB, with nonempty alt text. Wait for **Cover saved.** and
     check the preview. Uploading again replaces the selected cover, including across formats.
   - **Relations:** choose topics, optionally a series and its position, then save.
   - **EPUB (on the edition page):** upload and wait for the queued job. Follow
     [EPUB processing](epub-processing.md) to run the local worker, preview the processed resources,
     and publish that EPUB version. Publishing checks that the EPUB's own language matches the
     edition's language (`en-GB` satisfies `en`); a mismatch, or an EPUB processed by an older worker
     that did not record its language, is refused with the reason shown. Publishing or rolling back
     one edition never changes another.
   - **Publish:** resolve each checklist link. **Publish book** is disabled until a localization
     has title, slug, and description; a primary author with localized copy, a cover, and at
     least one published edition are present. An offer is not required: an edition with no offer is
     visible but not for sale. The database repeats this check. Confirm
     publishing the book.
4. Reload the editor to check saved values and status. Catalog metadata needs no manual database
   edits. EPUB processing still requires the operator CLI.
5. **Check the storefront.** Open `/vi/books/<slug>` and `/en/books/<slug>`. See
   `docs/runbooks/storefront.md` when a page is missing.

## Visibility, redirects, and storage

- Publishing or rolling back an EPUB version changes its lifecycle and the active version pointer.
  It does not publish the book. **Publish book** makes the book and primary author public.
- **Unpublish book** hides the book and stops new reader sessions, including for existing owners.
- Renaming a published book, author, series, or topic records a permanent redirect from its old
  localized URL. Later renames flatten old URLs to the newest destination. Renaming back removes
  loops; draft renames add no redirect. S1 stores these mappings; public slug pages and redirect
  consumption are part of S2 and are not delivered by the catalog admin alone.
- One book can belong to one series; a position in a series holds one book.
- Covers are publicly readable in `covers`, including draft covers. Never upload confidential
  content there. Source EPUBs and processed resources remain private in `ebook-source` and
  `ebook-derived`; readers receive them through authorized reader routes.
- S1 does not launch paid checkout or the public catalog. A paid offer is metadata for the later
  storefront's coming-soon state. The payment simulator is local-only and rejected in production.

## Merchandising

`/admin/merchandising` sets one featured book and an ordered home shelf. Add, move, or remove books,
then save. Unpublished books may be placed but remain hidden from public reads. Clear the featured
selection or remove all shelf books and save to empty a slot. Only `home_featured` and `home_shelf`
are supported. Changes are audited as a whole slot replacement.

## Recommendation pins

Open `/admin/books/{bookId}` and use **Relations → Editorial pins**. Add a book, remove one, drag a
row, or use **Move up** / **Move down**, then **Save editorial pins**. The saved order is the order
the shelf uses.

- Pins are directed and ordered. Pinning B under A does not pin A under B; give B its own pins if
  its shelf should lead back to A.
- Pins beat the computed signals, but they are an ordering override and never an eligibility one. A
  pinned book appears only when it is published, has a published active publication, and has copy in
  the visitor's locale. A pinned draft is silently absent, which is not a fault of the pin.
- Removing every pin does not force an empty shelf. The computed series, author, topic, and bundle
  signals remain, and the shelf falls back to them. Only when no signal remains either do the shelf
  and its heading disappear entirely.
- A signal only counts while the thing it is named after is published. Moving a topic, series, or
  bundle to draft or archived removes it from the public catalog, and it stops scoring at the same
  moment - so a book can leave a shelf because a grouping was unpublished, with no edit to either
  book. Re-publishing the grouping restores the shelf on the next revalidation.
- Relation saves revalidate the storefront. Verify both `vi` and `en` when both localizations exist,
  since a pinned book missing one localization is absent from that locale's shelf only.

## Paperback retailers

Open `/admin/books/{bookId}` and use **Paperback retailers** to list where the printed book is sold.
Choose **Add retailer**, pick Shopee, Fahasa, Tiki, or Other, paste the plain marketplace URL, and
choose **Save paperback retailers**.

- The URL must be `https://`. Paste the plain product URL: the book page appends the site's UTM
  parameters when the link is shown, unless the URL already carries its own `utm_*` parameters (an
  affiliate link keeps its own tracking untouched).
- The label field exists only for **Other**, where it is required; a named retailer ignores it.
- The price is optional. A link with no price is valid: the book page shows only the button and the
  structured data carries an Offer without a price. When you do enter a price, give the amount in
  minor units and the currency together; the page shows it as "list price", never as something the
  site sells. A currency with no price is dropped on save.
- Deactivate a row (clear **Active**) to hide it temporarily instead of deleting it. Inactive rows
  appear neither on the book page nor in its structured data.
- A save replaces the whole set. The submitted order is the order shown, and at most ten rows are
  allowed. Removing a row and saving deletes it.
- Saving revalidates the storefront; reload the book page in `vi` and `en` to confirm.

Outbound clicks are recorded as the analytics event `click_external_store`, with the book, the
locale, and a `retailer` of `shopee`, `fahasa`, `tiki`, or `other`. Query `public.analytics_events`
by `event_name` and `retailer` to compare retailers. See
[SEO and operations](seo-and-operations.md) for the structured data and for `/llms.txt`.

## Complimentary access

Under `/admin/users`, search at least three characters of an email, open the user, choose a book,
and give a reason. The recipient must have verified their email through sign-in before a first
grant. Only admin grants can be revoked here; revoking requires a reason and leaves an audit row.
Free and purchase entitlements are not revoked through this screen. Revocation hides the library
item and existing reader sessions recheck access on subsequent requests.

## Local acceptance and deployment

Use [testing environments](testing-environments.md) for the local-only Supabase/Mailpit exports
and scratch ports. Reset before pgTAP if browser fixtures have run. Run the complete database,
type-generation, Node 22 web, and browser gate; no spec may silently skip for missing credentials.
See [deployment](deployment.md#s1-catalog-admin-migrations) for the S1 migration preflight.

The acceptance coverage is split across `admin-catalog`, `admin-create-book`, `admin-entities`,
`admin-users`, `admin-merchandising`, publication transitions, and the EPUB golden path. The
catalog journey creates localized entities and a complete book through the UI, uploads/processes
its EPUB, checks readiness at the UI and RPC, replaces a cover, publishes, renames twice without
a redirect chain, and unpublishes. It also checks every S1 page's non-admin HTTP 403 response.

## Editorial review before an edition goes on sale

Each edition (the edition page, **Provenance & editorial review**) carries evidence and a decision:

- **Provenance**: source of the original text, source of the translation, rights note, territories.
  Notes of up to 2000 characters. This records evidence; it is not a legal opinion that a work is free
  to use.
- **Decision**: Not reviewed, Approved, or Blocked. Approving needs the translation source, the rights
  note and the territories (the form says what is missing). Blocking needs a reason. The reviewer and
  the date are recorded.
- **Gate**: a new EPUB version of an edition cannot be published unless the edition is Approved
  (`editorial_unreviewed` / `editorial_blocked` on the version page say why). Rolling back to an
  earlier version of an approved edition is unaffected.
- **Changing the evidence after approval withdraws the approval** (and its reviewer and date).
  Editions that existed when this was introduced were marked approved with a note saying so.

## Translation reports

Readers flag a translation error from the reader menu; the place they were reading travels with it.
**Admin > Translation reports** lists them (New / Resolved / Dismissed). Resolve or dismiss with a
note; reopen if needed. Reports are limited to 5 an hour and 20 a day per reader, plain text, 2000
characters, and only for editions the reader holds. They go to the editors; nothing is emailed to the
original author.

### Blocking, and access beside access

- **Blocked** stops the edition being listed, ordered, claimed free or sold in a bundle. Readers who
  already hold it keep reading; remove their access explicitly (revoke the order or the grant) if the
  rights problem requires it.
- Withdrawing approval (editing the evidence, or changing an approved edition's language) does not stop a
  live edition selling; it makes the next publish need a fresh approval.
- A **complimentary grant** is a separate entitlement beside a bought or free one. Revoking the grant
  leaves what the reader bought, and revoking the order leaves the grant. The shelf entry follows
  whichever remains.
- A language default cannot be an archived or blocked edition, and an archived edition cannot be rolled
  back to life.
