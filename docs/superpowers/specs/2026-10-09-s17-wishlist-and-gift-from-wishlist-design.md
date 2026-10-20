# S17 Wishlist and Gift-from-Wishlist Design

**Status:** Proposed
**Date:** 2026-10-09
**Roadmap:** PRD P1 Wishlist ("Save books before purchase"), P1.3 growth commerce (gift flows)
**Builds on:** S2 public discovery (book cards, `ViewerBookAction`), S3 get and buy (orders), S9 bundles and gifts (gift orders, claim), S11 recommendation shelves (seeds)
**Related:** S15 review reply email, S16 shareable quote cards

## 1. Goal

A reader who is not ready to buy has nowhere to put the book. They leave, and the platform forgets
them. The PRD lists Wishlist as a P1 item and it has not been built.

S17 builds the smallest wishlist that pays for itself twice:

1. **Convenience.** A "Save" control on every book card and book page, and a Wishlist tab in the
   library, so a signed-in reader keeps a list of books to come back to.
2. **Viral.** The reader can turn their wishlist into a public page and send the link. Anyone who
   opens it can buy any book on it **as a gift for the list owner** in two taps, using the S9 gift
   flow unchanged. The owner's email never appears; the platform fills it in server-side.

A wishlist is the one object a reader sends to the people most likely to buy them a book.

## 2. What S17 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| Book page and book cards | Signed-in reader | A heart toggle, "Lưu" / "Save", filled when saved; signed-out visitors see it and are sent to sign-in with `next` |
| `/{locale}/library/wishlist` | Reader | Saved books newest first, each with its current action (Get free, Buy, Continue reading when since bought); remove control; "Share my wishlist" toggle and link |
| `/{locale}/library` | Reader | A "You might like" shelf that also seeds from the wishlist; a Wishlist link with the count |
| `/{locale}/wishlist/[code]` | Anyone, when sharing is on | The owner's display name, the books, and a "Gift this" button per book; `noindex` |
| `/{locale}/checkout/[orderId]` | Gift buyer | The S9 checkout with the gift section pre-filled and locked to the list owner, showing the owner's name, not their email |
| Owner's inbox and library | Owner | The existing S9 gift-claim email; claiming removes the book from the wishlist |
| `/api/analytics/events` | Operator | `add_to_wishlist`, `view_wishlist`, `begin_gift_from_wishlist` |
| `/admin/users/[profileId]` | Admin | The wishlist count and whether sharing is on |

## 3. Out of Scope

- Wishlists for bundles. A bundle page has no Save control in S17.
- Several lists per reader, list names, notes per item, or priorities. One list per profile.
- Price-drop or back-in-stock emails. The site has no sales and no stock.
- Marking an item "bought by someone" before the gift is claimed. The S9 claim removes it; until
  then two people could gift the same book, exactly as they could today.
