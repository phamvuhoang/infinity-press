# Infinity Books Press — Implementation Plan

> **For agentic workers:** Use the `executing-plans` skill to implement this plan task-by-task. Steps use checkbox syntax for tracking. Đây là plan để review, không phải lệnh triển khai production.

**Goal:** Fork độc lập Infinity Books Press, giao diện VI/EN/JA, bán và đọc từng edition ngôn ngữ với giá/quyền riêng.

**Architecture:** Giữ `books → editions → skus → offers`; chuyển publication và access sang edition. Localization metadata độc lập với ngôn ngữ EPUB; catalog dùng một resolver fallback thống nhất. Triển khai theo các workstream bên dưới, tích hợp schema/access/commerce trước khi mở catalog đa edition.

**Tech Stack:** Next.js 16 theo lockfile, React, TypeScript, Supabase PostgreSQL/Auth/Storage, Readium qua `ReaderEngine`, Vitest, pgTAP, Playwright; Node.js >=22.

**Spec:** [2026-10-20-infinity-books-press-design.md](../specs/2026-10-20-infinity-books-press-design.md).

## Global constraints

- Chỉ sửa fork Press; hạ tầng độc lập khỏi infinitybooks.vn, không sao chép PII/orders/keys/EPUB cũ.
- Customer routes `/{locale}` với VI/EN/JA; `/admin` không prefix, UI admin English.
- `requireUser()`/`requireAdmin()` ở từng protected page/action; SQL RPC/RLS tự kiểm tra quyền.
- Service-role client chỉ sau admin gate; không đưa secret vào browser.
- EPUB và processed resources private; không nới sanitizer; giữ `ReaderEngine`.
- Dùng migration mới, regenerate `lib/supabase/database.types.ts`; không sửa migration đã áp dụng.
- Một acquisition cấp đúng edition; không có wildcard entitlement theo work sau cutover.
- Press dùng manual QR + admin confirm; không dùng SePay kể cả VND. Simulator chỉ cho local/test/staging.
- Thay đổi tiền tệ mặc định không sửa offer/đơn cũ; currency chưa có kênh nhận manual được kiểm thử thì không tạo checkout.
- Chạy DB/Playwright chỉ trên local Supabase do task sở hữu; giữ request IDs.
- Đọc guide trong `node_modules/next/dist/docs/` trước khi sửa Next.js. Checkout hiện chưa có thư mục đó; cần cài dependencies theo lockfile trước.

## 1. Thứ tự và các mốc có thể review

| Mốc | Tasks | Đầu ra | Điều kiện |
| --- | --- | --- | --- |
| M1: thương hiệu mới | 0–1 | Press shell/home/email không còn identity VN | Kiểm tra riêng, chưa launch full Press |
| M2: nền tảng ngôn ngữ | 2–3 | JA, registry/settings và edition schema | Local upgrade tests pass |
| M3: bản ngôn ngữ độc lập | 4–5 | Admin/publishing/access/reader edition-aware | Không có cross-edition access |
| M4: thương mại và discovery | 6–8 | Mua/free/bundle/gift, fallback và library hoàn chỉnh | Các flow dùng chung edition identity |
| M5: chất lượng nội dung và phát hành | 9–11 | JA reader, rights/editorial, SEO và launch checklist | Full checks và rehearsal pass |
| M6: manual USD/JPY nếu cần launch | 12 | Nhận ngoại tệ và admin đối soát | Tài khoản nhận và quy trình manual được kiểm thử |

Không đưa trạng thái trung gian book-only và edition-aware cùng phục vụ khách thật. Có thể review/merge từng task với feature gate mặc định tắt; release mở gate chỉ sau M5. Nếu kinh doanh yêu cầu paid USD/JPY ngay ngày đầu, M6 là dependency của launch.

## 2. Hợp đồng chung giữa các task

File mới `lib/catalog/edition-types.ts` chứa các contract dưới đây. `Locale` lấy từ registry, không lặp union ở DTO.

```ts
import type { Locale } from "@/lib/i18n/config";

export type Money = {
  amountMinor: string; // Decimal integer, safe transport for PostgreSQL bigint.
  currency: string;
};

export type ResolvedEdition = {
  bookId: string;
  editionId: string;
  contentLanguage: string;
  metadataLocale: Locale;
  uiLocale: Locale;
  isContentFallback: boolean;
  activePublicationId: string;
  offer: { offerId: string; price: Money; canCheckout: boolean } | null;
};

export type ResolveEditionInput = {
  bookId: string;
  uiLocale: Locale;
  explicitEditionId?: string;
};

export type CreateEditionOrderInput = {
  editionId: string;
  offerId: string;
  locale: Locale;
  couponCode?: string;
};
```

