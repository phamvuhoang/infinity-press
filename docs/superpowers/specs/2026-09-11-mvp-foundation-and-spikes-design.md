# MVP Foundation and Feasibility Spikes Design

**Status:** Approved  
**Date:** 2026-09-11  
**Scope:** GitHub issues #1 and #2, with downstream backlog implications

## 1. Purpose

Deliver the first production-shaped vertical slice of Infinity Books with one real ebook:

```text
Admin creates book
-> Admin uploads EPUB
-> Local CLI processes publication
-> Admin previews and publishes
-> Reader verifies email by magic link
-> Reader receives free or complimentary entitlement
-> Library exposes the book
-> Protected reader opens and restores progress
```

The slice must reduce the highest technical risks without creating throwaway architecture. It establishes the contracts needed for a future payment provider and hosted EPUB worker, but neither integration is required to validate the MVP.

## 2. Product and Delivery Constraints

- The delivery team is one product owner working with Claude/Codex in an AI-native development workflow.
- MVP is ebook-only.
- Physical books, inventory, shipping, COD, fulfillment, logistics, and tracking are deferred without a committed delivery date.
- A real Vietnam payment provider is deferred until product usage demonstrates enough feasibility to justify partner onboarding and support.
- The MVP must still model commerce behind a provider-neutral boundary so a real provider can be added without rewriting orders or entitlements.
- At least five real Infinity Books EPUB files will be available for reader and processing validation.
- EPUB is the launch publication format. PDF is not a substitute and requires a separate future reader path.
- The admin application should be complete for the ebook-only MVP domain.
- Google Cloud Tasks and Cloud Run are not part of this phase. EPUB execution runs through a local CLI.
- The database contains only normalized MVP tables. It does not deploy the complete 106-table reference schema or create placeholder tables for deferred features.

## 3. Chosen Delivery Approach

Use a vertical golden path rather than building the platform horizontally.

The first increment supports one ebook end to end. Once the path works, the same domain boundaries are generalized to multiple books and users. This sequence validates EPUB variability, reader-engine behavior, private asset delivery, identity, entitlements, and progress before investing in broad catalog or operational automation.

Rejected approaches:

- **Platform-first:** risks completing a broad schema and admin surface before proving the reader and publication model.
- **Throwaway prototype:** produces a fast visual demo but does not validate authorization, entitlements, publishing, or production data flow.

## 4. System Boundaries

### 4.1 Next.js application

The existing Next.js application owns:

- Public catalog and book pages.
- Email magic-link initiation and callback handling.
- Authenticated library and reader shell.
- Admin catalog, publishing, user, entitlement, commerce-test, SEO, merchandising, role, and audit screens, delivered incrementally across the golden path and later catalog work.
- Server-side mutations and short-lived reader-session issuance.

Server Components remain the default. Client Components are limited to interactive UI and reader-engine integration.

### 4.2 Supabase

Supabase provides:

- Postgres as the source of truth.
- Email magic-link authentication.
- Row Level Security for browser-accessible data.
- Private storage for source EPUBs and paid derived resources.
- Public or CDN-friendly storage only for approved public media such as covers.

The service-role credential is restricted to trusted server and CLI environments. It must never use a `NEXT_PUBLIC_*` variable or be sent to the browser.

### 4.3 Local EPUB processor

The processor is a deterministic CLI built around framework-neutral domain contracts. It:

1. Claims a queued processing job atomically.
2. Verifies source identity, checksum, and requested version.
3. Validates and sanitizes the EPUB.
4. Extracts package metadata, spine, navigation, resources, and stable locator information.
5. Builds versioned reader and sample artifacts.
6. Uploads derived artifacts to private storage.
7. Changes the job to `ready_for_preview`, or records a stable failure code and safe human-facing message.

The admin UI explicitly shows `Waiting for local processor` while no CLI worker is running. The CLI contract must be reusable by a future Cloud Run executor without changing admin or publication data models.

### 4.4 Reader engine

Readium Web is the preferred engine, subject to the issue #1 spike. The integration sits behind a `ReaderEngine` boundary covering:

- Publication loading.
- Table-of-contents and chapter navigation.
- Stable locator serialization and restoration.
- Progress calculation.
- Typography and theme controls.
- Sample-resource enforcement.

If Readium fails the exit criteria, epub.js is evaluated against the same fixtures and interface. The decision is recorded in ADR-005.

## 5. MVP Data Model

### 5.1 Catalog

- `authors`
- `books`
- `book_localizations`
- `editions`
- `skus`
- `offers`
- `topics`
- `book_topics`
- `media_assets`

The model remains `Book -> Edition -> SKU -> Offer`. UI locale, book language, market, and currency are independent fields. Money uses integer minor units and an ISO currency code.