- Public, indexable wishlists. A shared list is `noindex` and reachable by its code only.
- Recipients without an account. The S9 claim already requires sign-in; S17 does not change that.
- Editorial Collections. They remain a separate P1 item.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Shape | A `wishlist_items (profile_id, book_id)` table with a composite primary key. No list entity: one profile has one list, so the list **is** the profile. Sharing state lives on `profiles`. |
| Toggle semantics | Add is an upsert, remove is a delete. The two RPCs are idempotent so a double tap does nothing. |
| What can be saved | A published book with an active publication in the reader's locale, the same predicate the catalog uses. A book the reader already owns can still be saved; the list shows "In your library". |
| Where the toggle lives | A small client island beside `ViewerBookAction`. It reads its state through the existing `action-state` route, which gains one boolean `wishlisted`, so the prerendered page stays static and adds no second fetch. |
| Signed-out tap | Redirects to sign-in with `next` back to the book page and `?save=<bookId>`. After sign-in the page completes the save once and strips the parameter. One extra tap is not worth a guest wishlist. |
| Share code | `profiles.wishlist_share_code text unique`, 10 characters from 64 random bits, base64url, created when the owner first turns sharing on, cleared when they turn it off. Turning it on again mints a new code, so an old link dies when the owner says so. |
| Owner identity on the public page | `profiles.display_name` snapshot at render, trimmed, or the dictionary string for an anonymous reader. Never the email. |
| Gift from the page | A server action `startGiftFromWishlistAction(locale, code, bookId)`. It requires a signed-in buyer, resolves the owner by code, refuses when the buyer is the owner, creates an ebook order with the existing `createEbookOrder`, then calls the existing `configureGift` with the owner's primary verified email and an empty message, and redirects to the checkout. The buyer never sees the address. |
| Locked gift section | `gifts` gains `wishlist_owner_profile_id uuid`. When set, the S9 checkout renders the recipient as the owner's name and disables the email field and the "remove gift" control. Everything after that, including payment, the outbox email, and the claim, is S9 verbatim. |
| Claim removes the item | `claim_gift` already grants entitlements per order item. One statement is added: delete from `wishlist_items` where `profile_id = claimer and book_id in (order items)`. A purchase by the owner themself does the same in the entitlement grant trigger, so the list never shows a book the reader owns as still wanted. |
| Recommendation seed | `recommend_books` on the library is called with `library_items ∪ wishlist_items` as seeds and `library_items` as exclusions. A wishlisted book may itself appear in the shelf because it is not owned, which is the desired nudge. |
| Caps | 100 items per profile, `EB040` (S16 holds `EB038` and `EB039`). |

## 5. Data Model

```
wishlist_items       profile_id uuid references profiles(id) on delete cascade
                     book_id uuid references books(id) on delete cascade
                     added_at timestamptz not null default now()
                     primary key (profile_id, book_id)

profiles             + wishlist_share_code text unique
                       check (wishlist_share_code is null or wishlist_share_code ~ '^[A-Za-z0-9_-]{10}$')
                     + wishlist_shared_at timestamptz
                     check ((wishlist_share_code is null) = (wishlist_shared_at is null))

gifts                + wishlist_owner_profile_id uuid references profiles(id) on delete set null
```

Indexes: `wishlist_items (profile_id, added_at desc)`, `wishlist_items (book_id)`.

`analytics_events` gains the three event names. `add_to_wishlist` carries `book_id`;
`view_wishlist` and `begin_gift_from_wishlist` carry the owner's profile id in a new nullable
`subject_profile_id` column, never the code. The no-free-text rule holds.

RLS: the owner selects their own `wishlist_items`; admins select all; nobody else reads the table.
The public page reads only through `catalog_wishlist(p_code)`, which returns the owner's name and
the published books of an owner whose `wishlist_share_code` matches, and nothing otherwise. No role
has insert, update, or delete; every write is a definer RPC.

## 6. RPCs

| Function | Caller | Behaviour |
| --- | --- | --- |
| `add_wishlist_item(p_book_id)` | Reader | Checks the catalog predicate and the cap; `insert … on conflict do nothing`; writes `add_to_wishlist` once per actual insert |
| `remove_wishlist_item(p_book_id)` | Reader | Deletes the caller's row; no-op when absent |
| `set_wishlist_sharing(p_enabled boolean) returns text` | Reader | Mints or clears the code on the caller's profile; returns the code or null |
| `catalog_wishlist(p_code)` | Anon, authenticated | Owner name, owner profile id, and the published book ids in order; stable |
| `resolve_wishlist_gift_recipient(p_code) returns record` | Service role only | Owner profile id and primary verified email for a code; called by the server action after `requireUser()` |
| `claim_gift(p_token)` | Reader | Unchanged signature; gains the wishlist delete |

`action-state` gains `wishlisted: boolean` from a direct select on the caller's own row. The route
already runs as the viewer and returns `private, no-store`.

## 7. Pages

### Book page and cards

The heart is a client island, `WishlistToggle`, rendered next to `ViewerBookAction` on the book
page and in the corner of the S2 book card. It is a `<button aria-pressed>` with the dictionary
label; the icon is decorative. It calls a server action that wraps the two RPCs and returns the new
state, and it updates optimistically. On a 401 it navigates to sign-in with `next`.