- `resolveBookEdition(input: ResolveEditionInput): Promise<ResolvedEdition | null>` ở `lib/data/editions.ts`, gọi RPC public resolver; không kiểm tra quyền khách vì dùng cho discovery.
- `createEditionOrder(input: CreateEditionOrderInput): Promise<{ orderId: string }>` ở `lib/commerce/orders.ts`, gọi authenticated RPC; giá và quyền được tính lại trong transaction.
- `getReadableEdition(editionId: string)` ở `lib/data/library.ts` trả publication chỉ khi viewer có entitlement. Không thay bằng resolver public.
- RPC mới: `catalog_resolve_edition(p_book_id uuid, p_locale text, p_edition_id uuid default null)`; `create_edition_order(p_edition_id uuid, p_offer_id uuid)` trả order ID. Coupon wrapper có cùng edition/offer parameters và `p_coupon_code text`.
- Các RPC existing về free/grant/revoke/session giữ hoặc đổi tên khi cần tương thích, nhưng sau cutover đều phải kiểm tra `edition_id`; lập danh sách caller và migration overload rõ ràng trong Task 0, không để overload book-only hoạt động ngầm.
- Catalog/list/search RPC phải dùng cùng SQL resolver helper; không gọi từng RPC cho từng card gây N+1. Public output không chứa private storage keys.

## Task 0 — Inventory và môi trường thực thi

**Files:** `AGENTS.md`, `package.json`, lockfile, `docs/runbooks/testing-environments.md`, `docs/runbooks/deployment.md`, `supabase/migrations/`, `lib/supabase/database.types.ts`.

- [ ] Cài dependencies theo lockfile với Node >=22; đọc local Next guides về internationalization, dynamic routes, metadata/static params và caching theo các path thực tế của version cài đặt.
- [ ] Tạo bảng inventory trong `docs/runbooks/press-migration.md`: schema/RPC/caller, scope cũ book/edition/publication, scope mới, task chịu trách nhiệm. Tìm `active_publication_id`, entitlement/library `book_id`, `limit 1`, locale `vi/en`, currency, bundle contents, review/quote, auth mail và cache.
- [ ] Kiểm tra **định nghĩa RPC mới nhất** qua thứ tự migrations, không chỉ migration đầu tạo function. Bao gồm RLS policies, SQL helpers, SECURITY DEFINER grants/search_path, trigger/outbox và audit payloads.
- [ ] Sửa các phát biểu runbook đã lỗi thời theo source/user context; ghi rõ cloud VN không phải môi trường của Press. Không đọc/in secret vào báo cáo.
- [ ] Chuẩn bị Supabase local riêng; kiểm tra owner/ports trước reset. Nếu 543xx thuộc dự án khác, dùng scratch workdir theo testing runbook và kiểm tra tests/migrations không phải bản copy cũ.

**Deliverable:** inventory đủ để không bỏ sót book-level access và runbook local đúng. Không cloud mutation.

## Task 1 — Rebrand và homepage nền tảng

**Create:** `lib/config/brand.ts`.

**Modify:** `components/brand/logo.tsx`, `components/site-header.tsx`, `components/site-footer.tsx`, `app/[lang]/(public)/page.tsx`, `app/opengraph-image.tsx`, `lib/seo/metadata.ts`, `lib/seo/json-ld.ts`, `lib/i18n/dictionaries/{vi,en}.json`, `lib/ops/alerts.ts`, `lib/email/`, `supabase/templates/`, `.env.example`, `package.json`, `README.md`, `AGENTS.md`.

**Remove/replace after inspection:** `public/brand/infinity-logo.png`, `app/favicon.ico`, `app/icon.png`, `app/icon1.png`, `app/apple-icon.png`, old author/hero artwork and references.

**Tests:** existing header/SEO/email tests, `e2e/public-home.spec.ts`; add `lib/config/brand.test.ts` if brand config gains logic.

