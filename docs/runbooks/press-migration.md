# Runbook: Press edition migration inventory

Scope: moving this fork from book-scoped publication/access to edition-scoped publication/access, and
from two UI locales (`vi`, `en`) to registry-driven locales (`vi`, `en`, `ja`). Spec:
`docs/superpowers/specs/2026-10-20-infinity-books-press-design.md`. Plan:
`docs/superpowers/plans/2026-10-20-infinity-books-press.md`.

Source of truth for this inventory is the **latest function definition in a fully migrated local
database** (`pg_proc`), not the migration that first created a function. Re-derive it with the
queries at the bottom after any schema tranche. This document was produced at commit `1470217` plus
Task 0 (85 migrations, 170 public functions). It describes the VN-derived schema; the Press
database starts empty and is **not** a copy of the infinitybooks.vn project.

## Baseline (before Task 1)

- `supabase test db` on a local stack: 73 files, 2327 tests, PASS.
- `npx vitest run`: 281 files passed, 1 skipped; 3279 tests passed. Vitest also reports **4 pre-existing
  unhandled errors** (`engineRef.current?.settleSelection is not a function`, reader component tests).
  They are not caused by Press work; do not treat a run that shows exactly these four as a regression.

## Schema scope inventory

| Object | Old scope | New scope | Owner task |
| --- | --- | --- | --- |
| `books.active_publication_id` | book | `editions.active_publication_id`; book column kept read-only until cutover, dropped later | 3, 4, 10 |
| `editions` (`language_code`, `edition_number`) | no status, no publication pointer | add `status`, `active_publication_id`, cover/contributor/provenance | 3, 4, 9 |
| `skus.edition_id`, `offers.sku_id` | edition-owned already | unchanged; default offer per edition made explicit | 3, 6 |
| `entitlements.book_id` (unique active per profile+book) | book | `(profile_id, edition_id)` | 3, 5 |
| `library_items.book_id` | book | `(profile_id, edition_id)` | 3, 5 |
| `order_items.book_id` | book (+ `sku_id`) | add `edition_id`, language snapshot | 3, 6 |
| `bundle_books.book_id` | book | `bundle_editions(bundle_id, edition_id)` | 3, 7 |
| `book_reviews.book_id` | book | edition, work roll-up derived | 3, 7 |
| `shared_quotes.book_id` | book (+ publication) | stays publication-scoped | 7 |
| `coupon_books.book_id` | book | book scope kept; edition scope optional | 7 |
| `reader_questions.book_id`, `book_retail_links`, `merchandising_slots`, `related_books`, `article_books`, `idea_books`, `book_series`, `book_topics`, `analytics_events` | book | stay work-level (not language-specific) | n/a |

## RPCs that read or write book-level publication or access

Functions whose body references `active_publication_id`:
`authorize_reader_session`, `book_readiness_issues`, `catalog_book_card_by_id`, `catalog_book_cards`,
`create_ebook_order`, `create_reader_session`, `create_shared_quote`, `publish_publication`,
`recommend_books`, `rollback_publication`, `save_reading_progress`.

Functions whose body references `entitlements` or `library_items`:
`acquire_free_ebook`, `apply_coupon_to_order`, `apply_payment_event`, `authorize_reader_session`,
`claim_gift`, `claim_manual_transfer`, `claim_notification_outbox`, `create_bundle_order`,
`create_ebook_order`, `create_reader_session`, `create_shared_quote`,
`grant_complimentary_entitlement`, `order_active_entitlement_ids`, `revoke_complimentary_entitlement`,
`revoke_order_entitlement`, `save_reading_progress`, `submit_book_review`.

