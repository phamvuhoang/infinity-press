# S20 — Web update cho Growth & Monetization plan (Reading Pass, Host Kit, provenance, đo lường)

Ngày: 2026-10-22. Trạng thái: đề xuất để review; chưa triển khai.

Nguồn: `docs/growth/InfinityBooks-Press-Global-Growth-Plan-VI-EN-JA.html` (Strategy dossier v2.0, 22/10/2026).
Spec này chỉ trích phần **website phải thay đổi** để chạy kế hoạch 90 ngày. Giá, ngưỡng và KPI trong plan là giả thuyết; web chỉ cần đo được chúng, không khóa cứng.

## 1. Plan yêu cầu gì ở web

| Plan nói | Web phải có |
| --- | --- |
| Open Library giữ $0: EPUB + đọc online cơ bản, thông tin nguồn/phiên bản/báo lỗi, đoạn mẫu song ngữ, 3/21 buổi mẫu, đọc ngay không ép tạo tài khoản | Edition record công khai; đọc bản miễn phí không cần đăng nhập; preview journey |
| Personal Reading Pass $12: 21 buổi đã tuyển chọn, companion song ngữ theo đoạn, chú giải + câu hỏi đã review, workbook tải về, tự đánh dấu tiến độ, giữ file sau 21 ngày | Sản phẩm mới "journey" + session + progress + file giao |
| Host Kit $39: 4 kịch bản, xem trước 1/4, câu hỏi có vị trí tham chiếu, worksheet, mẫu lời mời | Sản phẩm số thứ hai, phần lớn là file + 1 session preview |
| Thu tiền quốc tế qua Merchant of Record (Lemon Squeezy), giá gồm thuế, refund kiểm tra được | PaymentProvider mới cho USD; refund thu hồi quyền |
| Attribution theo host, hoa hồng 25% thu ròng đơn đầu, cửa sổ 30 ngày, không tự giới thiệu | Mã host, cookie 30 ngày, ghi trên order, báo cáo admin; không trả tiền tự động |
| Đo: qualified_visit, reading_activated, offer_viewed → purchase_verified, meaningful D7/D30, hoàn thành ≥17/21, mua lại, lãi góp | Thêm event + view SQL + trang `/admin/growth` |
| "Một link mở đúng đoạn, đúng ngôn ngữ", thẻ chia sẻ có nhãn trích/dịch/diễn giải | Passage anchor ổn định; mở rộng `/q/[code]` |
| Hồ sơ review công khai, changelog, báo lỗi tại đúng đoạn | `edition_changelog`; nhãn loại văn bản + phạm vi review |
| Homepage/landing mới theo định vị "One classic. Many languages. A shared conversation."; rà locale, demo sót, canonical | Copy + landing per locale, trang host, trang sponsor |

**Giữ ở backlog theo plan:** AI Q&A/AI Twin, voice cá nhân hoá, marketplace creator chia tiền tự động, app native, LMS/classroom, đa tenant, API corpus, membership $6, KDP. Không xây trong S20.

## 2. Hiện trạng codebase (commit `6571fb5`)