- [ ] Replace image logo with text `Infinity Books Press`; keep accessible name, focus and home navigation. Audit icons visually before replacing; don't assume all PNGs represent old brand.
- [ ] Remove homepage author lookup/band and insert platform introduction from spec. Replace old values/quotes, placeholders about catalog “coming soon”, bookstore links and Phương Bùi copy across dictionaries.
- [ ] Centralize name/origin; update OG, email subjects/signoffs, Auth templates, support links and operational alerts. No fallback to old domain/contact.
- [ ] Update assertions and fixtures that encode old brand; add homepage expectation for platform copy and absence of old logo/author band.
- [ ] Audit rendered HTML/assets and active source with `rg`; allow historical mentions only in archived docs/migrations, and allow the full new name despite containing the old name as a substring.
- [ ] Run affected unit tests and `npm run check`; review desktop/mobile home, auth and footer.

**Deliverable:** new identity complete at all active touchpoints; no DB deletion.

## Task 2 — Registry, JA UI và localization contracts

**Modify:** `lib/i18n/{config,dictionary,format,routes}.ts`, `proxy.ts`, `lib/supabase/proxy.ts`, `app/[lang]/layout.tsx`, `components/site-header.tsx`, `lib/catalog/schemas.ts`, DTOs in `lib/data/`, localized forms under `app/admin/`, `lib/reader/copy.ts`, `lib/email/`, `supabase/templates/`.

**Create:** `lib/i18n/dictionaries/ja.json`, `components/locale-selector.tsx`, `lib/i18n/settings.ts`, locale/settings migration, settings admin page/actions at `app/admin/settings/`.

**Tests:** `lib/i18n/*.test.ts`, `e2e/localized-routing.spec.ts`, new `supabase/tests/press_locales.sql`.

- [ ] Add registry with names Việt/English/日本語, Intl tags and dictionaries. Replace binary switch with N-language selector; maintain translated entity IDs/slugs and safe auth return URLs.
- [ ] Add `supported_locales`, separate `content_languages`, platform settings and pricing-default tables with admin-only writes/public safe reads. Seed UI VI/EN/JA; preserve existing legitimate content languages during upgrade.
- [ ] Replace locale CHECKs and RPC allowlists throughout book/author/topic/series/bundle/idea/article/quotes/email-related tables; use registry FK or centralized validation. Don't mass-constrain original language to UI locales.
- [ ] Translate dictionary fully including email/errors/reader; enforce same key paths and interpolation tokens across all three JSON files. Japanese editorial review is a release checklist item.
- [ ] Implement metadata fallback on whole localization rows, report actual locale; add admin translation-completeness view. Published article fallback cannot expose draft content.
- [ ] Test unsupported locale, `/ja` routing, entity slug change, preserved callback path, disabled locale, metadata fallback and literal Japanese search input.

**Deliverable:** JA UI and settings reusable by later tasks; no hand-written VI/EN branching on changed paths.

## Task 3 — Edition schema, constraints và backfill

**Create:** additive migrations in `supabase/migrations/` for edition publication/defaults, access scope and snapshots; `lib/catalog/edition-types.ts`; `supabase/tests/press_edition_schema.sql`, `supabase/tests/press_edition_backfill.sql`.

**Modify:** `lib/supabase/database.types.ts`, `docs/runbooks/press-migration.md`.

- [ ] Add edition status/active publication, default mapping per book+language, book default language, edition cover/contributor metadata, default offer selection and nullable edition IDs in entitlements/library/order-item/review/bundle-related data.
- [ ] Enforce cross-entity relations: active publication asset belongs to edition, default edition matches book+language, selected offer SKU belongs to edition. Use composite FK or guarded triggers/RPC invariants, not only TypeScript.
- [ ] Backfill active pointers from ebook asset edition; order items from SKU; entitlements/library from verified legacy single-edition mapping; bundle membership from unambiguous existing edition. Log counts and abort on ambiguity.
- [ ] Preserve edition IDs/publication IDs/progress references; don't create synthetic translations or grant every edition for a book-level entitlement.
- [ ] Build upgrade fixtures for single edition, multiple assets of same edition, ambiguous multi-edition legacy book, existing paid/pending orders, gifts and annotations. Assert migration stops on ambiguity and reports row IDs without PII.
- [ ] Plan final NOT NULL/unique and removal of book-only RPCs after Tasks 4–8; regenerate types after each schema tranche.

**Deliverable:** additive schema and deterministic mapping, rehearsed locally. No production backfill execution in this task.

## Task 4 — Admin editions và độc lập publishing