Functions using `limit 1` (candidate "pick any edition/offer" sites, each must be reviewed):
`acquire_free_ebook`, `admin_list_questions`, `admin_list_reviews`, `admin_list_shared_quotes`,
`admin_search_gifts`, `admin_set_article_relations`, `admin_set_bundle_members`,
`admin_set_idea_relations`, `admin_set_related_books`, `apply_coupon_to_order`,
`apply_payment_event`, `bundle_live_offer`, `bundle_order_lines`, `catalog_book_card_by_id`,
`catalog_book_cards`, `catalog_book_page`, `claim_processing_job`, `create_bundle_order`,
`create_ebook_order`, `get_my_reader_questions`, `grant_complimentary_entitlement`,
`my_shared_quotes`, `resolve_public_redirect`, `search_reader_publication`.

Rule for every caller above: after cutover it must receive and verify `edition_id`. No book-only
overload may keep working silently; each overload is dropped in the contract migration (Task 10) or
rewritten to resolve through an explicit mapping, never `limit 1`.

## Locale hardcoding

`CHECK (locale in ('vi','en'))` exists on: `analytics_events`, `article_localizations`,
`author_localizations`, `book_localizations`, `book_reviews`, `bundle_localizations`,
`idea_localizations`, `profiles`, `reader_questions`, `series_localizations`, `shared_quotes`,
`topic_localizations`. All are replaced by a foreign key to `supported_locales` (Task 2).

Functions with a `'vi'` literal: `acquire_free_ebook`, `admin_create_article`, `admin_create_bundle`,
`admin_create_idea`, `admin_save_article_localization`, `admin_save_article_seo`,
`admin_save_book_localization`, `admin_save_bundle_localization`, `admin_save_entity_localization`,
`admin_save_idea_localization`, `admin_save_idea_seo`, `admin_search_gifts`, `catalog_entity_page`,
`create_bundle_order`, `create_shared_quote`, `search_catalog`, `submit_book_review`,
`submit_reader_question`.

App code: `lib/i18n/config.ts`, `lib/i18n/routes.ts` (`otherLocale`), `components/site-header.tsx`,
`components/catalog/entity-page.tsx`, public pages under `app/[lang]/(public)/`, `app/llms.txt`,
`lib/data/users.ts`.

## Currency

`offers.currency` is free text with `price_minor bigint`. Money formatting must use a per-currency
exponent (Task 6); no code may divide every currency by 100.

## Environment

The default local ports 54321-54324 may belong to another project on the machine. Use a scratch
workdir with symlinked `migrations/`, `tests/`, `templates/` and a ported `config.toml`
(`.superpowers/scratch/sbworkdir`, ports 553xx, project id `infinity-press-local`). Never stop or
reconfigure another project's stack. `supabase/.temp` in this checkout links to the VN cloud project
and must not be used for Press.

## Re-derive the inventory

```sql
-- run against a fully migrated LOCAL database only
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosrc ilike '%active_publication_id%' order by 1;
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosrc ~* 'entitlements|library_items' order by 1;
select conrelid::regclass, conname from pg_constraint
 where contype = 'c' and connamespace = 'public'::regnamespace
   and pg_get_constraintdef(oid) ~ $$'vi'$$ order by 1;
```

## Edition schema (expand phase, Task 3)

Migration `20261020110000_press_edition_schema.sql` is additive and nullable. It adds
`editions.status`, `editions.active_publication_id` (a trigger rejects a publication of another
edition), `editions.contributors`, `editions.introduction`, `books.default_content_language`,
`book_language_editions` (one default edition per book and language, composite foreign key),
`edition_default_offers` (offer must belong to a SKU of the edition), `bundle_editions`, and
`edition_id` on `entitlements`, `library_items`, `order_items` and `book_reviews`, each with a
composite key that refuses an edition of a different book. An edition with orders or entitlements
keeps its book and language.

Nothing is `NOT NULL` in this migration; the contract migration (below) makes it so, once the RPCs
write `edition_id` themselves.

### Backfill

