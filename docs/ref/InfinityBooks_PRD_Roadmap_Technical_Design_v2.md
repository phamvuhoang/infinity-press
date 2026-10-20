**INFINITY BOOKS**

**Product Requirements, Roadmap  
& Technical Implementation Design**

Web application for commerce, digital library, ebook reading and knowledge discovery

**Product thesis**

Infinity Books should be built as an author-led publishing and reading platform — Bookstore + Digital Library + Reader + Knowledge Graph — rather than as a conventional ecommerce storefront.

| **Item** | **Decision** |
| --- | --- |
| **Initial market** | Vietnam |
| **Expansion** | Global-ready from day one: locale, market, currency and language are separate concerns |
| **Frontend / web** | Next.js App Router on Vercel |
| **Data / auth / storage** | Supabase: Postgres, Auth, Storage, RLS |
| **Long-running compute** | Google Cloud Run, triggered through durable asynchronous jobs |
| **Primary ebook direction** | Readium Web technical spike; fallback to epub.js if exit criteria are not met |
| **Document status** | Implementation baseline — intended for product, design and engineering estimation |

_Prepared as a self-contained implementation specification. Timing assumes a focused product team and should be re-estimated after design completion and payment/fulfillment provider selection._

# Document map

This document combines product scope, release planning and engineering design. The sections are ordered so the team can first align on what is being built, then when, then how.

**Part I — Product Requirements**

1\. Product strategy and success criteria  
2\. Personas and jobs-to-be-done  
3\. Scope and functional requirements  
4\. End-to-end journeys  
5\. SEO / generative-search / content requirements  
6\. Analytics and acceptance criteria

**Part II — Roadmap**

7\. Release strategy  
8\. 16-week launch roadmap<br>
9\. Backlog after launch  
10\. Dependencies, staffing and risks

**Part III — Technical Implementation Design**

11\. Architecture principles and system context  
12\. Next.js / Supabase application design  
13\. Data model  
14\. Commerce and payment design  
15\. Ebook ingestion and reader architecture  
16\. Search, SEO and internationalization  
17\. Security, observability, testing and operations  
18\. Migration and launch plan  
19\. Architecture decisions and technical references

**PART I**

**PRODUCT REQUIREMENTS DOCUMENT**

What Infinity Books must deliver to readers, buyers, authors and operators.

# 1\. Product strategy and success criteria

## 1.1 Product vision

Infinity Books will be a premium digital publishing platform where a person can discover an idea, understand the relevant book, purchase it with minimal friction, read the ebook immediately, preserve progress/highlights/notes, and continue discovering connected ideas and books.

_Figure 1. The core product loop: discovery → book → purchase → library → reading → knowledge → discovery._

## 1.2 Strategic principles

| **Principle** | **Implication** |
| --- | --- |
| **Book is the central entity** | A book is not just a SKU. It connects author, edition, format, series, topics, concepts, articles, excerpts, offers, reviews and reading assets. |
| **Commerce must disappear into the experience** | Guest checkout is the default. Ebook checkout removes shipping fields. Payment success should lead directly to “Read now”. |
| **Reading is a first-class product** | Reader quality, progress persistence, annotations and reliable entitlement matter as much as the storefront. |
| **Ideas create discovery** | Topic/Idea pages answer real reader questions and connect naturally to books. They are not thin SEO landing pages. |
| **Public knowledge, private paid text** | Metadata, approved excerpts and samples are crawlable; the full paid ebook, library, checkout, highlights and notes are private/noindex. |
| **Global-ready, Vietnam-first** | Locale, book language, market, currency, pricing and fulfillment are modeled independently so English/Japanese/global expansion does not require a rewrite. |

## 1.3 Goals

- Create the best direct-to-reader purchasing experience for Infinity Books, particularly on mobile.
- Enable instant browser-based ebook reading immediately after successful payment.
- Give each book a high-quality, indexable canonical entity page with complete metadata and semantic connections.
- Build a reusable knowledge layer around authors, topics, ideas, excerpts and articles that supports organic and AI-assisted discovery.
- Give internal operators a reliable publishing workflow for books, editions, offers, EPUB assets, metadata and merchandising.
- Prepare the foundation for multilingual publishing, international pricing and new formats without coupling V1 to one payment or shipping provider.

## 1.4 Non-goals for launch

- No social network, public follower system, community feed or complex gamification.
- No native iOS/Android app in V1; the web reader must be excellent and responsive.
- No full DRM promise. Browser delivery can deter casual copying but cannot provide absolute protection; stronger DRM is a separate product/legal requirement.
- No AI chatbot as a launch dependency. “Ask Infinity” is P1/P2 after the core catalog, commerce and reader are stable.
- No marketplace for third-party publishers in V1.
- No attempt to create hundreds of low-value SEO/“GEO” pages from query variants.

## 1.5 Success metrics

| **Area** | **Metric** | **Definition / target direction** |
| --- | --- | --- |
| **Acquisition** | Organic visibility | Indexed canonical book/author/topic pages; Search Console impressions/clicks; branded vs non-branded discovery |
| **Commerce** | Book view → purchase conversion | Primary business conversion; segmented physical vs ebook, new vs returning, device and acquisition channel |
| **Checkout** | Checkout completion | Start checkout → payment success; target progressive improvement and error budget by payment method |
| **Ebook activation** | Paid → first read | ≥95% of successful ebook purchases should receive entitlement and open the reader without support intervention |
| **Reading** | Continue-reading retention | Share of ebook buyers returning to read within 7 and 30 days |
| **Reading** | Completion / depth | Chapter progression and completion by book; do not turn this into coercive gamification |
| **Knowledge** | Idea/article → book CTR | Measures whether the knowledge layer actually helps discovery |
| **Reliability** | Core Web Vitals | At p75: LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 on key public pages |
| **Reliability** | Commerce correctness | No duplicate entitlements, no paid order without recoverable fulfillment path, idempotent payment webhooks |
| **Publishing** | EPUB processing success | ≥99% for validated supported EPUBs; clear operator-facing failure reasons for rejected files |

# 2\. Personas and jobs-to-be-done

| **Persona** | **Primary job** |
| --- | --- |
| **New reader from search/social** | Understand whether a book is relevant and trustworthy; sample it; buy without account friction. |
| **Ebook-first reader** | Pay and start reading immediately on mobile; continue across devices; keep progress, highlights and notes. |
| **Physical-book buyer** | Choose edition/format, pay using familiar Vietnam methods, understand delivery and track order. |
| **Returning reader** | Open My Library and continue from the exact last location without hunting through order history. |
| **International reader** | Use the right language/market/currency and buy/read digital products even where physical fulfillment differs. |
| **Editorial / publishing operator** | Create and publish books, metadata, samples, topics, articles and translations; preview before release. |
| **Commerce operator** | Manage orders, refunds, inventory, coupons, payment exceptions and fulfillment status. |
| **Admin / owner** | Control roles, monitor jobs, SEO health, catalog quality, payments and audit history. |

## 2.1 JTBD statements

- When I discover a book through Google or social media, I want to understand its ideas and relevance quickly so I can decide whether to sample or buy.
- When I buy an ebook, I want to start reading immediately without creating a password so the purchase feels instant.
- When I return days later, I want the book to open where I left off so the platform feels like my library rather than a store.
- When I encounter an important passage, I want to highlight or add a note and reliably find it later.
- When I search for a life question rather than a title, I want Infinity Books to help me discover the ideas and books that genuinely address that question.
- When I publish a new ebook, I want a deterministic validation/preview workflow so I know what readers will see before I press Publish.

# 3\. Scope and functional requirements

## 3.1 Priority definitions