**Modify:** `lib/data/books.ts`, `lib/data/publications.ts`, `lib/catalog/{schemas,readiness}.ts`, `app/admin/books/[bookId]/page.tsx`, `app/admin/books/[bookId]/editor-actions.ts`, `app/admin/books/[bookId]/publish-actions.ts`, `app/admin/books/[bookId]/epub/actions.ts`, `app/admin/publications/[publicationId]/page.tsx`, EPUB upload/worker integration in `lib/epub/`.

**Create:** `app/admin/books/[bookId]/editions/[editionId]/page.tsx`, edition actions and readiness tests, new SQL publishing migration/tests.

**Tests:** `e2e/admin-create-book.spec.ts`, `e2e/admin-publication-transitions.spec.ts`, new `e2e/admin-editions.spec.ts`.

- [ ] Change AdminBookDTO singular edition/SKU/offer to list/selected-edition DTO; explicit edition ID on every save/upload/publish/rollback form.
- [ ] Create/edit edition without changing `books.original_language`; prevent changing identity after order/entitlement exists. Pick default edition per language explicitly.
- [ ] Prefill offer from admin language defaults, allow override; no implicit free offer when price unset, no bulk mutation when defaults change.
- [ ] Move publication transition logic to edition pointer with transaction/row locks and ownership checks. Prevent cross-edition rollback. Keep audit logs and request IDs.
- [ ] Add readiness for source language, metadata, publication and default mapping; offer absence only disables purchase, not an owner's existing access.
- [ ] Exercise EN+JA+VI upload, duplicate edition/default validation, JA publish/rollback with EN pointer unchanged and unauthorized action denial.

**Deliverable:** admin can manage all three editions of one work independently.

## Task 5 — Edition entitlements, library và reader boundary

**Modify:** `lib/access/`, `lib/data/{library,users}.ts`, `lib/reader/{session,api-client}.ts`, protected reader route handlers under `app/`, admin grant screens, authenticated entitlement/session/progress SQL and policies.

**Create:** `app/[lang]/(reader)/read/editions/[editionId]/page.tsx` using the existing reader route group's conventions after inventory; `supabase/tests/press_edition_access.sql`. If the repo uses a different route group, place this URL alongside its existing reader page rather than creating a second shell.

**Tests:** `e2e/reader-access.spec.ts`, `e2e/ebook-golden-path.spec.ts`, `lib/data/library.test.ts`, `lib/reader/session.test.ts`.

- [ ] Switch entitlement and library identity to profile+edition. Preserve grant-source semantics so revoking an order does not remove another active grant.
- [ ] Implement `getReadableEdition`; reader session validates publication → asset → edition → entitlement, including resources, search, annotations and samples. Disallow cross-edition UUID substitution.
- [ ] Add edition read route and safe legacy book-route resolution: one owned edition redirects, multiple shows chooser, none denies. No catalog fallback in access checks.
- [ ] Group library editions by work while retaining every owned language across UI changes; separate reading progress/completion per publication. Keep archive/revocation behavior explicit.
- [ ] Tests: EN-only owner cannot access JA by page, RPC, resource or cached session; anonymous denied; admin grant JA works; revoke JA leaves EN; expired session refresh cannot widen rights.
- [ ] Test EPUB update/rollback and old annotation/quote links remain on their actual publication; do not migrate locators across translations.

**Deliverable:** access isolation proven independently of checkout.

## Task 6 — Bật lại manual QR, admin confirm và edition checkout

**Modify:** `lib/commerce/{orders,coupon-order,types,payment-provider,manual,manual-payment}.ts`, `lib/config/server-env-schema.ts`, `.env.example`, `app/admin/payments/`, `app/admin/orders/`, manual payment SQL, `lib/data/orders.ts`, `components/catalog/{book-action-control,viewer-book-action,price-label}.tsx`, checkout/actions under `app/[lang]/`, emails/outbox.

**Create:** `lib/commerce/money.ts`, `lib/commerce/money.test.ts`, `supabase/tests/press_edition_orders.sql`, `e2e/edition-purchase.spec.ts`, `e2e/manual-payment.spec.ts`.