### 5.2 Publishing

- `ebook_assets`
- `processing_jobs`
- `ebook_publications`
- `ebook_resources`
- `book_samples`

Source and derived assets are immutable and versioned. Publishing changes an active-publication pointer only after an authorized preview approval. A prior validated publication remains available for rollback.

### 5.3 Identity and reading access

- `profiles`
- `customer_identities`
- `entitlements`
- `library_items`
- `reading_progress`

The primary customer authentication flow is email magic link. The existing password flow may remain as an internal fallback, but it is not the customer-facing default.

Progress uses a stable engine locator and publication-version strategy. It must not depend only on transient DOM identifiers or raw character offsets.

### 5.4 Commerce validation

- `orders`
- `order_items`
- `payments`
- `payment_events`

These tables support free acquisition and the non-production simulator while preserving the boundary required for a later payment provider.

- A free offer has zero price and `payment_status = not_required`.
- A complimentary entitlement does not create a fake order or payment. Its source is `admin_grant`, and it records the actor and reason.
- The simulator uses provider key `simulator` and is available only in local and staging environments.
- Production configuration must fail closed if the simulator is enabled.

### 5.5 Administration

- `user_roles`
- `audit_logs`
- `redirects`
- `merchandising_slots`

Audit records cover publication, rollback, offer changes, entitlement grant/revoke, and role changes.

## 6. State and Data Flows

### 6.1 EPUB publication

```text
draft
-> uploaded
-> queued
-> processing
-> ready_for_preview
-> published
```

Processing may instead transition to `failed`. A retry creates or claims an explicit attempt and must not overwrite the active publication. Publication versions may later become `superseded`; rollback changes the active pointer rather than mutating prior artifacts.

### 6.2 Free acquisition

1. The user verifies an email through a magic link.
2. The server loads the active zero-price offer.
3. It creates an immutable free order snapshot with payment not required.
4. It grants one entitlement and creates the library item transactionally.
5. Retrying the operation returns the existing result rather than duplicating access.

### 6.3 Complimentary access

1. An admin selects a verified customer identity.
2. The admin selects the publication subject and provides a reason.
3. A trusted server mutation grants or reactivates the entitlement.
4. The same transaction records the immutable audit event.

No payment or paid order is fabricated.

### 6.4 Simulated payment

Local and staging environments can simulate success, failure, cancellation, duplicate events, and out-of-order events. Simulated events enter through the same verified-event handler contract and order-to-entitlement transaction intended for a future provider.

### 6.5 Protected reading

1. The server authenticates the user.
2. It checks an active entitlement for the requested subject.
3. It resolves the active publication version.
4. It issues a short-lived reader session scoped to user, publication, and version.
5. The browser fetches only authorized derived resources.
6. Progress is upserted for the authenticated profile and publication.

Public samples use a distinct manifest and explicit resource allowlist. Client-side hiding is not a security boundary.

## 7. Admin Scope

The ebook-only MVP admin includes:

- Dashboard with book, publication, processing failure, user, and entitlement summaries.
- Author, book, localization, topic, and relation management.
- Edition, ebook SKU, free/test offer, market, and currency management.
- Private EPUB upload and version history.
- Processing status, error details, preview, publish, unpublish, and rollback.
- User lookup and complimentary entitlement grant/revoke.
- Free orders and simulated payment inspection.
- Role management and audit history.
- Redirects, SEO metadata, and basic homepage merchandising.

Issue #2 delivers the admin shell, role/audit foundation, and the minimum one-book create, upload, preview, publish, and entitlement operations required by the golden path. The catalog-admin epic generalizes those paths into the complete ebook-only MVP admin described above.

The admin does not include physical inventory, shipping, fulfillment, logistics, coupons, advanced translation workflow, AI enrichment, or P1/P2 knowledge tooling.

## 8. Security and Failure Handling

- RLS is enabled for every Data API-exposed table.
- Anonymous access is limited to published catalog records and approved sample data.
- Authenticated users can access only their own profile, orders, entitlements, library items, and progress.
- Entitlement and publication mutations require a trusted server boundary.
- Admin permissions are checked in both application logic and database policy/service boundaries.
- EPUB content is untrusted. Processing rejects or sanitizes scripts, inline event handlers, unsafe URLs, unsupported media, malformed structures, and oversized resources according to an explicit supported profile.
- Reader resources use short-lived authorization; raw EPUB URLs are never delivered to the browser.
- Processing jobs use atomic claims and retry-safe versioned output.
- Stable failure codes include invalid EPUB, unsafe content, unsupported media, oversized resource, storage failure, stale version, and unexpected processing failure.
- Admin error messages are actionable without leaking secrets or internal stack traces.

## 9. Verification Strategy

### 9.1 Unit tests