| **Priority** | **Meaning** |
| --- | --- |
| **P0 — Launch blocker** | Required for commercial launch or correctness/security. |
| **P1 — Next release** | High-value capability that can ship after the core loop is stable. |
| **P2 — Expansion** | Scale, intelligence, growth or new-format capabilities. |

## 3.2 Public discovery and catalog

| **Priority** | **Capability** | **Requirement** |
| --- | --- | --- |
| P0  | Home | Editorial homepage with featured book, curated shelves, topics, author introduction, philosophy and newsletter. |
| P0  | Book catalog | Search, filter and sort books by topic, author, series, format, language, price and merchandising status. |
| P0  | Book detail | Canonical commercial + editorial page: cover, title, author, formats, price, CTA, sample, description, audience, key ideas, TOC, metadata, author, related books/articles and FAQ content. |
| P0  | Author detail | Authoritative entity page with biography, books, series, themes and articles. |
| P0  | Series detail | Series narrative, sequence, recommended starting point and member books. |
| P0  | Topic detail | Editorial topic page connecting concepts, books and articles. |
| P0  | Search | Cross-entity search with books as the primary result and grouped author/topic/article results. |
| P1  | Idea / Knowledge hub | Structured concept pages with direct answer, explanation, examples, related books and related ideas. |
| P1  | Collections | Curated editorial collections such as Start Here, For Parents, Love, Gifts. |
| P1  | Articles | Magazine-style editorial hub and article detail pages connected to books/concepts. |
| P2  | Semantic search | Meaning-based book/idea discovery, blended with lexical search. |

## 3.3 Commerce

| **Priority** | **Capability** | **Requirement** |
| --- | --- | --- |
| P0  | Guest cart | Cart persists for anonymous and authenticated users; merge safely after sign-in. |
| P0  | Format / SKU selection | Physical, ebook, hardcover or bundle displayed as explicit purchasable variants. |
| P0  | One-page checkout | Only ask for fields required by the items in the cart. Ebook-only checkout contains no shipping fields. |
| P0  | Vietnam payments | Payment adapter supports configured local methods such as QR/bank, MoMo, ZaloPay, VNPay/cards/COD as business agreements permit. |
| P0  | Payment webhook truth | Order becomes paid only from verified server-side payment confirmation/webhook, never from the browser redirect alone. |
| P0  | Instant entitlement | Successful ebook payment creates an entitlement transactionally/idempotently and exposes “Read now”. |
| P0  | Order history | Signed-in users see order details; guest buyers can later claim/access by verified identity. |
| P0  | Refund path | Operator can refund/cancel; entitlement revocation policy is explicit and audited. |
| P0  | Physical fulfillment status | Minimal status model and tracking reference even if initial shipping updates are manual. |
| P1  | Coupons and bundles | Promo codes, bundle pricing and merchandising rules. |
| P1  | Inventory reservation | For constrained stock, reserve inventory during payment window to avoid oversell. |
| P2  | Regional pricing/tax adapters | Market-based offer configuration and tax/fulfillment differences. |

## 3.4 Authentication, library and account

| **Priority** | **Capability** | **Requirement** |
| --- | --- | --- |
| P0  | Identity | Email and/or phone; passwordless magic link/OTP preferred; password can remain fallback. |
| P0  | Guest purchase claim | Purchases made before account creation attach to a verified identity and become visible after login. |
| P0  | Library | Currently reading, unread and completed books; primary CTA is Continue reading. |
| P0  | Reading progress | Last location and percentage sync across supported browsers/devices. |
| P0  | Order/account settings | Profile, order history and address management. |
| P1  | Highlights | Create, edit, remove and filter highlights by book. |
| P1  | Notes | Attach notes to locators/highlights and reopen exact reading location. |
| P1  | Bookmarks | Save named locations. |
| P1  | Wishlist | Save books before purchase. |
| P2  | Social sign-in | Google/Apple when justified by conversion and target markets. |

## 3.5 Ebook reader

| **Priority** | **Capability** | **Requirement** |
| --- | --- | --- |
| P0  | Open / resume | Reader opens entitlement-owned book and resumes exact last locator. |
| P0  | Navigation | TOC, next/previous chapter, chapter title, progression and back to library. |
| P0  | Typography | Font family/size, line height, margins/text width and theme preferences. |
| P0  | Responsive reading | Comfortable reflowable reading on mobile, tablet and desktop. |
| P0  | Sample mode | Public sample reader works without entitlement and cannot traverse beyond allowed sample resources. |
| P0  | Private assets | Raw paid EPUB is never public. Reader resources require short-lived authorized access. |
| P1  | Search inside book | Full-text search over processed text with locator navigation. |
| P1  | Highlight / note | Text selection → highlight / note / share-limited quote. |
| P1  | Reading completion | Quiet completion screen with review/highlights/related book actions. |
| P2  | Ask Infinity | Contextual Q&A grounded to authorized book content with passage/chapter citations. |
| P2  | Audiobook | Same library model extended to audio publication assets. |

## 3.6 Admin / publishing operations

| **Priority** | **Capability** | **Requirement** |
| --- | --- | --- |
| P0  | Book editor | Work-level metadata, localized copy, author, series, topics, key ideas, TOC, quotes, related books and publish state. |
| P0  | Edition / SKU / offer editor | Language, ISBN, edition, formats, prices, market availability and inventory. |
| P0  | EPUB workflow | Upload source → processing → preview → publish; detailed failure reason and retry. |
| P0  | Homepage merchandising | Feature books/shelves without deployment. |
| P0  | Orders/payments | Find order, inspect payment events, record fulfillment and refund/cancel. |
| P0  | Roles/audit | Admin roles and immutable audit trail for sensitive changes. |
| P1  | SEO manager | Metadata preview, redirects, canonical/hreflang checks and structured-data preview. |
| P1  | Translation manager | Locale coverage and publication readiness per language. |
| P1  | Knowledge editor | Ideas/concepts and relations to books/articles. |
| P2  | AI enrichment jobs | Optional metadata/summary/tagging workflow with human approval before publish. |

## 3.7 Complete page inventory

| **Surface** | **Pages / screens** |
| --- | --- |
| **Public** | Home; Books; Book detail; Series index/detail; Authors index/detail; Topics index/detail; Ideas index/detail; Collections index/detail; New releases; Best sellers; Ebook collection; Physical books; Bundles; Free/sample reading; Search; About; Phương Bùi/author entity; Philosophy/Mission; Foundation if applicable; Articles index/detail; Newsletter; Contact; FAQ. |
| **Commerce** | Cart; mini-cart; checkout; payment processing/success/failure/cancelled; order tracking; gift/coupon redemption. |
| **Auth** | Login; sign-up; magic link/OTP; verification; reset/fallback. |
| **Account** | Library; library book detail; orders/detail; wishlist; reading history; highlights; notes; bookmarks; profile; addresses; notifications; language/region; privacy/data settings. |
| **Reader** | Reader; TOC; in-book search; highlight/note overlay; reader settings; sample reader; completion state. |
| **Support/legal** | Help center; ebook help; shipping; returns/refunds; payment guide; privacy; terms; ebook license; cookies; accessibility. |
| **System** | 404; 500; offline; maintenance; empty search; empty library; access denied; unavailable book; entitlement error. |
| **Admin** | Dashboard; books/create/edit; editions; SKUs/formats; EPUB assets/jobs; chapters; authors; series; topics; concepts; collections; articles; pages; excerpts; media; merchandising; orders; payments; refunds; customers; coupons; promotions; bundles; inventory; SEO; redirects; sitemap/index status; structured data preview; locales/translations; markets/currencies; notifications/templates; roles; audit; settings. |

# 4\. End-to-end journeys and acceptance criteria