`public.press_edition_backfill(p_apply boolean)` (service role only; removed again by the contract
migration, so it exists only between the expand and contract migrations) maps legacy rows from evidence:
the SKU on the order behind an entitlement, the asset behind a publication, the only edition of a
single-edition book, the edition a reviewer owns. It never grants another language. A dry run
(`false`) does the work, returns a report and rolls back. A row it cannot map is listed by id (no
email or other PII) and the run stops without changing anything. The migration itself calls it with
`true`, so an upgrade that meets an ambiguous row fails with the ids in the error detail.

```sql
select public.press_edition_backfill(false);   -- report only
```

### Upgrade rehearsal (local only)

```bash
scripts/rehearse-upgrade.sh .superpowers/scratch/sbworkdir
```

Resets the **scratch** stack to the last pre-Press migration, loads `fixtures/db/press-legacy-*.sql`
(single edition, two assets of one edition, paid and pending orders, a pending gift, progress,
annotations, a bundle), applies the Press migrations, and asserts the mapping. A second case adds an
unscoped admin grant on a two-edition book and asserts the upgrade stops, names the row, leaks no
email, and leaves the schema unchanged. The script refuses any stack whose `project_id` does not end
in `-local`.

### Regenerating `lib/supabase/database.types.ts`

```bash
supabase gen types typescript --local --workdir <scratch> | npx prettier --parser typescript --no-semi
```

## Edition access (Task 5)

Migration `20261020140000_press_edition_access.sql`. An entitlement and a library item identify
`(profile, edition)`; the book-only unique indexes are gone, so one reader can hold English and
Japanese of the same work, each with its own progress.

- **One reading rule.** `reader_edition_for_publication(profile, publication)` returns the edition a
  reader may open, or null: the publication is the edition's live, published one; the edition is
  `published` (or `archived`, which owners keep and new buyers never see); the work is published;
  and the profile holds an active entitlement for that edition. `create_reader_session`,
  `authorize_reader_session`, `save_reading_progress`, `create_shared_quote` and every
  `reader_annotations` policy call it. One refusal for every reason.
- **One grant primitive.** `press_grant_edition_access` (internal) is the only code that writes an
  entitlement and its library item. `grant_complimentary_entitlement(profile, edition, reason)`,
  `acquire_free_edition(edition)`, `apply_payment_event`, `apply_coupon_to_order` and `claim_gift`
  all go through it. It is idempotent per `(profile, edition)`: a second source returns the first
  entitlement rather than adding or rewriting one, so revoking one order never removes another
  active grant.
- **Book-only writes are fenced.** A trigger fills `edition_id` from the order's SKU, else the only
  edition of a one-edition work, and refuses (`23514`) a work with several editions and no evidence.
  `acquire_free_ebook(book)` survives only as a wrapper that refuses to choose between two free
  editions; it is removed in the contract migration.
- **Transitional bridge, both ways.** `publish_publication` mirrors the edition pointer to
  `books.active_publication_id` only while the book pointer names the same edition (or nothing), and
  a trigger copies a write to the book pointer onto its edition. Both go away with the column.
- **Routes.** Reading is `/{locale}/read/editions/{editionId}`. `/{locale}/read/{bookId}` resolves
  only to editions the reader owns: one redirects, several open a chooser, none is a 404. The
  interface locale never picks the language. The library lists every owned edition (grouped by work,
  tagged with its language) whatever the interface locale.
- **Admin grants** are per edition: Users -> Grant complimentary access names an edition, and the
  entitlement table shows `Title (language)`.

Samples are still resolved per work (`resolveSamplePublicationId`); the edition-aware sample arrives
with the catalog resolver (Task 8).

## Edition orders and manual QR (Task 6)

Migration `20261020150000_press_edition_orders.sql`.

- `create_edition_order(edition, offer, expected_minor)` is the only way to create a payable order.
  One transaction validates the whole chain (offer belongs to a SKU of that edition; edition and work
  published with a live publication; offer active, in window, price above zero after any sale), then
  the currency gate, then the price the reader saw. It snapshots edition, language, offer, title and
  amount on the order line, and locks per `(profile, edition)` so English and Japanese never collide.
  Errors: `EB040` price/offer changed, `EB041` currency not payable, `EB012` not purchasable,
  `EB013` already owned, `EB011` payments off, `EB005` unverified email.