- Order, payment, entitlement, publication, and processing state transitions.
- Idempotency and uniqueness rules.
- Locale/language/market/currency helpers.
- Reader locator serialization and restoration adapters.
- Environment guard that rejects the simulator in production.

### 9.2 Database tests

- Migration reproducibility from an empty local database.
- Constraints for active entitlements, slugs, event IDs, publication versions, and money fields.
- Positive and negative RLS cases, including proof that user A cannot access user B data.

### 9.3 Integration tests

- Private source upload and derived-resource access.
- CLI claim, processing success, stable failure, retry, and stale-version behavior.
- Free order to entitlement transaction.
- Complimentary entitlement plus audit transaction.
- Simulated success, failure, cancellation, duplicate, and out-of-order events.
- Reader-session authorization and sample allowlist enforcement.

### 9.4 End-to-end and reader fixtures

- The complete golden path is covered by an E2E smoke test.
- At least five real Infinity Books EPUBs are checked across representative formatting complexity.
- Target validation covers Chrome, Safari, Firefox, and mobile breakpoints.
- Position restoration is tested after reload, typography changes, and a second authenticated session.

## 10. Issue #1 Breakdown and Exit Criteria

Issue #1 becomes **Validate the ebook reader and provider-neutral access golden path**. It no longer requires selection or integration of a real payment provider.

Suggested child tasks:

1. Define the five-EPUB fixture corpus and expected-results checklist.
2. Define the `ReaderEngine` and stable locator contracts.
3. Run the Readium spike on the browser/device matrix.
4. Evaluate epub.js only if Readium misses an exit criterion.
5. Build the minimum deterministic EPUB processor CLI.
6. Prove private resource delivery and the explicit sample boundary.
7. Define and exercise free, complimentary, and simulated entitlement paths.
8. Complete one-book golden path and record ADR-005.

Issue #1 is complete when:

- The five EPUBs render acceptably or have documented supported-profile rejection reasons.
- Exact position restores after reload and typography changes.
- Anonymous users cannot retrieve paid resources.
- Samples cannot traverse outside their allowlist.
- Free, complimentary, and simulated acquisition each produce exactly one valid entitlement.
- ADR-005 selects the engine with evidence and records fallback gaps.
- No unresolved reader, processing, or access-model blocker remains.

## 11. Issue #2 Breakdown and Exit Criteria

Issue #2 becomes **Establish the production baseline for the ebook-only golden path**.

Suggested child tasks:

1. Add CI for lint, typecheck, unit, database/RLS, build, and E2E smoke tests.
2. Define and validate local, preview, staging, and production configuration.
3. Establish locale-prefixed routing while keeping language, market, and currency independent.
4. Implement the normalized MVP schema through reviewed migrations.
5. Add the RLS positive/negative test harness.
6. Make email magic link the primary customer authentication path.
7. Add public, account, reader, and admin application shells plus the minimum one-book admin flow required by the golden path.
8. Add admin-role and immutable-audit foundations.
9. Configure private/public storage boundaries and authorized upload/session helpers.
10. Add correlation IDs, structured errors, and the observability baseline.

Issue #2 is complete when:

- Required CI checks block merging on failure.
- A fresh database can be created entirely from migrations.
- Cross-user negative authorization tests pass.
- Anonymous users can access only the intended published/sample data.
- Admin role enforcement and audit recording work through trusted mutations.
- An authorized admin can create the golden-path book, upload its EPUB, inspect processing state, preview it, publish it, and grant complimentary access.
- Production rejects simulator configuration.
- A web request can be correlated with its database operation and CLI job.

## 12. Downstream Backlog Changes

After this design is accepted into the backlog:

- Issue #1 removes real-provider selection and focuses on reader/access feasibility.
- Issues #5 and #6 remove all physical commerce, inventory, fulfillment, shipping, COD, and logistics work.
- Issue #6 keeps the provider adapter contract but implements only free acquisition and the non-production simulator for MVP.
- Issue #7 uses email magic link as the primary customer flow.
- Issue #8 replaces Cloud Tasks and Cloud Run execution with the local CLI while retaining reusable job and processor contracts.
- Issue #11 removes physical-commerce launch gates and verifies free, complimentary, and simulated ebook flows.

Updating live GitHub issue descriptions is a separate backlog-maintenance action after review of this specification.

## 13. Deferred Work

- Real payment-provider onboarding and integration.
- Physical commerce and logistics.
- Hosted durable EPUB execution through Cloud Tasks and Cloud Run.
- PDF reader support.
- Highlights, notes, bookmarks, and in-book search.
- Coupons, bundles, and paid promotion rules.
- Advanced localization workflow and additional market launches.
- Semantic discovery, Ask Infinity, audio, and DRM expansion.