| **Journey** | **Flow** | **Acceptance** |
| --- | --- | --- |
| **A. Organic → physical book** | Search result → canonical book page → select physical SKU → Buy now → contact + shipping → payment → confirmation/tracking. | User can complete without creating an account; server owns final price; paid state is webhook-confirmed. |
| **B. Social → ebook** | Social link → book page → select ebook → minimal checkout → payment → entitlement → Read now. | No shipping fields; successful payment grants exactly one active entitlement; reader opens immediately. |
| **C. Question → idea → book** | Search question → Idea page → related book → sample → buy ebook → reader. | Idea page is useful by itself and contains clear relations, not a doorway page. |
| **D. Returning reader** | Login/magic link → Library → Continue reading → exact last locator. | Position sync is monotonic/reconciled and survives device changes. |
| **E. Reader annotation** | Select text → highlight → optional note → close → later open Highlights → jump to exact locator. | Annotation persists and remains anchored after ordinary layout/font changes. |
| **F. Admin publication** | Create book/edition → upload EPUB → async processing → preview → publish → public book page + reader availability. | Publish is impossible while required validation or assets are missing. |
| **G. Refund** | Operator refunds paid ebook order → payment provider confirmed → entitlement policy applied → audit event. | Operation is idempotent and never revokes unrelated entitlements. |
| **H. International locale** | English user lands on /en book URL → sees English metadata and supported offer → buys ebook → reads. | Locale, language and market are independent; no assumptions that English means USD or US. |

## 4.1 Key edge cases

- Payment succeeds but browser closes before redirect: webhook still completes order/entitlement and a later login reveals the book.
- Webhook delivered multiple times or out of order: event is deduplicated by provider event ID and transitions are idempotent.
- Guest buys twice with the same email: identity merge must not duplicate entitlements and order history remains intact.
- EPUB contains scripts, unsafe external URLs, malformed markup, huge assets or unsupported media: pipeline rejects or sanitizes before publication.
- Book price changes while item is in cart: checkout uses server-side current offer and explicitly tells the user when recalculation changes total.
- Locale translation missing: fall back according to explicit policy; do not create duplicate indexable pages with identical content.
- Entitlement revoked/refunded while reader is open: next resource/session refresh denies protected content gracefully and returns user to library/support.
- Stock runs out during physical checkout: payment initiation must not promise inventory that cannot be fulfilled; use reservation when stock becomes constrained.

# 5\. SEO, generative-search and content requirements

## 5.1 Core strategy

**Important correction to common “LLMO” advice**

For Google Search generative features, there is no special LLMO/AEO markup requirement. Google’s 2026 guidance says normal SEO fundamentals, crawlability, valuable non-commodity content and clear technical structure remain the foundation; Google explicitly says llms.txt does not help or hurt Google Search visibility. Infinity Books may still publish llms.txt for other ecosystems, but it is optional and not a launch dependency.

| **Requirement** | **Implementation intent** |
| --- | --- |
| **Canonical entities** | Stable indexable URL for each book, author, series, topic/idea and article. Avoid parameter-generated duplicates. |
| **Locale URLs** | Use /vi/, /en/, /ja/ path strategy with canonical + hreflang and locale-preserving navigation. |
| **Metadata** | Next.js Metadata API: title, description, canonical, robots, Open Graph/Twitter image, alternate locales. |
| **Structured data** | Book plus applicable Product/Offer, Person/Organization, BreadcrumbList, Article. Structured data must match visible page content. |
| **Book facts** | ISBN, edition, language, publication date, publisher, page count, format, availability and price are explicit and machine-readable. |
| **Internal links** | Book ↔ author ↔ series ↔ topics/ideas ↔ articles ↔ related books. Important content must be reachable by normal links. |
| **Sitemaps** | Segment by locale/entity if volume grows; update on publish/unpublish and retain 301 redirect map during migration. |
| **Public/private boundary** | Reader/account/checkout/orders/highlights/notes are noindex and authorization-protected. Paid raw resources are not crawlable. |
| **Content quality** | Idea/article pages must add original author/publisher value rather than paraphrasing generic web knowledge. |
| **Optional llms.txt** | P2/experimental for services that explicitly consume it; never use it as a substitute for HTML, structured data or sitemaps. |

## 5.2 Book-page semantic contract

Book page  
├─ Identity: title, subtitle, canonical book ID/URL  
├─ Creator: author → authoritative Person page  
├─ Publication: edition, publisher, ISBN, language, date, page count  
├─ Commerce: SKU/format → Offer → market/currency/availability/price  
├─ Meaning: description, audience, key ideas, topics, series  
├─ Evidence: TOC, approved sample/excerpt, update date  
├─ Relationships: related books, articles, author, concepts  
└─ Actions: sample, buy, read (if entitled)

## 5.3 Performance and accessibility

- Public pages target “good” Core Web Vitals at the 75th percentile: LCP ≤2.5s, INP ≤200ms, CLS ≤0.1.
- Server Components by default; Client Components only where interaction requires browser state.
- Book covers use predictable aspect ratios and responsive images to avoid layout shift.
- Keyboard navigation, visible focus, semantic landmarks, labels, contrast and minimum ~44px touch targets on mobile.
- Reader settings must allow larger type and comfortable line lengths without breaking navigation.

# 6\. Analytics, experimentation and launch acceptance

## 6.1 Event taxonomy

| **Domain** | **Events** |
| --- | --- |
| **Discovery** | view_home, search, view_search_results, view_book, view_author, view_topic, view_idea, open_sample |
| **Commerce** | select_format, add_to_cart, begin_checkout, select_payment_method, payment_redirect, purchase, payment_failed, refund |
| **Reader** | open_reader, resume_reader, chapter_view, progress_25/50/75/100, change_reader_setting, search_in_book |
| **Annotations** | create_highlight, delete_highlight, create_note, create_bookmark, share_quote |
| **Library** | view_library, continue_reading, mark_finished |
| **Publishing** | book_published, epub_job_started/completed/failed, offer_changed, redirect_created |

Analytics must never collect full paid ebook text, note contents or highlight contents by default. Track event metadata (book ID, chapter ID, locator hash/progression, device class) rather than sensitive reading text.

## 6.2 Launch go/no-go checklist

| **Gate** | **Exit criteria** |
| --- | --- |
| **Catalog** | All launch books have canonical locale URLs, required metadata, correct offers, covers and samples. |
| **Payments** | Configured methods pass success/failure/cancel/refund and duplicate webhook test cases. |
| **Entitlements** | Paid ebook can be opened immediately and on a second device after sign-in. |
| **Reader** | Supported EPUB fixtures render correctly on Chrome/Safari/Firefox and mobile breakpoints; progress survives refresh. |
| **Security** | RLS tests pass; service role not exposed; raw EPUB private; admin protected; webhook signatures verified. |
| **SEO** | Sitemap/robots/canonical/hreflang/JSON-LD validated; old URLs mapped to 301 where required. |
| **Performance** | Core public templates meet performance budget in pre-production and image/CDN strategy is verified. |
| **Operations** | Admins can diagnose failed EPUB jobs and payment exceptions without engineering database edits. |
| **Backups/rollback** | DB/storage backup strategy and deployment rollback are documented and tested. |
| **UAT** | Owner/editorial/ops acceptance completed on production-like data. |

**PART II**

**ROADMAP**

A launch sequence that protects the core purchase-and-read loop from scope dilution.

# 7\. Release strategy

**Recommended release shape**

Target a 16-week launch baseline assuming approximately 3 engineers (at least two strong full-stack), one product/design owner, and part-time QA/content operations. With 1–2 engineers, keep the same dependency order but expect roughly 20–28+ weeks. Do not trade payment/entitlement correctness or reader security for calendar speed.