| Đã có | Ở đâu | Dùng lại thế nào |
| --- | --- | --- |
| Work → nhiều edition theo ngôn ngữ; SKU/offer theo edition, market/currency, có `USD`/`JPY`/`VND` | `editions`, `skus`, `offers`, `edition_pricing_defaults`, migration `20261020150000_press_edition_orders.sql` | Reading Pass và Host Kit là SKU kind mới, không tạo hệ sản phẩm riêng |
| Entitlement theo edition; grant qua free offer, admin, manual VND, simulator | `lib/access/grant.ts`, `lib/commerce/*`, `revoke_order_entitlement` | Thêm scope journey/kit vào entitlement; refund dùng lại revoke |
| `PaymentProvider` interface với `manual` và `simulator` | `lib/commerce/payment-provider.ts`, `lib/commerce/types.ts` | Thêm provider MoR theo đúng interface |
| Edition đã có `text_source_note`, `translation_source`, `rights_note`, `territory_note`, `review_note`, `reviewed_at`, `contributors`, `editorial_state` | `editions` | Edition record gần đủ; thiếu loại văn bản, phạm vi review, changelog, hiển thị công khai |
| Báo lỗi tại vị trí đọc (`locator`) | `edition_feedback`, `/library/report/[editionId]` | Đúng yêu cầu "báo lỗi tại đúng đoạn", chỉ cần link từ reader và từ trang edition |
| Sample công khai không cần đăng nhập, giới hạn theo `allowed_hrefs` | `book_samples`, `/read-sample/[slug]`, `/api/samples/*` | Bản miễn phí: cho phép toàn bộ href → đọc ngay không tài khoản |
| Annotation, highlight, tìm kiếm trong sách, vị trí tìm kiếm có locator | `reader_annotations`, `ebook_search_chunks`, `lib/reader/readium-anchors.ts` | Nền cho passage anchor |
| Shared quote `/q/[code]` có OG image, publication_id | `shared_quotes`, `app/[lang]/(public)/q/[code]` | Mở rộng thành "passage + question" |
| Analytics events với CHECK tên event; `view_book`, `open_sample`, `begin_checkout`, `purchase`, `open_reader`, `progress_*` | `analytics_events`, `lib/analytics/events.ts` | Thêm event mới qua migration; metrics dẫn xuất bằng view |
| Reviews, câu hỏi độc giả, ideas/articles | S12/S13/S15 | Hồ sơ review có thể viết dưới dạng article gắn edition thay vì CMS mới |
| Coupons, bundles, gifts, wishlist | S8/S9/S17 | Pass có thể tặng/giảm giá bằng cơ chế sẵn có; không làm lại |
| Locale `vi`/`en`/`ja` | `lib/i18n/config.ts` | Plan đề xuất EN–ES ở ngày 46–90; `es` là locale thứ tư, chi phí như đã nêu ở spec Press (SQL + validation + UI), chưa làm trong S20 |

Chưa có: sản phẩm dạng journey/session, file giao kèm quyền, provider USD, host attribution, passage anchor/alignment, nhãn loại văn bản, changelog edition, event activation/D7/D30, trang `/admin/growth`.

## 3. Quyết định thiết kế

1. **Một journey là một sản phẩm gắn với một work và một cặp edition** (source + companion). Không đổi mô hình book/edition. Pass không cấp quyền edition trả phí; edition trong pilot là miễn phí theo plan.
2. **Host Kit là file + 1 session preview**, không có dashboard lớp học. Không bán kèm 25 pass.
3. **Quyền tách khỏi thời gian**: entitlement pass không hết hạn; "21 ngày" chỉ là cấu trúc session. File đã tải thuộc về khách.
4. **Đọc miễn phí không cần tài khoản** bằng cách mở rộng `book_samples` thay vì thêm anonymous reader session. Progress chỉ lưu khi đăng nhập.
5. **Passage anchor được sinh lúc xử lý EPUB**, lưu theo publication, ổn định qua phiên bản bằng hash nội dung; alignment giữa hai edition là dữ liệu admin nhập/import, không tự động.
6. **MoR là provider thứ ba**, bật bằng env, không thay manual VND. Production từ chối `simulator` như cũ.
7. **Attribution ghi ở server khi tạo order**, không đếm click. Hoa hồng chỉ xuất báo cáo; trả tay ngoài hệ thống.
8. **Metrics là view SQL trên bảng có sẵn + event mới**, không thêm pipeline. Mẫu nhỏ, không cần realtime.

## 4. Mô hình dữ liệu (migration mới)

