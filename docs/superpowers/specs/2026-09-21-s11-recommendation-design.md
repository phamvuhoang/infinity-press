# S11 Recommendation Shelves Design

**Status:** Approved
**Date:** 2026-09-21
**Roadmap:** PRD P1.3 growth commerce, recommendation half
**Builds on:** S1 catalog admin, S2 public discovery, S9 bundles and gifts (optional signal)
**Related:** S12 knowledge hub

## 1. Goal

A reader who is looking at a topic or an author, or who is standing in their own library, is shown a
small number of books worth reading next.

The recommendations are computed from relations an operator already maintains, so they are correct on
the day the catalog has thirty books and there is no purchase history to learn from.

## 2. What S11 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `/{locale}/library` | Reader | "You might like" from the books they own, excluding those books |
| `/{locale}/topics/[slug]` | Reader and crawler | Books related to the topic's own books |
| `/{locale}/authors/[slug]` | Reader and crawler | Books related to the author's work, excluding it |
| `/admin/books/[bookId]` | Admin | A Relations control that pins chosen books ahead of every computed result |

## 3. Out of Scope

- Behavioural recommendation from purchase or reading history.
- Embeddings, semantic similarity, and re-ranking. Those stay P2.2.
- A related-books shelf on the book page and in the reader's completion panel. The scoring function is
  built so either can be added later with one call and no new logic.
- Personalized home-page merchandising. The existing merchandising slots keep owning the home page.
- A/B testing of recommendation placements.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Where the scoring runs | In Postgres, as `recommend_books(...)`. Recommendation is a join over the catalog. |
| Signals | Editorial pins, then shared series, author, topics, and bundle membership, with declared weights. |
| Ordering | Fully deterministic, so visual snapshots do not flicker. |
| Empty results | The shelf is not rendered at all. No placeholder and no random filler. |

## 5. Architecture

### 5.1 One scoring function

```
recommend_books(
  p_seed_book_ids uuid[],
  p_exclude_book_ids uuid[],
  p_locale text,
  p_limit int
) returns table (book_id uuid, score int, pinned boolean)
```

It considers only books with `status = 'published'`, an active publication, and a localization in
`p_locale`, and it never returns a seed book or an excluded book.

Weights are declared as named constants at the top of the function so they can be read and adjusted
without reverse-engineering the SQL:

| Signal | Weight |
| --- | --- |
| Editorial pin from `related_books` | Sorted ahead of every computed result, not scored |
| Shares a series with a seed book | Highest computed weight |
| Shares the primary author with a seed book | High |
| Shares a topic with a seed book | Accumulates once per shared topic |
| Appears in a bundle with a seed book | Low, counted at most once per candidate |

S9 shipped before S11 merged, so the bundle signal is implemented in the S11 migration rather than
deferred. A signal is only counted while its topic, series, or bundle is itself `published`, which
matches what the public catalog reads already show; a seed that is not published contributes no
signal at all, so an arbitrary seed id cannot be used to probe unpublished catalog structure.

Pulling the catalog into TypeScript to score it there was rejected: the work is set-based, it must
filter on publication state and ownership, and it would not survive a catalog of any size.

### 5.2 Deterministic ordering

Results are ordered by `pinned` descending, then `score` descending, then the book's publication date
descending, then `book_id`. Ties therefore resolve identically on every run, which is what lets S6's
visual snapshots stay stable.

### 5.3 Editorial pins

```
related_books
- book_id uuid references books(id) on delete cascade
- related_book_id uuid references books(id) on delete cascade
- position int not null
- primary key (book_id, related_book_id)
- check (book_id <> related_book_id)
```

The relation is directed: pinning B under A does not pin A under B. The admin editor's Relations tab
gains a picker with drag ordering. Every change writes one `audit_logs` row.

### 5.4 Data access and caching

`lib/data/recommendations.ts` wraps the RPC and returns the existing public book DTOs, so the shelf
renders with the same card component the catalog already uses.

- Topic and author pages are public and keep their current caching. The shelf is part of the cached
  output and is revalidated by the same `revalidatePath` calls that already run when a book,
  relation, or publication changes.
- The library shelf is dynamic and authenticated. It seeds from the reader's `library_items` and
  excludes the same set, so a reader is never recommended a book they own.

## 6. Screens

Each shelf is the same component: a heading, a horizontally scrollable row of at most six book cards,
and nothing when the result is empty. Cards use the fixed 2:3 cover box from S2 and ship no client
JavaScript beyond native scrolling. Every card is reachable by keyboard, and the shelf has an
accessible name.

Copy exists in both locales: "Có thể bạn thích" on the library, "Sách liên quan" on topic and author
pages.

## 7. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | The shelf view model: empty result renders nothing; at most six cards; ordering is preserved as returned |
| pgTAP | Seeds and exclusions never appear in the result; drafts, unpublished books, and books without a localization in the locale are excluded; each signal raises the score as declared; accumulating topics outranks a single shared topic; pins sort ahead of a higher-scoring computed result; ties resolve deterministically across repeated calls; an anonymous caller gets only published books |
| Playwright | A signed-in reader's library shows a shelf that contains no owned book; a topic page renders its shelf |

## 8. Exit Criteria

- No shelf ever shows a draft book, an unpublished book, or a book the signed-in reader owns.
- Repeated calls with the same inputs return the same order.
- An editorially pinned book appears first regardless of its computed score.
- Removing every relation from a book removes its shelf rather than leaving an empty heading.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