## 7.1 Release definition

| **Release** | **Outcome** |
| --- | --- |
| **MVP / Launch** | Complete discovery → purchase → entitlement → read loop; public catalog; local commerce; library; deep reader with visual parity, highlights/notes/bookmarks/search-in-book and limited attributed sharing; minimal admin; foundational SEO; migration/cutover. |
| **P1 / Growth** | Knowledge/idea hub, editorial CMS expansion, coupons/bundles, SEO ops, translation workflow and richer analytics. Reader Depth (formerly P1.1) is pulled forward into the launch sequence as S5.5. |
| **P2 / Scale** | Semantic discovery, Ask Infinity, audiobooks, regional payment/fulfillment adapters, stronger content protection/DRM if required, advanced personalization. |

# 8\. 16-week implementation roadmap

| **Weeks** | **Theme** | **Scope** | **Exit criteria** |
| --- | --- | --- | --- |
| **W1–2** | Foundation & technical spikes | Repo/CI; environments; Supabase schema baseline; Auth/RLS skeleton; design tokens; route/locale architecture; payment provider proof; Readium Web spike; EPUB sample corpus; observability baseline. | Architecture decisions locked; reader/payment spike exit criteria passed; no unresolved launch-blocker dependency. |
| **W3–4** | Catalog & public entities | Books/authors/series/topics; localized slugs; book detail; catalog/search v1; admin book/edition/SKU/offer editor; covers/media; metadata/JSON-LD foundation. | Representative books publish from admin and render production-quality public pages. |
| **W5–6** | Commerce | Cart; guest identity; checkout; server-side pricing; payment adapter; webhooks/idempotency; order state machine; physical fulfillment fields; success/failure pages. | Test payment matrix passes and paid physical order can be fulfilled without manual DB changes. |
| **W7–8** | Identity, entitlements & library | Magic link/OTP; guest purchase claim; profiles/addresses; explicit ebook entitlements; library; order history; progress schema; authorization tests. | Successful ebook payment creates one entitlement and library access across sessions/devices. |
| **W9–10** | EPUB pipeline & reader | Upload/process/preview/publish; private assets; Readium integration; TOC; themes/typography; resume; sample mode; reader session/resource authorization. | Launch EPUB corpus passes visual QA; raw EPUB cannot be publicly fetched; reader works on target browser matrix. |
| **W11–12** | SEO, content & operations | Sitemaps/robots/hreflang/canonical; structured-data validation; old URL redirect map; articles/topics polish; admin job/error views; analytics events; email/notifications. | Search/SEO checklist clean; ops can diagnose key failures; content migration substantially complete. |
| **W13–14** | Reader depth & visual parity (S5.5) | Persistent desktop sidebar; responsive one/two-page layout; highlights, notes, bookmarks, full-book search, stable digital positions, limited attributed copy/share and richer completion. “Ask Infinity” is shown only as a disabled future affordance. | Reader-depth flows, authorization, visual snapshots and locator restore pass at 390/768/1440px; five-EPUB matrix includes annotations, search and spread behavior. |
| **W15–16** | Hardening, migration & launch | Load/performance; accessibility; security/RLS; webhook chaos/retry tests; reader-depth UAT; inventory/order cutover; DNS/redirect launch; monitoring dashboards; rollback rehearsal. | All go/no-go gates pass; cutover and rollback owners are named; launch sign-off. |

## 8.1 Parallel workstreams

| **Workstream** | **Sequence** |
| --- | --- |
| **Product/Design** | Brand/design system → book/checkout/reader high-fidelity → responsive states → S5.5 visual parity → admin utility screens → UAT polish. |
| **Web/Commerce** | Next.js public shell → catalog → checkout/payment → account/library → SEO/performance. |
| **Publishing/Reader** | Data model → EPUB processor → Readium integration → S5.5 annotations/search/visual parity before launch. |
| **Content/Ops** | Catalog cleanup → metadata → covers/samples → redirect inventory → content QA → launch merchandising. |
| **Quality/Platform** | CI/CD → RLS/security → browser/device E2E → observability → load/rollback. |

# 9\. Post-launch roadmap

P1.1 Reader Depth was pulled forward into the pre-launch sequence as S5.5. Its committed scope is
defined in `docs/superpowers/specs/2026-09-19-s5-5-reader-depth-visual-parity-design.md`.

| **Release** | **Theme** | **Scope** |
| --- | --- | --- |
| **P1.2** | Knowledge graph | Idea detail pages, stronger topic relations, related-book editorial tools and article-to-book journeys. |
| **P1.3** | Growth commerce | Bundles, coupons, gift flows, improved recommendation shelves and checkout experiments. |
| **P1.4** | International publishing | Translation workflow, English market launch, additional currencies/payment adapter, Japanese typography QA. |
| **P2.1** | Ask Infinity | RAG over entitled/public content, passage citations, safety/copyright controls, cost monitoring. |
| **P2.2** | Semantic discovery | Embeddings/re-ranking for books/ideas/articles; keep lexical fallback and editorial controls. |
| **P2.3** | Audio | Audiobook publication entity/asset, audio reader and progress sync using the same entitlement model. |
| **P2.4** | Stronger protection | Evaluate Readium LCP/other DRM only if business contracts require it; avoid premature complexity. |

# 10\. Dependencies, staffing and risks

## 10.1 External decisions required early

| **Dependency** | **Action** |
| --- | --- |
| **Payment provider(s)** | Select by W1 so sandbox/webhook/refund flows are testable by W3–6. Keep provider adapter in domain model. |
| **Shipping / fulfillment** | Decide whether initial updates are manual, carrier API or 3PL; shipping integration must not block ebook launch. |
| **Source EPUB quality** | Collect representative real EPUBs immediately; reader/pipeline estimates are invalid without a corpus. |
| **Current-site migration** | Inventory current URLs, catalog, orders/customers to decide what history must migrate vs remain archived. |
| **Editorial ownership** | Define who owns metadata, SEO fields, samples, topic relations and publish approval. |
| **Copyright/protection policy** | Define allowed copy/share amount and whether contractual DRM requirements exist before reader implementation. |

## 10.2 Primary risks and mitigations

| **Risk** | **Why it matters** | **Mitigation** |
| --- | --- | --- |
| **Reader engine maturity** | Readium Web is actively evolving. | Time-box W1–2 spike against real EPUBs; abstract ReaderEngine interface; keep epub.js fallback. |
| **EPUB variability** | Files may contain broken markup, scripts, fonts, unusual CSS/media. | Validation/sanitization pipeline; supported-profile policy; fixture library; operator preview before publish. |
| **Payment edge cases** | Duplicate/out-of-order webhooks or browser abandonment. | Webhook event ledger; signature verification; idempotency; order/entitlement state machine. |
| **SEO migration loss** | New information architecture changes old URLs. | Pre-launch URL inventory, 301 map, canonical/hreflang QA, Search Console monitoring. |
| **Scope expansion** | AI/community/admin perfection can delay core loop. | P0 gate: catalog → buy → entitlement → read; P1/P2 explicitly excluded from launch. |
| **Content leakage** | Browser reader assets can be copied by determined users. | Private source, short-lived access, resource-level authorization, sanitization/CSP, watermark deterrence; be explicit that this is not absolute DRM. |
| **RLS mistakes** | Supabase Data API exposure can leak user/order data. | RLS enabled/tested on exposed tables; sensitive tables in private schema; service role server-only; automated policy tests. |
| **Vendor coupling** | Payment/reader/hosting details leak into domain logic. | Ports/adapters for payments, fulfillment, reader engine and async execution; business IDs remain provider-neutral. |