- [ ] Implement `createEditionOrder`; accept edition+offer only and validate entire chain server-side within transaction. Snapshot edition/language/title/amount/currency/provider on order item.
- [ ] Move free acquisition and manual confirmation/revoke to Task 5 access functions. Idempotency/locks distinguish EN and JA purchases of same work.
- [ ] Central money helper handles currency exponent and decimal-string bigint transport; admin amount input converts without binary floating-point rounding. Do not silently coerce amounts outside safe provider bounds.
- [ ] Bật `PAYMENT_PROVIDER=manual` và bốn biến `BANK_TRANSFER_*` theo `docs/runbooks/manual-payment.md`; dùng thông tin tài khoản Press do admin cung cấp, không copy tài khoản VN. Cập nhật cấu hình mẫu và deployment runbook. Đồng bộ DB `commerce_settings.payment_provider='manual'`; chỉ mở `payments_enabled=true` ở bước release đã kiểm chứng cấu hình.
- [ ] Khôi phục transfer checkout hiện hữu: VietQR với đúng amount/reference, thông tin ngân hàng dạng text, nút “Đã chuyển khoản”, trạng thái chờ admin. Localize VI/EN/JA; báo chuyển khoản không cấp quyền.
- [ ] Giữ `/admin/payments` và màn hình order confirm/decline; kiểm tra amount thực nhận, bank reference, audit, retry/idempotency và authorization. Đơn đã báo chuyển khoản giữ nguyên giá đã chuyển theo hành vi hiện tại.
- [ ] Loại SePay khỏi runtime/config hợp lệ của Press, không cấu hình secret hay checkout redirect. Endpoint SePay nếu còn giữ phải fail closed trước xử lý event; không grant từ callback. Không sửa enum/migration lịch sử chỉ để xóa tên provider.
- [ ] Add currency capability guard trước tạo payable order và trước transfer page: launch manual QR VND; unsupported USD/JPY bị chặn server-side, giữ free flow. Không tự chuyển tỷ giá hoặc tạo QR ngoại tệ.
- [ ] Keep quote/staleness behavior explicit: if submitted offer is no longer valid or amount changed, show refreshed price and require a new order attempt. Existing paid snapshot immutable.
- [ ] Test 500 JPY, 500 USD minor and 50000 VND; unsupported currency, zero price, expired sale, coupon mismatch, admin confirm lặp/concurrent, thiếu/thừa tiền, bank reference trùng, unauthorized confirm, SePay callback không cấp quyền, two simultaneous edition purchases.
- [ ] E2E buy EN then JA, verify separate library entries and progress; switch UI during pending order and confirm product/currency unchanged.

**Deliverable:** manual QR VND hoạt động từ mua đến admin confirm và đọc đúng edition; không sử dụng SePay.

## Task 7 — Bundle, gift, coupon và reader voice

**Modify:** `lib/data/{bundles,public-bundles,gifts,reviews,shared-quotes}.ts`, `lib/commerce/{gifts,coupon}.ts`, bundle/gift SQL, `app/admin/bundles/`, review/question actions and emails.

**Tests:** `e2e/{bundle-purchase,bundles-and-gifts,coupons,reader-voice,shareable-quotes}.spec.ts`, new `supabase/tests/press_edition_bundles.sql`.

- [ ] Bundle editor selects edition IDs and shows language; allow intentional bilingual bundle, no implicit auto-substitution. Offer remains fixed per bundle.
- [ ] Snapshot all edition contents at order creation; gift acceptance grants these snapshots regardless of recipient locale or later bundle edit.
- [ ] Preserve existing partial-ownership pricing policy unless explicitly changed; compute ownership by edition. Disclose included languages and already-owned editions before paying.
- [ ] Make coupon scope evaluation edition-aware; fixed currency must match order; rounding and upper bound tested.
- [ ] Scope reviews to edition, keep work roll-up as derived presentation; migrate old review mapping with same ambiguity guards. Preserve publication-linked shared quotes.
- [ ] Turn off ask-author by default for classics, replace misleading author-response copy with editorial wording for Press-owned reply workflows.
- [ ] E2E buyer EN, recipient JA, mutate bundle before claim, then verify exact original editions; repeat gift claim/manual confirmation safely; revoke one entitlement source without widening/removing unrelated rights.

**Deliverable:** all secondary acquisition paths preserve edition boundaries.

## Task 8 — Catalog resolver, fallback và search

**Create:** `lib/data/editions.ts`, `lib/data/editions.test.ts`, `components/catalog/edition-selector.tsx`, `supabase/tests/press_catalog_resolution.sql`, `e2e/edition-discovery.spec.ts`.