```
reading_journeys        id, book_id, source_edition_id, companion_edition_id null,
                        slug, status(draft|published|archived), session_count, created_at
journey_localizations   journey_id, locale, title, summary, outcome_statement
journey_sessions        id, journey_id, position(1..n), is_preview bool,
                        start_locator json, end_locator json,
                        source_anchor_from, source_anchor_to
journey_session_localizations  session_id, locale, title, guide_md, questions json
journey_files           id, journey_id, kind(workbook|companion|kit_script|kit_worksheet|kit_invite),
                        storage_path(private bucket), version, locale, size_bytes
journey_progress        profile_id, journey_id, session_position, completed_at  (PK 3 cột)
journey_completions     profile_id, journey_id, reflection, check_answers json, completed_at

skus.product_kind       enum: ebook | reading_pass | host_kit   (default ebook)
skus.journey_id         null trừ pass/kit
entitlements.scope      enum: edition | journey  (default edition); entitlements.journey_id null
                        unique (profile_id, journey_id) where scope='journey'
                        kit = entitlement journey với sku.product_kind='host_kit' trên order_items

passage_anchors         id, publication_id, ordinal, href, css_selector/locator json,
                        text_hash, excerpt(first 160 chars)
passage_alignments      journey_id, source_anchor_id, target_anchor_id, note null

editions.text_kind      enum: literal | adapted | commentary   (nullable, hiện ở UI khi có)
editions.review_scope   enum: full | sample | none
edition_changelog       id, edition_id, version, released_at, reviewer_label, summary_md,
                        examples json [{before, after, error_type}]

hosts                   id, profile_id, code unique, mode(affiliate|kit), status, commission_pct,
                        attribution_days(30), created_at
orders.host_id          null; orders.attributed_at; orders.attribution_source(cookie|link)
shared_quotes.anchor_id, shared_quotes.question, shared_quotes.text_kind(verbatim|translation|paraphrase),
shared_quotes.host_id
analytics_events check  + offer_viewed, purchase_verified, reading_activated,
                        session_completed, journey_completed, passage_opened, passage_shared,
                        file_downloaded, host_link_landed
```

View đo lường (security definer, admin only): `growth_funnel_daily`, `growth_cohort_retention` (D7/D30 theo ngày activation), `growth_journey_completion`, `growth_repurchase_60d`, `host_attribution_report` (thu ròng = checkout − refund − thuế − phí, lấy từ payment payload MoR).

RPC authenticated: `mark_journey_session(journey_id, position)`, `complete_journey(journey_id, reflection, answers)`, `journey_file_url(file_id)` (kiểm tra entitlement rồi trả signed URL ngắn hạn). Reader session, progress, annotation giữ nguyên RPC cũ.

Cập nhật `lib/supabase/database.types.ts`; thêm pgTAP cho entitlement scope, RLS journey_progress, host attribution không tự giới thiệu, refund thu hồi pass.

## 5. Luồng người dùng

### 5.1 Public
- `/{locale}` homepage: hero mới, một work pilot nổi bật, đoạn mẫu song ngữ, ba lối "Original / Your language / Together", CTA đọc miễn phí + xem journey. Bỏ copy cũ còn sót; kiểm tra canonical/hreflang 3 locale.
- `/{locale}/books/[slug]`: thêm block **Edition record** (nguồn, dịch giả, năm, loại văn bản, phạm vi review, thị trường đã kiểm tra, phiên bản + link changelog, link báo lỗi). Thêm card journey nếu có pass published.
- `/{locale}/journeys/[slug]` (mới): đầu ra, 21 buổi (3 preview mở được), nội dung pass, quyền giữ file, hỗ trợ/refund, giá USD gồm thuế, CTA mua. Event `offer_viewed` khi giá + nội dung gói đã vào viewport.
- `/{locale}/journeys/[slug]/sessions/[n]` preview: công khai cho `is_preview`; còn lại yêu cầu entitlement.
- `/{locale}/read-sample/[slug]`: bản miễn phí có `allowed_hrefs = *` → đọc trọn không đăng nhập; banner "đăng nhập để lưu tiến độ".
- `/{locale}/q/[code]`: hiển thị passage theo ngôn ngữ người nhận chọn (nếu có alignment), nhãn verbatim/translation/paraphrase, câu hỏi của người chia sẻ, nút "đọc tiếp 3 đoạn" (mở sample đúng anchor), sau đó CTA lưu/tham gia journey. Event `passage_opened`.
- `/{locale}/hosts` (mới, tĩnh): lời mời host, hai lựa chọn affiliate/kit, form liên hệ (gửi vào `reader_questions` với `kind=host_inquiry` hoặc email outbox), công khai quan hệ affiliate.
- `/{locale}/sponsors` (mới, tĩnh): phạm vi, cách báo giá, form liên hệ. Không checkout.
- `/{locale}/editions/[editionId]/changelog` hoặc section trên trang sách: trước/sau, loại lỗi, phiên bản.
- Link host `?h=CODE` trên mọi trang public: middleware/route handler đặt cookie `ib_host` 30 ngày, event `host_link_landed`; không áp cho profile là chính host đó.