**PART III**

**TECHNICAL IMPLEMENTATION DESIGN**

System boundaries, data model, workflows, security and engineering plan.

# 11\. Architecture principles and system context

## 11.1 System architecture

_Figure 2. Recommended system boundary: Vercel handles web request/response; durable background work is queued to Cloud Run._

## 11.2 Why this split

- Next.js/Vercel owns page rendering, Server Components, Route Handlers, checkout orchestration and reader session initiation.
- Supabase owns transactional data, identity, authorization policies and object storage. Postgres remains the source of truth for business state.
- Cloud Tasks provides durable asynchronous delivery, retries and rate control for slow work. Cloud Run services/jobs perform EPUB processing and other long-running tasks.
- Even though Vercel functions can now run much longer than before, long execution time alone does not provide durable retries/backpressure. Publishing pipelines should not depend on a browser-held request.
- Payment and fulfillment are external adapters. Provider-specific IDs/events are persisted, but domain state remains provider-neutral.

## 11.3 Recommended repository structure

infinity-books/  
├─ apps/  
│ └─ web/ # Next.js App Router  
│ ├─ app/\[locale\]/...  
│ ├─ components/  
│ ├─ features/  
│ ├─ server/ # repositories + domain services  
│ └─ lib/  
├─ services/  
│ └─ ebook-processor/ # Cloud Run container  
├─ packages/  
│ ├─ domain/ # shared types, state machines, contracts  
│ ├─ ui/ # design-system components/tokens  
│ ├─ seo/ # JSON-LD / metadata helpers  
│ └─ config/  
├─ supabase/  
│ ├─ migrations/  
│ ├─ seed.sql  
│ └─ tests/ # RLS / DB tests  
├─ infra/  
│ └─ gcp/ # Cloud Tasks / Run / IAM IaC  
└─ docs/  
├─ adr/  
└─ runbooks/

Use a pnpm workspace (or equivalent) so the Next.js app and Cloud Run worker share validated domain contracts without copying types. Do not share framework-specific database clients across services.

# 12\. Next.js and Supabase application design

## 12.1 Next.js route architecture

app/  
├─ \[locale\]/  
│ ├─ (public)/  
│ │ ├─ page.tsx  
│ │ ├─ books/\[slug\]/page.tsx  
│ │ ├─ authors/\[slug\]/page.tsx  
│ │ ├─ series/\[slug\]/page.tsx  
│ │ ├─ topics/\[slug\]/page.tsx  
│ │ ├─ ideas/\[slug\]/page.tsx  
│ │ └─ articles/\[slug\]/page.tsx  
│ ├─ (commerce)/cart|checkout|order/...  
│ ├─ (account)/library|orders|settings/...  
│ └─ (reader)/read/\[bookId\]/...  
├─ admin/...  
├─ api/  
│ ├─ payments/\[provider\]/webhook/route.ts  
│ ├─ reader/session/route.ts  
│ └─ internal/... # only where HTTP boundary is useful  
├─ sitemap.ts (or segmented sitemap routes)  
└─ robots.ts

## 12.2 Rendering/caching rules

| **Route class** | **Rule** |
| --- | --- |
| **Public book/author/topic/article** | Server-rendered or statically/ISR-generated where safe; explicit revalidation on publish/update. Never trigger authenticated session refresh on cached public output. |
| **Search results** | Dynamic server rendering; query parameters canonicalized/noindexed where appropriate to avoid crawl explosion. |
| **Checkout/account/library** | Dynamic, authenticated, noindex. Do not use ISR on routes where Supabase session refresh can occur. |
| **Reader** | Dynamic authorization shell + client reader engine; protected resources fetched only after entitlement/session validation. |
| **Admin** | Dynamic authenticated; role-checked server-side on every sensitive action. |

## 12.3 Supabase usage rules

- Use @supabase/ssr cookie-based sessions for Next.js. Create separate browser and server clients; create a fresh server client per request.
- Enable RLS on every Data API-exposed table. Prefer a private schema for payment event ledgers, background job internals and other service-only tables.
- Never expose service-role credentials to the browser. Service-role access is restricted to trusted server/worker environments.
- Keep source EPUB and processed paid resources in private storage buckets. Public covers/thumbnails can use public/CDN-friendly storage.
- Database migrations are code-reviewed and applied through CI; no production-only dashboard mutations without a corresponding migration.

# 13\. Data model

## 13.1 Modeling rule: Work → Edition → SKU → Offer

**Do not model a book as a generic product only**

A “book” is an intellectual work; an edition is a publication in a language/version; a SKU is a purchasable format; an offer is a market/currency price. This prevents future English/Japanese/global expansion from becoming a data migration.

Book (work)  
├─ BookLocalization (marketing/editorial copy per locale)  
├─ Edition (language / ISBN / publication metadata)  
│ ├─ SKU: paperback  
│ ├─ SKU: ebook ── EbookAsset / Publication  
│ └─ SKU: hardcover  
├─ Authors  
├─ Series  
├─ Topics / Concepts  
└─ Related content  
<br/>SKU  
└─ Offer (market + currency + price + availability)

## 13.2 Core tables

| **Table** | **Key fields** | **Purpose** |
| --- | --- | --- |
| **authors** | id, canonical_slug, display_name, bio source fields, status | Author identity; localized bio can be separate. |
| **books** | id, canonical_key, original_language, status, primary_author_id, created_at | Language-neutral work. |
| **book_localizations** | book_id, locale, slug, title, subtitle, short_description, description, audience, key_ideas | Unique(locale, slug); editorial copy. |
| **series / series_books** | series identity + ordering | Supports sequence and recommended start. |
| **topics / concepts** | canonical entity + locale labels/descriptions | Knowledge graph nodes. |
| **book_topics / book_concepts** | book_id + entity_id + relation type/weight | Explicit semantic relations. |
| **editions** | book_id, language_code, isbn, edition_number, publication_date, page_count, publisher_id | Publication metadata. |
| **skus** | edition_id, sku_code, format, fulfillment_type, active | Purchasable format; ebook/physical/bundle. |
| **offers** | sku_id, market_code, currency, price, compare_at_price, starts_at, ends_at, active | Pricing is market-specific. |
| **inventory_items** | sku_id, on_hand, reserved, reorder_point | Physical formats only. |
| **media_assets** | owner_type/id, kind, storage_key, alt_text, width/height | Covers, gallery, author images. |
| **articles / article_localizations** | status, author, locale, slug, title, body, published_at | Editorial content. |
| **article_relations** | article_id + book/topic/concept relation | Discovery graph. |

## 13.3 Commerce and identity tables

| **Table** | **Key fields** | **Purpose** |
| --- | --- | --- |
| **profiles** | auth_user_id, name, email/phone normalized, locale | Application profile linked to Supabase Auth. |
| **customer_identities** | verified email/phone hash/normalized identity → profile/customer | Allows guest purchase claim/merge. |
| **carts / cart_items** | guest/session or profile, sku_id, qty, captured offer ref | Server validates current offer at checkout. |
| **orders** | id, order_number, customer/profile, market, currency, subtotal, discount, shipping, total, status | Immutable financial snapshot after placement. |
| **order_items** | order_id, sku_id, title/format snapshot, unit_price, qty | Snapshot protects historical accuracy. |
| **payments** | order_id, provider, external_payment_id, amount, currency, status | Provider-neutral payment record. |
| **payment_events** | provider_event_id, payload_hash, received_at, processed_at, result | Idempotent webhook ledger; preferably private schema. |
| **addresses** | profile/order snapshot fields | Separate live profile address from order snapshot. |
| **fulfillments** | order_id, provider, tracking_code, status, timestamps | Physical shipment state. |
| **entitlements** | profile/customer identity, book/edition/sku, source_order_item, status, granted/revoked_at | Explicit right to read; never infer from order on each request. |
| **refunds** | payment/order item refs, amount, reason, status | Auditable refund lifecycle. |
| **outbox_events** | event_type, aggregate_id, payload, published_at | Durable side effects such as email/fulfillment tasks. |