**Modify:** catalog/search/recommendation SQL RPCs, `lib/data/{catalog,recommendations,public-bundles}.ts`, `lib/catalog/{public-types,browse,revalidate}.ts`, `components/catalog/`, public book/list/entity/search pages and homepage.

- [ ] Implement SQL resolver: explicit edition validated first; otherwise requested language → effective default only → null. Published/active publication required, offer optional. Metadata resolution separate.
- [ ] Use resolver set-wise across lists/search/recommendations; avoid duplicate work cards and first-offer ambiguity. Return IDs/language/fallback flags required by Task 6.
- [ ] Show badge for actual EPUB language and specific currency. Selector changes edition without changing UI; invalid explicit ID cannot fall through into buying another edition.
- [ ] Apply bundle discovery rules from spec; library bypasses catalog language filtering.
- [ ] Revalidate all affected locale routes on default/edition/offer/localization change. Cache includes selected edition; personalized entitlement state must not enter public cached result.
- [ ] Add Japanese no-space search fixture, fallback metadata search, published/draft boundaries and deterministic pagination.
- [ ] Implement table-driven DB tests for spec A03–A05 and A15, including JA exists/no offer, missing default, book default overriding platform default, archived edition and metadata JA with EPUB EN.

**Deliverable:** one consistent edition selection from discovery through checkout.

## Task 9 — Japanese reader quality và editorial provenance

**Modify:** `lib/reader/`, `lib/epub/` only where fixture evidence requires changes; `docs/runbooks/reader-corpus-matrix.md`, `docs/runbooks/epub-processing.md`.

**Create:** safe generated JA fixture under `fixtures/epub/`, provenance/editorial migration + admin fields, edition-feedback form/action and DB tests.

- [ ] Read `docs/adr/ADR-005-reader-engine.md`; test current Readium adapter first, without changing engine or sanitizer merely to accept unsupported markup.
- [ ] Generate JA corpus with kanji/kana/ruby, TOC, Japanese punctuation, selection, long paragraphs, quotes and embedded permitted styles. Verify search/highlights/progress restore.
- [ ] Record horizontal layout launch support. Test vertical layout before claiming support; if unsupported, block/review those assets with an actionable admin message.
- [ ] Add source/translator/license-note/territory/reviewer/date and `unreviewed/approved/blocked` editorial state; require approved before new edition publish. This stores review evidence, not automatic legal determination.
- [ ] Add report-translation-error action with edition/publication/locator, length limits, authenticated rate limiting and admin inbox; no direct email to original author.
- [ ] Run relevant reader suites on Chromium/Firefox/WebKit and record physical-device checks separately as required by runbook.

**Deliverable:** JA readability evidence and a minimum accountable publishing workflow.

## Task 10 — SEO, localization completeness và contract migration

**Modify:** `lib/seo/`, `app/sitemap.ts`, `app/robots.ts`, public metadata/static params, `lib/catalog/static-params.ts`, `lib/knowledge/static-params.ts`, `scripts/assert-prerendered-routes.ts`, knowledge/admin entity forms.

**Tests:** `lib/seo/*.test.ts`, `e2e/{seo-operations,knowledge-hub,admin-entities,localized-routing}.spec.ts`.

- [ ] Generate canonical/hreflang and static params from registry plus actual published localization availability, not a hardcoded pair.
- [ ] Ensure fallback article pages canonical to their source language; edition query URLs don't create duplicate index inventory. JSON-LD is consistent with selected edition and currency.
- [ ] Verify full JA CRUD for author/series/topic/bundle/idea/article, not just book metadata; localized slug switching resolves same entity.
- [ ] Finish contract migrations: enforce non-null edition scope, final unique indexes and revoke/drop obsolete book-only writes after all callers migrated. Validate generated types and compile.
- [ ] Audit identity strings, legacy source domain, payment links and publisher metadata again; update current docs while clearly archiving historical specs.

**Deliverable:** discovery/indexing and schema constraints match the finished product.

## Task 11 — Full verification, rehearsal và release runbook

**Create:** `docs/runbooks/press-launch.md`; complete `docs/runbooks/press-migration.md`.

**Modify:** `docs/runbooks/{testing-environments,deployment,storefront,catalog-admin,checkout,bundles-and-gifts}.md`, CI as needed for JA fixtures and route checks.