### 5.2 Customer
- Checkout pass/kit: USD qua MoR (redirect checkout của Lemon Squeezy, webhook xác nhận → `purchase_verified` server-side → grant entitlement scope journey). Manual VND vẫn dùng cho edition VND nếu admin cấu hình offer. Coupons/gifts hoạt động với SKU kind mới qua order_items như cũ.
- `/library`: thêm tab/khu "Hành trình đọc": tiến độ x/21, buổi kế tiếp, nút tải workbook/companion; kit hiện 4 file + session preview.
- `/library/journeys/[slug]/sessions/[n]`: hướng dẫn buổi, câu hỏi, nút "Mở reader tại đoạn này" (deep link `?anchor=`), nút đánh dấu xong. Buổi cuối: reflection + câu kiểm tra hiểu → `journey_completed`.
- Reader: tham số `anchor` cuộn đến passage; nút "Đối chiếu" mở panel companion hiển thị passage đã align từ edition kia (không đồng bộ cuộn liên tục); nút "Chia sẻ đoạn này kèm câu hỏi" tạo shared quote mới; link "Báo lỗi tại đây" vào `edition_feedback` với locator.
- Refund (webhook MoR) → `revoke_order_entitlement`, email thông báo qua outbox hiện có.

### 5.3 Admin
- `/admin/journeys`: CRUD journey, session (locator chọn từ TOC/anchor picker), localizations, upload file vào bucket private, publish readiness (đủ session, ≥3 preview, có workbook, có offer).
- `/admin/books/[bookId]/editions/[editionId]`: thêm `text_kind`, `review_scope`, changelog entries, import alignment CSV/JSON (anchor source ↔ anchor target).
- `/admin/hosts`: tạo host code, mode, trạng thái; xem `host_attribution_report`; export CSV.
- `/admin/growth`: funnel theo work/ngôn ngữ/host, activation, D7/D30, completion, repurchase, refund. Số nhỏ hiển thị kèm mẫu số.
- `/admin/payments`: thêm cột provider, payload MoR, refund state.

## 6. Thanh toán MoR

- `LemonSqueezyProvider implements PaymentProvider`: `createCheckout(order)` → URL hosted checkout với `custom[order_id]`; webhook `/api/payments/lemonsqueezy/webhook` xác minh HMAC, idempotent theo event id, map `order_created/paid` → paid, `order_refunded` → refunded. Lưu raw payload vào `payment_events`.
- Env: `PAYMENT_PROVIDER=lemonsqueezy`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, map variant id trong `offers.external_ref` (cột mới).
- Hiển thị giá: USD, ghi "đã gồm thuế nơi áp dụng" theo MoR; không tự tính thuế.
- Điều kiện ngoài code: store/product được duyệt trước khi bật production. Runbook `docs/runbooks/merchant-of-record.md`.

## 7. Đo lường