## 13.4 Reader and publishing tables

| **Table** | **Key fields** | **Purpose** |
| --- | --- | --- |
| **ebook_assets** | edition/sku, source_storage_key, checksum, version, processing_status | Private source and version identity. |
| **ebook_publications** | ebook_asset_id, manifest_key/version, toc_json, search_index_ref, processed_at | Processed reader representation. |
| **ebook_resources** | publication_id, href, media_type, storage_key, size/hash, access_class | Optional index for protected resources. |
| **chapters** | publication_id, href, order, title, text/search metadata | Supports TOC, search and content management references. |
| **book_samples** | publication_id, allowed resource/chapter range, public token/config | Explicit sample boundary. |
| **library_items** | profile_id, book_id, entitlement_id, state, added_at | Reader-facing shelf abstraction. |
| **reading_progress** | profile_id, publication_id, locator_json, progression, updated_at, device metadata | Use reader locators rather than DOM offsets. |
| **annotations** | profile_id, publication_id, locator_json, type, color, note text, created/updated | Highlights/bookmarks/notes. |
| **processing_jobs** | type, target_id, status, attempt, payload, error_code/message, timestamps | Operator-visible async job state. |
| **audit_logs** | actor, action, entity, before/after summary, timestamp | Admin/commercial accountability. |

## 13.5 Critical constraints

- Unique active entitlement per (identity/profile, entitlement subject, source rule) where business semantics require it; duplicate webhook delivery must not create duplicates.
- Unique payment provider event ID; process inside a transaction or record event before side effects.
- Unique localized slug by (locale, entity type). Redirect old slug on rename rather than silently breaking URL.
- Amounts stored in integer minor units with ISO currency; never use floating point for money.
- Orders/order items store a commercial snapshot; do not reconstruct historical totals from current offers.
- Reader locators use a stable format supplied by the reader engine/Readium model plus contextual text when appropriate, not CSS selectors or character offsets alone.
- All publication assets are versioned; reader progress/annotations reference a publication version strategy that can be migrated on re-upload.

# 14\. Commerce and payment design

## 14.1 Checkout state machine

Cart  
→ CheckoutCreated  
→ PendingPayment  
├─ payment_failed / cancelled → PendingPayment or Cancelled  
└─ verified payment success → Paid  
├─ ebook item → EntitlementGranted  
└─ physical item → FulfillmentPending → Fulfilled  
<br/>Paid → RefundPending → Refunded / PartiallyRefunded

## 14.2 Server-side pricing

- The browser submits SKU IDs and quantities, never authoritative prices/totals.
- Checkout service loads active market offers, validates availability, computes discounts/shipping and writes an immutable order snapshot.
- Payment amount is created from the server-side order total. Provider redirect parameters are treated as transport, not truth.
- If offer changed since cart capture, checkout returns an explicit “price updated” result before payment initiation.

## 14.3 Payment adapter

interface PaymentProvider {  
createPayment(order): Promise&lt;PaymentSession&gt;  
verifyWebhook(request): VerifiedPaymentEvent  
queryPayment(externalId): Promise&lt;PaymentStatus&gt;  
refund(payment, amount, reason): Promise&lt;RefundResult&gt;  
}

Implement one Vietnam provider first, but keep this interface boundary from day one. Add MoMo/VNPay/ZaloPay/card providers only when commercial agreements require them; do not hard-code checkout domain logic to a specific webhook payload.

## 14.4 Webhook processing pattern

1.  Verify provider signature and expected merchant/account before parsing business state.
2.  Insert provider event ID into payment_events with a unique constraint. Duplicate insert = already processed.
3.  Lock payment/order rows as needed; apply only valid state transitions.
4.  On transition to Paid, grant entitlements and create outbox events in the same database transaction where practical.
5.  Return provider-required HTTP response quickly. Email, analytics and fulfillment notifications run from outbox/async tasks.
6.  Reconciliation job periodically queries pending/ambiguous payments to recover missed webhooks.

## 14.5 Guest ebook purchase

1\. Buyer enters verified-contact candidate (email/phone) + payment.  
2\. Create order linked to guest_customer_identity.  
3\. Verified webhook marks order paid.  
4\. Grant entitlement to that identity.  
5\. Success page creates short-lived, signed claim/reader path where safe.  
6\. Send magic-link/OTP access message.  
7\. On verified login, atomically attach/merge guest entitlements into profile.

**Do not create a fake password account silently**

Passwordless access can be frictionless without surprising the user. Ownership is attached to a verified identity; an authenticated profile is created/claimed only through an explicit verification flow.

# 15\. Ebook ingestion and reader architecture

## 15.1 Reader engine decision

| **Choice** | **Technology** | **Rationale** |
| --- | --- | --- |
| **Preferred** | Readium Web TypeScript toolkit | Active 2026 development; publication/navigator abstractions; CJK/RTL support; Decorator API supports annotation rendering; content-protection primitives; roadmap toward broader formats. |
| **Fallback** | epub.js | Mature and widely used; still receives commits. Use if Readium spike fails on bundle size, integration complexity, rendering fidelity or unsupported launch EPUBs. |
| **Avoid** | Custom rendering engine | High hidden cost: pagination/reflow, CFI/locators, browser quirks, selection, fonts, writing systems, search, accessibility and future formats. |

## 15.2 Spike exit criteria (W1–2)

- Render at least 5 representative Infinity Books EPUBs on desktop + mobile Chrome/Safari, including custom fonts/images/long chapters.
- Restore position after reload and after typography change using stable locators.
- Implement sample boundary and entitlement-gated publication session.
- Prototype highlight rendering via locator/decorator API.
- Validate Vietnamese typography; verify an English and Japanese/CJK fixture for global readiness.
- Measure reader bundle/initialization time and decide code-splitting strategy.
- Confirm content sanitization/CSP model and whether third-party/external resources can be fully blocked or proxied.
- Document fallback gap to epub.js before ADR is marked Accepted.

## 15.3 EPUB processing pipeline

_Figure 3. EPUB publication is an asynchronous, versioned pipeline with a human preview gate._

## 15.4 Processing steps

| **Step** | **Implementation** |
| --- | --- |
| **1\. Upload** | Admin obtains a signed upload target for a private source bucket; create ebook_asset row with checksum/version. |
| **2\. Enqueue** | Create processing_job and Cloud Task. HTTP request returns immediately with job ID. |
| **3\. Validate** | EPUB structure/media profile validation; size limits; supported feature checks. |
| **4\. Sanitize** | Remove/disable scripts, inline event handlers, unsafe URLs and unexpected external network references; enforce resource/media allowlist. |
| **5\. Extract** | Read package metadata, spine, navigation/TOC, cover, language and resources. |
| **6\. Build publication** | Generate Readium-compatible publication representation/manifest, normalized resource paths and locator/position data as required. |
| **7\. Search text** | Extract normalized text for authorized in-book search; store separately from public web content. |
| **8\. Sample** | Generate explicit sample resource set / chapter boundary and preview artifact. |
| **9\. Store** | Write versioned processed resources to private storage; never overwrite active version in place. |
| **10\. Preview** | Admin reader loads candidate version; operator accepts or rejects. |
| **11\. Publish** | Atomic pointer/switch marks version active and revalidates book-page/sample metadata. |
| **12\. Retain/rollback** | Previous publication version retained long enough for rollback and annotation migration policy. |

