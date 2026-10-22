# S20-min — Thử nghiệm trải nghiệm đọc (bản tối thiểu)

Ngày: 2026-10-22. Trạng thái: đề xuất để review; chưa triển khai.
Thay thế bản đầy đủ `2026-10-22-s20-growth-reading-pass-design.md` cho giai đoạn thử nghiệm.

## 1. Phạm vi

Giai đoạn này chỉ thử xem người đọc có **đọc hết, hiểu và quay lại** với một tác phẩm ngắn song ngữ hay không. Không thành lập công ty, không đăng ký cổng thanh toán, không thuê host.

Bỏ khỏi phạm vi: Merchant of Record / USD, host attribution và hoa hồng, Host Kit, trang sponsor, báo cáo lãi góp, locale `es`, A/B style selector.

Giữ nguyên hạ tầng đang có: free offer, chuyển khoản VND thủ công (nếu muốn thử thu tiền nhỏ), coupon, gift, reader, annotation, báo lỗi, shared quote, analytics events.

Nguyên tắc: mỗi tính năng dưới đây phải trả lời một câu hỏi của plan bằng hành vi người dùng thật, với ít code nhất.

## 2. Tính năng

### 2.1 Hành trình đọc 21 buổi (mới, lõi)

Câu hỏi: người ta có đọc hết một tác phẩm ngắn khi có lộ trình rõ không?

- Một journey gắn với một work; mỗi buổi trỏ tới một khoảng đọc trong **một** edition (bản dịch tiếng Việt hoặc bản gốc), có hướng dẫn ngắn và 1–3 câu hỏi.
- Trang `/{locale}/journeys/[slug]`: mục tiêu, danh sách 21 buổi, nút "Bắt đầu". Toàn bộ buổi mở cho người đăng nhập; không bán.
- Trang buổi: hướng dẫn, nút "Mở reader tại đoạn này", nút "Xong buổi này". Buổi cuối có ô suy ngẫm tự do.
- Thư viện: khu "Hành trình đọc" hiện x/21 và buổi kế tiếp.
- Workbook/companion: **không** làm file giao riêng. Hướng dẫn và câu hỏi nằm ngay trên trang buổi.

Dữ liệu:
```
reading_journeys          id, book_id, edition_id, slug, status, session_count
journey_localizations     journey_id, locale, title, summary
journey_sessions          id, journey_id, position, start_locator json, end_locator json
journey_session_localizations  session_id, locale, title, guide_md, questions json
journey_progress          profile_id, journey_id, position, completed_at   (PK 3 cột, RLS theo profile)
journey_completions       profile_id, journey_id, reflection, completed_at
```
RPC authenticated: `mark_journey_session`, `complete_journey`. Không có SKU, entitlement hay file mới.

Admin: `/admin/journeys` CRUD journey và session; chọn locator từ TOC của publication đang active (dùng `lib/reader/toc.ts`). Publish readiness: đủ session và có title theo locale mặc định.

### 2.2 Đối chiếu song ngữ theo đoạn (mới, tự động hoàn toàn)

Câu hỏi: đối chiếu có giúp hiểu và đọc tiếp không?

Điều kiện giữ tính năng này: **không có bước thủ công nào**. Nếu hai bản không tự ghép được, nút đối chiếu tự ẩn; không có admin import.

- Anchor: dùng ngay `ebook_search_chunks` mà worker EPUB đã sinh cho mọi publication (`href`, `ordinal`, `locator_json`, `plain_text`). Không tạo bảng anchor mới, không backfill mới; lệnh backfill search hiện có đã bao phủ publication cũ.
- Ghép hai edition của cùng work: resource ghép theo vị trí trong spine; trong resource, chunk ghép theo `ordinal` khi số chunk hai bên bằng nhau. Lệch nhỏ (≤10%) thì ghép theo tỉ lệ độ dài tích luỹ (kiểu Gale–Church đơn giản); lệch lớn thì resource đó không có đối chiếu.
- Tính một lần khi cả hai publication đã ready, lưu `passage_alignments (book_id, source_publication_id, target_publication_id, source_chunk_id, target_chunk_id, confidence)` bằng một job trong worker hiện có. Không có UI quản trị; admin chỉ thấy tỉ lệ đoạn ghép được trên trang edition.
- Reader: `?anchor=<chunk ordinal>` cuộn tới đoạn bằng `locator_json`. Nút "Đối chiếu" chỉ hiện khi đoạn hiện tại có alignment; panel hiện `plain_text` của đoạn tương ứng và link mở bản kia tại đó. Không đồng bộ cuộn liên tục.
- Người dùng phải có quyền với cả hai edition; edition pilot miễn phí nên gần như luôn có.

Nếu bản dịch AI của dự án không giữ cấu trúc đoạn và tỉ lệ ghép dưới 70% ở tác phẩm pilot, bỏ 2.2 và giữ phần còn lại nguyên vẹn.

