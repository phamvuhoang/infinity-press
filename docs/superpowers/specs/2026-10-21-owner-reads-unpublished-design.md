# Owners keep reading after unpublish or rollback — design (Press)

Port of `infinity-books/docs/superpowers/specs/2026-10-20-owner-reads-unpublished-design.md` to
Infinity Books Press, where access is per **edition** and every reader gate already routes through
one function, `public.reader_edition_for_publication(p_profile_id, p_publication_id)`.

## Problem

A customer buys an edition and reads it. An admin then clicks **Unpublish book**. After that:

- A regular customer loses the edition from `/library`. `getLibrary` embeds `books!inner`, and the
  `public read published books` RLS policy hides the row.
- An admin account still sees the card, but with no cover: the cover comes from `getBookCards`,
  which returns only published books.
- `/read/editions/[editionId]` returns 404. `getReadableEdition` requires `books.status =
  'published'`, and `/read/[bookId]` requires the same through `getOwnedEditionsOfBook`.
- The database refuses the reader as well. `reader_edition_for_publication` requires
  `pub.status = 'published'`, `e.active_publication_id = pub.id`, `e.status in ('published',
  'archived')`, and `b.status = 'published'`. `create_reader_session`,
  `authorize_reader_session` (which search and annotations also use), `save_reading_progress`,
  `submit_edition_feedback`, and the four `reader_annotations` policies all call it.

The current behavior matches `docs/runbooks/catalog-admin.md:56`: "Unpublish book hides the book
and stops new reader sessions, including for existing owners." This design reverses that rule.

## Rule

**A reader who holds an active entitlement to an edition can always read it.** Revoking the
entitlement is the only way to remove access. The book's catalog status, the edition's status, a
rollback, or losing the edition's active publication does not remove access.

Each edition has one **readable publication**:

1. `editions.active_publication_id`, when that publication has `status = 'published'`.
2. Otherwise, the edition's most recent publication with `status in ('published', 'superseded')`,
   ordered by `processed_at desc, id desc`.
3. Otherwise, none. The edition was never published, so the reader has nothing to open.

`books.status` and `editions.status` play no part in this rule.

- **Rollback.** `rollback_publication` moves the edition's pointer to an older version through
  `press_move_edition_pointer`. Owners then read that version, and their progress for that version
  is used. This is the behavior today; the rule keeps it. A session minted for the newer version
  stops authorizing on its next request.
- **Removing a publication.** No admin action clears `editions.active_publication_id` today. Rule
  step 2 means that a future action of that kind still leaves owners with the last version they
  could read. `rejected` and `ready_for_preview` publications are never readable.
- **Draft and archived editions.** An archived edition stays readable, as today. A draft edition
  with a readable publication is now readable too: no admin action moves a sold edition back to
  draft, and if one ever does, it must not take a purchase away.
- **Other editions.** Owning the English edition still never opens the Japanese one. The
  entitlement check stays per edition.

## What stays hidden

When a book is unpublished, these stay hidden exactly as they are today: the public book page,
catalog lists, search, the sitemap, new purchases, bundle sales, `getBookAcceptsQuestions` (it
returns false, so the reader hides the ask link), the review page (`getBookCardById` returns null,
so the page is 404), and new public shared quotes (`create_shared_quote` still requires a published
book). Readers without an entitlement still get one indistinguishable 404 or EB008.

## Design

The database decides the rule in one place.

- `public.reader_publication_for_edition(p_edition_id uuid) returns uuid`. This function
  implements the rule above. It is `security definer` and `stable`. EXECUTE is revoked from
  `public`, `anon`, `authenticated`, and `service_role`, so only other definer functions can call
  it. Granting it would turn any edition id into its publication id.
- `public.reader_edition_for_publication(p_profile_id uuid, p_publication_id uuid)` keeps its
  signature, grants, and self-only check (`auth.uid() is null or p_profile_id = caller`). Its
  publication-state conditions are replaced by `pub.id =
  public.reader_publication_for_edition(e.id)`. The active-entitlement check for this edition
  stays. Nothing else in the database changes: `create_reader_session`,
  `authorize_reader_session`, `save_reading_progress`, `submit_edition_feedback`, and the four
  `reader_annotations` policies already ask this function and keep their single opaque denials
  (EB008, zero rows, EB009).
- `public.my_library_editions(p_locale text)` returns the caller's own editions with an active
  entitlement, whatever the book or edition status. Each row has the fields the library and the
  reader need: `book_id`, `edition_id`, `language_code`, `slug`, `title`, `author_name`,
  `cover_storage_key`, `cover_alt_text`, `publication_id` (the readable publication, or null),
  `in_catalog`, and `metadata_locale` (the locale the slug and title were taken from). The localization follows the catalog's own order: the requested locale, then the
  platform's default metadata locale, then the book's original language, then any other locale.
  The author name and cover selection mirror `catalog_book_card_rows` (the edition's cover, else
  the work's). `in_catalog` is true when `catalog_resolved_editions(p_locale, book_id)` returns a
  row for the book, which is the same gate `getBookCardById` and the review page use. It is
  `security definer`, filtered on `auth.uid()` and not on RLS, with EXECUTE granted to
  `authenticated` only. The cover goes through this RPC because `media_assets.storage_key` is
  withheld from browser roles.
- `getLibrary`, `getReadableEdition`, and `getOwnedEditionsOfBook` read titles, covers, language
  codes, and the publication from `my_library_editions` instead of `books`, `editions`, and
  `getBookCards`. An owned edition with no readable publication is omitted from the library and
  returns null from the reader. `relatedBooks` still comes from published catalog cards. It is `[]`
  when the book itself is no longer in the catalog.
- `LibraryItemDTO` and `getReadableEdition` expose `inCatalog`. The library card and the reader's
  completion panel render the review link only when it is true, because the review page is 404 for
  an unpublished book.
- `resolveEntitledManifest` serves a `superseded` publication. `authorize_reader_session` has
  already decided it is the caller's readable one. Sample manifests and resources stay
  published-only.
- `create_shared_quote` relied on `reader_edition_for_publication` for the published-book check. It
  now checks `books.status` itself, so a public share card is still refused for an unpublished book.
- `canonicalBookUrl` is still built from the owned slug, in the slug's own `metadata_locale`. The reader's selection toolbar, which
  provides highlights and notes, only renders when this URL is truthy.