## 15.5 Async execution

Use Cloud Tasks for durable per-publication HTTP work and retry control. Use Cloud Run Jobs for manual/scheduled batch operations such as reprocessing an entire backlist, generating a large index or migration jobs. A job handler must be idempotent because retries are expected.

POST /internal/jobs/ebook-process  
Authorization: Google OIDC service account token  
Body: { jobId, ebookAssetId, version }  
<br/>Worker algorithm:  
\- claim job atomically if queued/retryable  
\- verify source checksum/version  
\- process into versioned temp prefix  
\- write metadata + assets  
\- commit DB status = READY_FOR_PREVIEW  
\- on failure: store stable error_code + human message + retryability

## 15.6 Protected reader delivery

- Keep raw source EPUB private and never hand its storage URL directly to the browser.
- On reader open, server checks active entitlement and creates a short-lived reader session/publication token.
- Derived chapter/image/font resources are served through authorized short-lived URLs or an entitlement-aware gateway. URLs expire and are scoped to a publication/version.
- Use strict CSP and reader sandboxing. Never trust EPUB HTML/CSS as safe because it came from an internal publisher upload.
- Copy/context-menu restrictions and watermarking are deterrence, not DRM. Document this clearly for the publisher.
- Public sample uses a distinct sample manifest/resource allowlist; do not rely on client-side hiding of paid chapters.

## 15.7 Progress and annotation model

reading_progress  
\- profile_id  
\- publication_id + version  
\- locator_json # Readium-style locator / stable engine locator  
\- total_progression  
\- updated_at  
<br/>annotations  
\- type: highlight | note | bookmark  
\- locator_json  
\- highlighted_text_hash / short context (optional, privacy-aware)  
\- note_text (private)  
\- color / metadata

Do not anchor annotations to DOM element IDs generated at render time. Store engine-supported locators and enough context to migrate/recover anchors if a publication is reprocessed.

# 16\. Search, SEO and internationalization implementation

## 16.1 Search architecture

| **Phase** | **Technology direction** | **Notes** |
| --- | --- | --- |
| **V1** | Postgres full-text / trigram where appropriate | Search books/authors/topics/articles; editorial weights prioritize exact title/author, then topics/descriptions. |
| **P1** | Dedicated search index only if needed | If relevance/scale/features outgrow Postgres, add Meilisearch/Typesense/Algolia behind SearchProvider interface. |
| **P2** | Semantic retrieval | Embeddings and reranking for ideas/books; never remove lexical exact-match or editorial boost controls. |

## 16.2 SEO implementation

- Use Next.js generateMetadata/static metadata plus file-based sitemap/robots/OG image mechanisms.
- Generate canonical URL from canonical entity + locale, not from incoming request parameters.
- Build typed JSON-LD helpers in packages/seo and test their output against expected schema shape. Visible content and structured data must agree.
- Use Book semantic data with applicable Product/Offer commerce data; include Person/Organization/Breadcrumb and Article where relevant.
- Create sitemap entries from published entities only and invalidate/rebuild on publish/unpublish/slug change.
- Maintain redirects table and middleware/edge lookup for legacy/current slug redirects; permanent redirects should not chain.
- Use noindex on private/system/query explosion surfaces; robot directives are not a substitute for authorization.
- Optional llms.txt may list canonical high-value entities for services that consume it, but Google explicitly ignores it for ranking/visibility.

## 16.3 Internationalization data rules

| **Concern** | **Rule** |
| --- | --- |
| **UI locale** | Controls navigation/UI strings; represented in URL path. |
| **Book language** | Edition/publication language; not inferred from UI locale. |
| **Market** | Controls available offers/payment/fulfillment; can differ from locale. |
| **Currency** | Offer attribute; not inferred solely from language. |
| **Slug** | Localized and stable per locale; old slug becomes redirect. |
| **Translation status** | Draft/review/published independently per entity locale. |
| **Fallback** | Explicit configured fallback for UI; public SEO pages should not silently duplicate another locale under a different canonical URL. |
| **Japanese/CJK** | Reader/font/line-breaking QA included before Japanese launch; Readium Web now supports CJK but Infinity-specific EPUBs still need testing. |

# 17\. Security, privacy, observability and quality

## 17.1 Threat model and controls

| **Threat** | **Control** |
| --- | --- |
| **Unauthorized book access** | Entitlement check before reader session; private storage; short-lived scoped access; no raw EPUB public URL. |
| **Malicious EPUB content** | Validation + sanitization; strip scripts/event handlers/external requests; CSP; iframe/sandbox policy; media type allowlist. |
| **Price tampering** | Server computes offer/totals; payment amount originates from server order snapshot. |
| **Webhook spoof/replay** | Signature verification, merchant validation, unique provider event ID, idempotent state transitions. |
| **IDOR / user-data leak** | RLS + server authorization; never trust profile/order IDs from client without ownership check. |
| **Service-role leakage** | Service role only in server/Cloud Run secret store/environment; never NEXT_PUBLIC. |
| **Admin compromise** | Role-based permissions, strong auth; admin MFA recommended before broad operator access; immutable audit log. |
| **XSS in editorial content** | Sanitize rich text/HTML; use controlled component renderer rather than arbitrary scriptable HTML. |
| **Bot abuse** | Rate-limit auth, checkout creation, search and reader session endpoints; provider/bot controls where necessary. |
| **Personal reading privacy** | Notes/highlights private by default; analytics excludes note text/full passages; deletion/export policy documented. |

## 17.2 RLS policy strategy

- Public published catalog can be readable by anon through tightly scoped tables/views.
- Profiles, addresses, library, progress and annotations: authenticated user can read/write only rows tied to auth.uid() through profile mapping.
- Orders: customer can read owned orders; write/financial transitions happen through trusted server functions, not direct arbitrary client updates.
- Entitlements: user can read own active entitlements; grant/revoke only service role/trusted function.
- Admin permissions checked in both application layer and database/service boundary for sensitive mutations.
- Automated SQL tests assert negative cases (user A cannot read user B) as part of CI.

## 17.3 Observability

| **Signal** | **Implementation** |
| --- | --- |
| **Request tracing** | Generate correlation/request ID at web boundary and propagate into payment/outbox/task/Cloud Run logs. |
| **Product analytics** | Anonymous/user-consented product events with book/offer IDs; privacy-aware reader events. |
| **Error monitoring** | Capture Next.js and Cloud Run exceptions with release/version context. |
| **Business monitors** | Payment webhook failure rate; paid-without-entitlement; entitlement-without-paid-source; refund failures; stuck jobs. |
| **Publishing monitors** | EPUB processing duration/success, error codes, retries, queue latency. |
| **Web performance** | Web Vitals by route template/device/market; alert on regressions. |
| **Audit** | Admin changes to price, publication, refund, role and entitlement are traceable. |

## 17.4 Test strategy

| **Layer** | **Coverage** |
| --- | --- |
| **Unit** | Domain state machines, pricing, entitlement rules, localization helpers, reader locator conversions. |
| **Database** | Migration tests, constraints, RLS positive/negative policy tests against local Supabase. |
| **Integration** | Payment adapters with signed fixture webhooks; Cloud Run job handler; storage access; order→entitlement transaction. |
| **E2E** | Playwright: discovery→checkout; guest ebook→read; login→library→resume; admin upload→preview; refund/access behavior. |
| **Reader fixtures** | Golden EPUB corpus across typography, long chapters, images, links, fonts, malformed content and CJK fixture. |
| **Accessibility** | Automated axe checks plus keyboard/screen-reader manual pass on book, checkout, library and reader. |
| **Performance** | Lighthouse/CI budgets plus field Web Vitals after launch; load test checkout/webhooks/reader session endpoints. |
| **SEO** | Snapshot metadata/JSON-LD; crawl staging with noindex override; validate canonical/hreflang/sitemap/redirect behavior. |