- `create_ebook_order(book)` remains as a wrapper that resolves the single edition on sale and refuses
  (`EB042`) when there are several. The contract migration (Task 10) removes it once the book page names
  an edition (Task 8).
- `commerce_settings.payable_currencies` (`{VND}`) and `currency_is_payable()` are the single list of
  currencies a transfer can settle. `PAYMENT_PROVIDER` and `commerce_settings.payment_provider` default
  to `manual`. `payments_enabled` is untouched by the migration.
- `claim_manual_transfer` compares editions (owning English no longer blocks reporting a Japanese
  transfer) and refuses non-payable currencies. A trigger refuses a bank reference already used on
  another order's confirmation (`EB043`). `order_items` gets its edition and language from the SKU when
  a writer omits them.
- SePay is gone from the app: provider, IPN route, hand-off page, env variables, and e2e project.
  `PAYMENT_PROVIDER=sepay` fails startup. The historical migrations and the database check constraint
  still name the provider; they are not rewritten, and no payment row can carry it.
- `lib/commerce/money.ts` is the only place that converts between major text and minor units
  (currency exponent from the currency, exact decimal parsing, safe-integer bound).

Interim: the work-level Buy on the book page cannot sell a work whose two editions are both on sale.
Task 8's edition selector passes the chosen edition and offer to `createEditionOrder`.

## Bundles, gifts, coupons and reviews (Task 7)

Migrations `20261020160000_press_edition_bundles.sql`, `20261020170000_press_edition_reviews.sql`,
`20261020180000_press_ask_editors_default.sql`.

- **Bundles hold editions.** `bundle_editions` is the source of truth; `admin_set_bundle_members`
  takes edition ids. `bundle_books` is only a derived "works in this bundle" read model (a trigger
  rebuilds it) for the recommender; it goes away with the contract migration. A bundle of English
  and Japanese of one work is allowed and says so on the page (languages line, per-card language).
- **The order line is the snapshot.** `create_bundle_order` reads the sellable editions once, writes
  edition, language, SKU and title on each line, treats ownership per edition, refuses non-payable
  currencies (`EB041`), and cancels an open order whose membership changed. `claim_gift` grants from
  the order lines, so editing the bundle after purchase changes nothing for an unclaimed gift.
- **Coupons** keep work-level scope (it covers every edition of that work). A fixed-amount coupon
  must match the order currency; percent coupons floor at the minor unit. No edition-level scope yet.
- **Reviews are per edition**: unique `(profile, edition)`; `submit_book_review` takes an optional
  edition (`EB042` when a reader holds several and names none). Public reviews carry `languageCode`.
- **Ask the author -> ask the editors**: default off for authors; copy (vi/en/ja) attributes replies
  to the editors.

## Catalog resolution (Task 8)

Migration `20261020190000_press_catalog_resolution.sql`. One rule decides which edition a reader is
shown, for lists, search, recommendations and the book page alike:

1. an explicit edition id, if it is a readable edition of that work (`catalog_resolve_edition`);
2. otherwise the work's default edition in the requested language;
3. otherwise the default edition in the one effective default language (the work's
   `default_content_language`, else `platform_settings.default_content_language`);
4. otherwise nothing: the work is not listed and its page is unavailable. Never a third language.

"Readable" means the edition is `published` and its live publication is `published`. Archived and
draft editions are not offered to new readers (owners keep reading them). **Offers do not take part**:
a Japanese edition without a buyable offer is shown as Japanese and not yet on sale, never replaced
by an English edition that has a price. The price is the edition's default offer
(`edition_default_offers`), or its only active offer when there is exactly one; with several and no
default it has no price until an admin chooses. Never the cheapest.