### 2.3 Đọc bản miễn phí không cần tài khoản (cập nhật)

Câu hỏi: bớt rào cản đăng nhập có tăng người bắt đầu đọc không?

- `book_samples.allowed_hrefs` nhận giá trị `["*"]` cho edition miễn phí; `/read-sample/[slug]` phục vụ toàn bộ sách.
- Banner trong reader mẫu: "Đăng nhập để lưu tiến độ và ghi chú."
- Không có anonymous session, không lưu progress ẩn danh.

### 2.4 Chia sẻ một đoạn kèm câu hỏi (cập nhật `/q/[code]`)

Câu hỏi: link tới đúng đoạn có khiến người nhận đọc tiếp không?

- `shared_quotes` thêm `chunk_id` (tham chiếu `ebook_search_chunks`), `question` (tối đa 280 ký tự), `text_kind` (`verbatim|translation|paraphrase`).
- Trong reader: chọn đoạn → "Chia sẻ đoạn này" → nhập câu hỏi tuỳ chọn → link.
- Trang `/q/[code]`: đoạn + nhãn loại văn bản + câu hỏi + chọn ngôn ngữ (nếu có alignment) + nút "Đọc tiếp từ đây" mở `/read-sample` tại anchor. Sau đó CTA đăng nhập / vào hành trình.
- OG image hiện có dùng lại, thêm dòng câu hỏi.

### 2.5 Edition record và báo lỗi tại đoạn (cập nhật)

Câu hỏi: người đọc có tin bản dịch hơn khi thấy nguồn và phạm vi review không?

- Thêm `editions.text_kind` (`literal|adapted|commentary`) và `editions.review_scope` (`full|sample|none`).
- Trang sách và màn "Về bản này" trong reader hiện: nguồn, dịch giả, loại văn bản, phạm vi review, ghi chú quyền, ngày review. Các trường này đã có sẵn trong bảng `editions`.
- Reader: nút "Báo lỗi tại đoạn này" gọi form `edition_feedback` sẵn có với locator + anchor.
- Changelog: dùng `review_note` hiện có hiển thị công khai dưới dạng "Ghi chú phiên bản"; **không** thêm bảng changelog.

### 2.6 Homepage và trang tác phẩm pilot (cập nhật)

- Hero theo định vị "Một tác phẩm. Nhiều ngôn ngữ. Cùng thảo luận." với một work pilot, đoạn mẫu song ngữ (lấy từ alignment thật), hai CTA: đọc miễn phí, bắt đầu hành trình.
- Rà copy cũ, canonical/hreflang ba locale.

### 2.7 Đo lường (cập nhật nhẹ)

Thêm event qua migration nới CHECK: `session_completed`, `journey_completed`, `passage_opened`, `passage_shared`, `compare_opened`. Mọi event có `properties.book_id`, `edition_id`, `anchor_ordinal` khi có.

Một trang `/admin/growth` tối thiểu, đọc từ 3 view:
- `growth_funnel`: open_sample → open_reader → session_completed ≥1 → journey_completed, theo work.
- `growth_retention`: người có ≥1 session_completed quay lại đọc ngày 6–8 (D7).
- `growth_share`: passage_shared → passage_opened → open_sample từ link.

Ngưỡng không mã hoá cứng; hiển thị số kèm mẫu số.

## 3. Thứ tự làm

1. Migration 2.1, 2.5, 2.7 + `database.types.ts` + pgTAP cho RLS `journey_progress`.
2. Admin journeys.
3. Trang journey, trang buổi, khu thư viện.
4. Edition record + báo lỗi tại đoạn + đọc miễn phí không tài khoản.
5. `?anchor=` trong reader (dùng chunk sẵn có).
6. Job alignment tự động + panel đối chiếu.
7. Chia sẻ đoạn kèm câu hỏi.
8. Homepage + admin growth.

Bước 1–4 chạy được pilot không cần đối chiếu. Bước 6 chỉ giữ nếu tỉ lệ ghép tự động đạt; bước 5 và 7 không phụ thuộc bước 6.

## 4. Nếu muốn thử thu tiền nhỏ

Không thêm gì: đặt journey ở trạng thái chỉ cho người có entitlement với edition, và bán edition qua chuyển khoản VND thủ công hoặc tặng bằng coupon/gift. Mở rộng sang USD/MoR chỉ khi bản đầy đủ được duyệt.

## 5. Kiểm thử

- Unit: thuật toán ghép ordinal/tỉ lệ độ dài, giới hạn câu hỏi chia sẻ.
- pgTAP: RLS journey_progress/completions, event CHECK.
- Playwright: đăng nhập → hành trình → đánh dấu 21 buổi → hoàn thành; đọc mẫu toàn bộ không đăng nhập; mở `/q/[code]` → đọc tiếp đúng anchor.
- `npm run check:full` vì đổi customer path.
