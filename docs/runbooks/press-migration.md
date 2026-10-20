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