Cards inside cached public pages (home, catalog, topic, author) render the heart unfilled and let
the island resolve state after hydration through one batched call,
`GET /api/catalog/wishlist-state?ids=…`, capped at 60 ids. Pages stay static.

### `/{locale}/library/wishlist`

Authenticated, `requireUser()`. Newest first. Each row is the S2 card plus the book's current action
and a remove control. Above the list: the item count, a "Share my wishlist" switch, and when on,
the link with a copy button and the sentence, from the dictionary, "Anyone with this link can see
these books and buy one for you as a gift. Your email stays private."

### `/{locale}/wishlist/[code]`

Dynamic, `noindex, nofollow`, not in the sitemap or `llms.txt`. Heading "{name}'s wishlist" /
"Sách {name} muốn đọc". A grid of S2 cards, each with "Gift this" / "Tặng cuốn này". A visitor
who is the owner sees their own list with a note and no gift buttons. A book the owner already owns
is omitted from the public page.

"Gift this" submits `startGiftFromWishlistAction`. Signed out, it redirects to sign-in with `next`
back to this page. Signed in, it lands on the S9 checkout with the gift section locked.

### Checkout

`GiftForm` receives `lockedRecipient: { name } | null`. When set it renders the name, hides the
email field, keeps the optional message, and hides the remove control. The server-side guard in
`removeGift` refuses a gift with `wishlist_owner_profile_id` set, so the lock is not only visual.

### Library

The library gets a "Wishlist (n)" link next to the existing Review link pattern, and the S11 shelf
seeds from both sets as decided in §4.

## 8. Emails and Notifications

None new. The S9 `gift_claim` email reaches the owner. Its body already names the purchaser; no
change.

## 9. Security and Privacy

- The owner's email never leaves the server. The public page, the checkout, and the analytics row
  carry the profile id or the display name only.
- The code is random. An unshared list has no code. Turning sharing off makes every old link 404.
- A buyer cannot gift to themself from their own list, and cannot change the locked recipient; the
  server action and `removeGift` enforce both.
- `catalog_wishlist` hides unpublished books and owned books, so a list cannot reveal catalog state
  or the owner's purchases.
- All reads of `wishlist_items` by a reader go through RLS as the reader; admin reads run after
  `requireAdmin()`.

## 10. Testing

| Layer | Coverage |
| --- | --- |
| pgTAP `068_s17_wishlist.sql` | Add is idempotent; unpublished book refused; 101st item gets EB038; remove is idempotent; sharing mints a 10-char code and clearing nulls it; re-enabling mints a different code; `catalog_wishlist` returns nothing for an unknown or cleared code and omits owned and unpublished books; anon cannot read the table; `claim_gift` deletes the claimer's item; an owner's own purchase deletes the item |
| Vitest `wishlist-toggle.test.tsx` | Optimistic flip and rollback on error; 401 navigates to sign-in with `next` and `save` |
| Vitest `action-state` route | `wishlisted` is false for anonymous and reflects the row for a reader |
| Vitest `gift-form.test.tsx` | Locked recipient renders the name, no email field, no remove control |
| Vitest `recommendations.test.ts` | Library shelf seeds include wishlist ids and exclusions stay owned ids |
| Playwright `wishlist.spec.ts` | Reader saves from the book page, sees it in the library wishlist, enables sharing; a second reader opens the link, gifts a book, pays in the simulator; Mailpit holds the claim email; the owner claims, the book is in their library and gone from the wishlist; the owner disables sharing and the link 404s |

## 11. Exit Criteria

- A signed-in reader can save and unsave any published book from the book page and any card.
- A shared wishlist can be gifted from without the buyer ever seeing the owner's email.
- Claiming a gifted book, or buying it oneself, removes it from the wishlist.
- Disabling sharing invalidates the link immediately.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
- `lib/supabase/database.types.ts` reflects the new table, columns, and functions.