## 17.5 Deployment and environments

local  
\- Next.js + Supabase local stack + worker fixtures  
preview (per PR)  
\- Vercel preview; isolated/safe test data where feasible  
staging  
\- persistent Supabase staging + payment sandbox + Cloud Run staging  
production  
\- separate credentials, queues, storage buckets and payment merchant config

- CI gates: lint/typecheck/unit → DB/RLS tests → build → integration/E2E subset → deploy preview.
- Production database migrations are forward-safe; destructive cleanup is separated from application rollout.
- Feature flags protect incomplete reader/payment provider paths.
- Secrets managed in Vercel/GCP/Supabase secret systems; never committed.
- Worker deploy and web deploy can be independent but shared domain contracts are versioned/compatible.

## 17.6 Backup and recovery

- Enable the strongest practical Supabase backup/PITR option for the selected plan before launch; document actual RPO/RTO rather than assuming defaults.
- Retain immutable/versioned source EPUB object keys and processed publication versions; never overwrite the only recoverable source.
- Payment provider remains an external reconciliation source; retain provider IDs and event ledger.
- Document “rebuild derived assets from source EPUB” as a recovery path.
- Practice rollback of Next.js deployment and publication version before launch.

# 18\. Migration and launch plan

## 18.1 Migration from current storefront

| **Phase** | **Actions** |
| --- | --- |
| **Inventory** | Export current products/books, URLs/slugs, authors/content, media, inventory, redirects, orders/customers required for history, SEO landing pages and analytics baseline. |
| **Normalize** | Map legacy product records into Work → Edition → SKU → Offer. Clean ISBN/language/author/topic metadata. |
| **Content migration** | Import book/editorial content and media; create localized slugs and canonical relation graph. |
| **EPUB migration** | Collect source EPUBs, process through the same production pipeline, perform reader QA and sample selection. |
| **Redirect map** | Map every valuable legacy URL to the closest canonical new URL; avoid mass redirect to homepage. |
| **Commerce cutover** | Freeze or synchronize stock/orders during final window; configure payment/fulfillment production credentials. |
| **DNS launch** | Deploy, validate, switch domain, enable redirects, submit sitemap/Search Console inspection, monitor 404/5xx/payment. |
| **Post-launch** | Daily triage first week: SEO crawl errors, payment/entitlement exceptions, reader issues and performance regressions. |

## 18.2 Rollback strategy

- Web rollback: Vercel previous production deployment.
- Publication rollback: switch active ebook_publication version pointer back to prior validated version.
- Payment: do not “rollback” financial events; reconcile/compensate using state machine and provider APIs.
- Database: prefer forward-fix migrations; use backup/PITR only for actual data-loss/corruption scenarios.
- DNS/legacy storefront rollback plan must account for orders accepted during the new-site window to avoid split-brain inventory/payment state.

# 19\. Architecture decisions (ADR summary)

| **ADR** | **Decision** | **Summary** | **Status** |
| --- | --- | --- | --- |
| **ADR-001** | Book domain model | Use Work → Edition → SKU → Offer instead of Product-only schema. | Accepted |
| **ADR-002** | Web framework | Next.js App Router on Vercel; Server Components by default. | Accepted |
| **ADR-003** | Primary backend | Supabase Postgres/Auth/Storage with RLS; business state in Postgres. | Accepted |
| **ADR-004** | Async work | Cloud Tasks → private Cloud Run service; Cloud Run Jobs for batch/reprocessing. | Accepted |
| **ADR-005** | Reader engine | Readium Web preferred; time-boxed spike with epub.js fallback. | Proposed → Accept after spike |
| **ADR-006** | Ebook protection | Private versioned resources + short-lived authorized delivery; no absolute DRM claim. | Accepted for V1 |
| **ADR-007** | Commerce | Payment provider adapter + webhook source-of-truth + explicit entitlement model. | Accepted |
| **ADR-008** | Internationalization | Locale, book language, market and currency modeled separately. | Accepted |
| **ADR-009** | SEO/LLMO | Canonical HTML/entity architecture is primary; llms.txt optional/non-Google only. | Accepted |
| **ADR-010** | Search | Postgres-first; dedicated/semantic engines behind provider boundary only when needed. | Accepted |

# 20\. Technical reference notes

The implementation guidance above was checked against current official documentation available in September 2026. These references are not requirements by themselves; they support the architecture decisions and should be rechecked when implementation begins.

| **Reference** | **URL** | **Used for** |
| --- | --- | --- |
| **Supabase — Next.js quickstart / SSR auth** | https://supabase.com/docs/guides/auth/quickstarts/nextjs | Cookie-based Auth with Next.js App Router; @supabase/ssr pattern. |
| **Supabase — Server-Side Rendering** | https://supabase.com/docs/guides/auth/server-side | SSR sessions use cookies; PKCE-aware server setup. |
| **Supabase — Advanced SSR guide** | https://supabase.com/docs/guides/auth/server-side/advanced-guide | Warning against ISR on routes that refresh authenticated sessions. |
| **Supabase — Row Level Security** | https://supabase.com/docs/guides/database/postgres/row-level-security | RLS authorization and exposed-schema hardening. |
| **Vercel — Functions up to 30 minutes** | https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes | Confirms longer request execution is possible; this design still prefers durable async queues for publishing jobs. |
| **Google Cloud — asynchronous Cloud Tasks with Cloud Run** | https://docs.cloud.google.com/run/docs/triggering/using-tasks | Durable asynchronous HTTP task pattern and authenticated private Cloud Run targets. |
| **Google Cloud — Cloud Run jobs** | https://docs.cloud.google.com/run/docs/create-jobs | Run-to-completion and parallel batch processing. |
| **Readium Web** | https://github.com/readium/web | Web reader toolkit architecture and Thorium/CLI ecosystem. |
| **Readium Web July 2026 release** | https://blog.readium.org/release-note-readium-typescript-toolkit-july-2026/ | Decorator API and current TypeScript toolkit capabilities. |
| **Readium Web 2026 updates** | https://blog.readium.org/tag/web/ | CJK/RTL, audiobooks and content-protection updates. |
| **Google — Generative AI optimization guide** | https://developers.google.com/search/docs/fundamentals/ai-optimization-guide | SEO fundamentals remain relevant; no Google benefit from llms.txt; focus on useful, crawlable, technically clear content. |
| **Google — Merchant listing structured data** | https://developers.google.com/search/docs/appearance/structured-data/merchant-listing | Product/Offer structured data for commerce surfaces. |
| **Schema.org — Book** | https://schema.org/Book | Book entity properties including offers and bibliographic attributes. |
| **Next.js — Metadata** | https://nextjs.org/learn/dashboard-app/adding-metadata | Metadata API, Open Graph, robots and sitemap mechanisms. |
| **web.dev — Core Web Vitals** | https://web.dev/articles/vitals | Current LCP/INP/CLS “good” thresholds used as performance targets. |

## 20.1 Final implementation priorities

**If the team must cut scope**

Protect these five capabilities in this order: 1) canonical Book Detail and catalog, 2) correct checkout/payment, 3) explicit ebook entitlement, 4) high-quality reader + library, 5) SEO/entity architecture. Defer AI, community, sophisticated recommendations and admin polish before compromising the purchase-and-read loop.

_This specification should be converted into epics/stories after Claude Design produces the final page/component system. At that point, re-estimate each roadmap phase using the selected payment provider, real EPUB corpus and migration inventory._