| Chỉ số plan | Nguồn web |
| --- | --- |
| qualified_visit | `view_book`/`passage_opened`/`host_link_landed` có `properties.campaign`, `work`, `language`, `host`; loại bot bằng UA + admin role |
| reading_activated | view: trong 24h đầu có `open_reader`/`open_sample` tổng active ≥3 phút (từ reading_progress heartbeats hiện có) **và** ≥1 annotation hoặc `session_completed`; ghi lại thành event để cohort cố định |
| offer_viewed → purchase_verified | event client + event server khi webhook paid; loại refund/hủy |
| Meaningful D7/D30 | view theo cohort ngày activation, cửa sổ 6–8 / 28–32 |
| Hoàn thành hành trình | `journey_completions` + ≥17 `journey_progress` |
| Mua lại pass/kit | order paid thứ hai cùng profile, work khác, trong 60 ngày, không phải gift/100% coupon |
| Lãi góp & CAC | report xuất CSV từ `host_attribution_report` + payload phí MoR; CAC nhập tay ngoài web |

## 8. Phân pha theo lịch 90 ngày

**Pha A — Ngày 01–14 (bán được):**
1. Migration: journey/session/files/progress, SKU kind, entitlement scope, editions.text_kind/review_scope, changelog, hosts, orders.host_id, event mới, views.
2. Admin journeys + edition record fields + upload file.
3. Public: edition record block, journey page + preview, sample không đăng nhập cho bản miễn phí, homepage/landing mới, trang hosts/sponsors.
4. Checkout MoR + webhook + refund → revoke; `purchase_verified`.
5. Host link + cookie + attribution trên order + báo cáo cơ bản.
6. Library journeys + session page + mark done + tải file.
7. `/admin/growth` phiên bản tối thiểu (funnel, activation, purchase).

**Pha B — Ngày 15–45 (chạy cohort):**
8. Passage anchors lúc xử lý EPUB + migration backfill cho publication đang có; deep link `?anchor=`.
9. Alignment import + panel đối chiếu trong reader + share passage kèm câu hỏi + `/q/[code]` mới.
10. Host Kit SKU + 4 file + preview session + trang kit.
11. Changelog công khai + link báo lỗi từ reader.
12. D7/D30, completion, repurchase trong `/admin/growth`.

**Pha C — Ngày 46–90 (theo tín hiệu):**
13. Email "cuốn kế tiếp" cho người đã mua (outbox hiện có).
14. Thử nghiệm 3 (style selector vs song ngữ): flag theo nhánh, chỉ khi đủ traffic; nếu không, bỏ.
15. Partner shelf demo bằng bundle + trang topic gắn tên đối tác, thủ công.
16. Locale `es`: quyết định riêng sau khi có reviewer và host; không nằm trong S20.

## 9. Ngoài phạm vi / rủi ro

- Alignment tự động, dịch tự động, AI chat, audio TTS theo pass, membership, multi-tenant, API: backlog.
- Rủi ro lớn nhất là passage anchor ổn định qua phiên bản EPUB; dùng hash đoạn + ordinal, chấp nhận re-align thủ công khi edition đổi lớn.
- MoR có thể không duyệt store kịp ngày 14: fallback là manual VND cho cohort EN–VI đầu, giữ USD làm giá hiển thị tham chiếu.
- Chỉ bán khi journey đã publish readiness; không mở preorder trong code.

## 10. Kiểm thử

- Unit: SKU kind/entitlement scope, attribution (self-referral, hết hạn 30 ngày), webhook MoR idempotent, anchor hash.
- pgTAP: RLS journey_progress/files, revoke pass khi refund, views chỉ admin.
- Playwright: mua pass qua simulator → library journey → mark 21 → completion; đọc bản miễn phí không đăng nhập; mở `/q/[code]` chọn ngôn ngữ → đọc tiếp; link host → order có host_id.
- `npm run check:full` vì đổi authorization và customer path.