- [ ] Run local clean-install and legacy-upgrade fixtures; record mapping counts/invariants and ambiguity abort evidence. Rehearse maintenance cutover with pending events/orders on local fixture only.
- [ ] Verify domain/auth redirect/email sender/asset origins/bank transfer details are Press configuration. Missing config must not fall back to VN. Never copy credentials from VN into documentation.
- [ ] Run `npm run check` (lint, types, unit, build, prerender assertions).
- [ ] Run `npm run db:reset` then `npm run db:test` only if default local stack belongs to this task. Otherwise use `supabase db reset --workdir <owned-local-workdir>` and `supabase test db --workdir <owned-local-workdir>` per runbook.
- [ ] Export local Supabase and Mailpit environment variables per testing runbook; run `npm run check:full`. No tests against cloud; simulator stays local/test/staging.
- [ ] Add edition-purchase specs to `chromium-manual`/manual specs list; không chạy nhầm flow manual trên simulator. Test riêng rằng SePay bị vô hiệu hóa và callback không cấp quyền.
- [ ] Run A01–A16 acceptance matrix and Japanese copy/mobile review. Record each result plus unresolved physical-device checks; do not claim full launch readiness when a gate remains open.
- [ ] Prepare deploy sequence: isolated Press project → migrations → app → auth/email config → source-reviewed seed → workers → đồng bộ app/DB provider manual → kiểm tra tài khoản Press → bật payments sau khi local/staging đã pass QR + admin confirm smoke flow → production smoke không tạo fixture. Không fixture trên cloud. Capture restore/forward-fix policy before rollout.

**Deliverable:** reviewable release evidence. This plan does not authorize production deployment or changes to infinitybooks.vn.

## Task 12 — Optional workstream: manual đa tiền tệ USD/JPY

**Dependency:** chỉ cần trước launch nếu yêu cầu nhận USD/JPY ngay. Không thay quyết định manual bằng một cổng thanh toán tự động và không dùng SePay.

**Files:** `lib/commerce/manual.ts`, `lib/commerce/manual-payment.ts`, cấu hình tài khoản nhận theo currency, checkout transfer view, admin confirmation SQL/UI/tests và `docs/runbooks/manual-payment.md`.

- [ ] Xác định tài khoản nhận đúng USD/JPY, thông tin chuyển khoản cần hiển thị, phí chuyển tiền và quy tắc amount thực nhận trước khi bật currency. Chưa có tài khoản thì giữ checkout currency đó disabled.
- [ ] Cấu hình routing tài khoản theo currency độc lập UI locale; snapshot chỉ dẫn chuyển khoản cho từng order. Không dùng một tài khoản VND để hứa nhận USD/JPY và không tự quy đổi.
- [ ] Hiển thị hướng dẫn manual đúng loại tài khoản. Chỉ hiển thị QR nếu có định dạng hợp lệ cho phương thức nhận đó đã kiểm thử; không dùng VietQR amount VND cho USD/JPY.
- [ ] Mở rộng admin đối soát: actual amount/currency, bank reference, xử lý phí/thiếu/thừa tiền có audit; chỉ confirm khi đáp ứng rule công khai. Giữ quyền theo edition và idempotency.
- [ ] Test currency mismatch, minor units, transfer pending, confirm/decline/retry, confirm lặp và revoke; bật từng currency sau khi kiểm chứng toàn flow.

**Deliverable:** nhận USD/JPY thủ công nếu được chọn triển khai. Trước đó mọi edition có thể dùng offer VND hoặc free; giá ngoại tệ chưa có đường thanh toán không được checkout.

## Coverage và handoff

| Spec section | Task |
| --- | --- |
| 1–3 scope/evidence/architecture | 0, 3 |
| 4 brand/home | 1 |
| 5 languages/localizations | 2, 10 |
| 6 edition/publishing | 3, 4 |
| 7 catalog/fallback | 8 |
| 8 money/orders/access | 5, 6, 12 |
| 9 bundle/gift/reviews | 7 |
| 10 reader/search/SEO | 5, 8, 9, 10 |
| 11 P0 proposals | 7, 9; P1/P2 explicitly deferred |
| 12 migration/rollback | 0, 3, 10, 11 |
| 13 acceptance | 11 plus task-specific regressions |

Đã chốt: manual QR + admin confirm, không SePay kể cả VND. Các điểm còn đề xuất để review: EN làm default, database Press mới không import VN, bundle edition cố định, và launch paid VND trước hay cần USD/JPY ngay. Plan đã chọn defaults rõ ràng để có thể đánh giá đầy đủ; các task chưa được thực thi.