- `catalog_resolved_editions(language, book?)` is the set-wise form used by `catalog_book_cards`,
  `catalog_book_card_by_id`, `search_catalog`, `recommend_books` and `catalog_has_visible_book`.
  Tests (`press_catalog_resolution.sql`) prove the set-wise and single-work forms agree.
- **Metadata is chosen separately**, as one whole localization row: requested locale, else the platform
  default metadata locale, else the work's original language (`catalog_book_metadata`). A card and
  page report `metadataLocale`; the page says when the copy is in another language than the interface.
  A work is reachable only under the slug of the copy it is shown with.
- A trigger records the first published edition of a language as that language's default
  (`book_language_editions`); the admin RPCs already did, now every writer does.
- The book page lists the readable editions (`catalog_book_editions`): language of the EPUB, the
  edition's own price and currency, whether it is the default for the interface language. The page
  stays prerendered; `?edition=` is read in the browser. An id that is not on the list gets **no
  Buy/Get button** and never becomes the default. Buying, getting free, reading and the viewer's
  ownership are all per edition (`/api/catalog/books/{id}/action-state?locale=&edition=`).
- Every card names the language of its EPUB; the library ignores the catalog rule and lists every
  edition the reader owns.
- Cache: every admin write that changes defaults, editions, offers, publications, localizations or
  platform settings already calls `revalidateStorefront()`, which revalidates `/[lang]` for all
  locales, the sitemap and `llms.txt`. The cached pages hold no viewer state.
- Japanese is searchable without word breaks (substring match on the normalized title).
- Not in this step: public discovery pages for bundles (none exist yet); the quote card page sells the
  edition its card resolves to rather than the quoted publication's edition.

## Editorial, Japanese reader and reports (Task 9)

Migration `20261020200000_press_editorial.sql`.

- `editions` gains provenance notes and `editorial_state` (`unreviewed` / `approved` / `blocked`) with
  reviewer and date (a check requires both once decided). `publication_readiness_issues` adds
  `editorial_unreviewed` / `editorial_blocked`, so `publish_publication` refuses (EB012) until an admin
  approves. Existing published or archived editions were marked approved when this migration ran, with
  a note; a database with no admin leaves them unreviewed.
- `admin_save_edition_provenance`, `admin_set_edition_review` (EB044 when approving without evidence).
- `edition_feedback` + `submit_edition_feedback` (reader rule, plain text, 5/hour and 20/day, EB045),
  `admin_list_edition_feedback`, `admin_resolve_edition_feedback`.
- No migration for layout: vertical writing is refused by the processor (`UNSUPPORTED_LAYOUT`).
- Japanese: no reader or sanitizer change was needed; the evidence is in `reader-corpus-matrix.md`.

## Contract (Task 10)

Migration `20261020210000_press_contract.sql`. Deploy it only after the application that reads
editions is live and no older application instance is still running: it removes what that code used.

- **Refuses to run on unscoped rows.** If any `entitlements`, `library_items`, `order_items` or
  `book_reviews` row still has no edition it stops with EB046 naming the table and the count. Fix the
  rows (the backfill from the expand phase maps them from evidence) and run again.
- `edition_id` becomes `NOT NULL` on those four tables; the old one-review-per-book unmapped index goes.
- Removed: `create_ebook_order(uuid)`, `acquire_free_ebook(uuid)`, `press_edition_backfill(boolean)`.
  Callers use `create_edition_order` and `acquire_free_edition`.
- Removed: `books.active_publication_id` and its two-way bridge trigger. The edition owns the live
  publication; `publish_publication` and `rollback_publication` already write it.
- `bundle_books` (a derived table) becomes the `bundle_works` view over `bundle_editions` (service role
  only); `recommend_books` reads the view.
- `catalog_book_page` names, as hreflang alternates, only localizations whose locale resolves the work
  to a readable edition.
- Not reversible in place: restore from a backup, or re-create the dropped column and functions from the
  earlier migrations. The upgrade rehearsal (`scripts/rehearse-upgrade.sh`) runs the contract migration
  against the legacy fixture; reset the scratch database afterwards.
