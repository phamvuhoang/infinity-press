# Handbook triển khai MVP ebook

Tài liệu này dùng cho Vercel + Supabase hosted của **Infinity Books Press** (project riêng, không dùng lại project infinitybooks.vn). Hiện chưa có staging database riêng và EPUB worker
vẫn chạy từ máy operator. Không triển khai production khi ma trận năm EPUB trong
`docs/spikes/readium-web-results.md` còn `unmeasured`.

## 1. Kiểm tra trước khi triển khai

```bash
npm ci
npm run check
supabase start -x analytics,edge-runtime,imgproxy,inbucket,realtime,studio,vector
supabase db reset
supabase test db
gh pr checks 13
```

Chỉ tiếp tục khi toàn bộ lệnh thành công. Xác nhận đã có backup hoặc Point-in-Time Recovery trước
lần `db push` đầu tiên. Không chạy E2E, `db reset` hoặc pgTAP với Supabase production.

## 2. Cấu hình production

Đặt các biến sau trong Vercel Production Environment:

```text
APP_ENV=production
SITE_URL=https://<ten-mien>
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUPABASE_SERVICE_ROLE_KEY=<server-only-secret>
PAYMENT_PROVIDER=disabled
READER_SESSION_TTL_SECONDS=900
```

Không đặt service-role key trong biến có tiền tố `NEXT_PUBLIC_`. Trong Supabase Auth, cập nhật Site
URL, thêm `https://<ten-mien>/auth/callback**`, rồi đồng bộ ba email template trong
`supabase/templates/`.

## 3. Áp dụng migration

```bash
supabase link --project-ref <project-ref>
supabase migration list
supabase db push
supabase migration list
```

So sánh danh sách trước và sau. Không dùng `supabase db reset` với project đã link production.
Repository không có down migration; nếu migration gây lỗi, dừng rollout và phục hồi backup/PITR
hoặc viết compensating migration đã được review.

## 4. Triển khai web

Merge PR sau khi các required check xanh. Vercel sẽ build branch `main` bằng
`npm run build` theo cấu hình repository. Sau deploy, smoke test:

```text
/{locale} -> đăng nhập magic link -> /{locale}/library
/admin -> tạo/upload EPUB -> kiểm tra trạng thái queued
```

Kiểm tra production không khởi động được simulator và request ẩn danh không đọc được source EPUB
hoặc paid resource.

## 5. Chạy EPUB worker

Trên máy operator an toàn, trỏ `.env.local` tới Supabase hosted và giữ service-role key cục bộ:

```bash
npm run ebook -- validate fixtures/epub/private/book-01.epub
EBOOK_LEASE_SECONDS=1800 npm run ebook -- process-next
npm run ebook -- retry --job <job-id>
```

Theo dõi JSON output bằng `correlationId`. Không retry `SOURCE_CHECKSUM_MISMATCH` hoặc
`STALE_VERSION`; upload một asset version mới.

## 6. Gate sau triển khai

1. Preview, publish và rollback một publication.
2. Grant rồi revoke complimentary entitlement; library item phải biến mất ngay.
3. Mở reader, đổi typography, reload và xác nhận locator được phục hồi.
4. Chạy đủ năm EPUB trên desktop Chrome, mobile Chrome, Safari/WebKit và Firefox; ghi kết quả vào
   `docs/spikes/readium-web-results.md`.

## S3 get and buy

- Production giữ `PAYMENT_PROVIDER=disabled`. Không đặt `PAYMENT_SIMULATOR_SECRET` trong production.
- Migration `20260915120000_ebook_orders.sql` tạo `commerce_settings` với `payments_enabled = false`.
  Không bật cờ này trên project cloud, vì project này dùng chung với production.
- Sau `supabase db push`, kiểm tra:

```sql
select payments_enabled from public.commerce_settings;
```

  Kết quả phải là `false`.
- Sách trả phí hiển thị "Coming soon". Sách miễn phí dùng **Get free** bình thường.
- Xem `docs/runbooks/checkout.md` để thu hồi quyền truy cập từ một đơn hàng.

## Cheatsheet

| Mục đích | Lệnh |
| --- | --- |
| Gate web | `npm run check` |
| Gate đầy đủ local | `npm run check:full` |
| Reset database local | `npm run db:reset` |
| pgTAP | `npm run db:test` |
| Xem migration | `supabase migration list` |
| Đẩy migration | `supabase db push` |
| Xử lý job kế tiếp | `npm run ebook -- process-next` |
| Retry job | `npm run ebook -- retry --job <job-id>` |
| Trạng thái PR | `gh pr checks 13` |

## Rollback nhanh

- Web: redeploy/promote deployment Vercel ổn định gần nhất.
- Database: không reset; dùng PITR/backup hoặc compensating migration.
- Publication: dùng rollback action để đổi active-publication pointer về version đã kiểm chứng.
- Worker: dừng poll loop; job đang giữ lease sẽ tự claim lại sau khi lease hết hạn.

## S1 catalog admin migrations

The S1 migrations are `20260913100000` (schema/storage/audit), `20260913110000` (catalog RPCs),
`20260913120000` (book readiness/publishing), `20260913130000` (admin cover reads), and
`20260913140000` (reuse a manually created author by name).
Before `supabase db push` to the hosted project:

1. Run `select distinct slot_key from public.merchandising_slots;` when that table already exists.
   Any key other than `home_featured` or `home_shelf` makes the schema migration fail. Inspect those
   rows and prepare a reviewed rename or removal before applying it. Do not blindly delete data.
2. Books already marked `published` remain published. Newly published EPUB versions no longer
   publish their book; operators use **Publish book** in the editor after completing readiness.
3. Verify the whole release locally first: scratch `supabase db reset`, `supabase test db`, generated
   types with no diff, and `npm run check:full` with local Supabase/Mailpit exported before building.
   Use `--workdir .superpowers/scratch/sbworkdir` and a dedicated Playwright port if default ports
   belong to another project. Exact setup is in [testing environments](testing-environments.md).
4. After the push, confirm `covers` exists and is public, while `ebook-source` and `ebook-derived`
   remain private. Smoke-check a cover URL and denied anonymous EPUB access. Do not run the
   automated fixtures, pgTAP, or reset against the hosted project.

Operator procedure: [catalog admin](catalog-admin.md). Catalog rollout does not remove the
existing five-EPUB/browser validation gate or enable production payments.

## S5 SEO and operations

S5 adds three migrations (`20260916110000_s5_observability_outbox`, `20260916120000_s5_event_triggers`,
`20260916130000_s5_redirects_and_operations`), book-ready email through Resend, the operations
worker, Vercel Speed Insights, and the public SEO surface. The full procedure, with every SQL
statement, is in [SEO and operations](seo-and-operations.md).

Add these to the Vercel Production environment, next to the variables in section 2:

```text
EMAIL_PROVIDER=resend
RESEND_API_KEY=<server-only-secret>
EMAIL_FROM=Infinity Books <books@<verified-resend-domain>>
OPS_ALERT_EMAIL=<operator-inbox>
OPS_WORKER_SECRET=<at least 32 random characters>
```

> **Set every S5 variable before the S5 deployment goes live.** The `/[lang]` root layout
> validates the full server environment on every page render. In production a missing or invalid
> S5 value - for example no `OPS_WORKER_SECRET`, or `EMAIL_PROVIDER` not `resend` - makes every
> customer-facing route under `/{locale}` fail. `/admin` and `/internal` have their own root
> layouts and do not call this validation, so a bad S5 value does not fail those routes. Do not
> remove these variables while an S5 deployment is live.

Roll out in this order:

1. **Migrate.** `supabase migration list`, `supabase db push`, `supabase migration list`, as in
   section 3. The migrations create no schedule and backfill no email: entitlements that already
   exist never receive a book-ready email.
2. **Configure Resend.** Verify the sending domain and create a sending-only API key
   ([SEO and operations](seo-and-operations.md), section 2).
3. **Configure Vault.** Store the production origin and the worker secret in Supabase Vault
   (section 3 of that runbook).
4. **Deploy.** Set the five variables above, then deploy the web app.
5. **Smoke test.** Call the worker once by hand and check `HTTP 200` and the counts (section 5 of
   that runbook). Open `/admin/operations` as an admin.
6. **Schedule.** Run the idempotent `pg_cron` SQL (section 4 of that runbook) and confirm the next
   run returns `200` in `net._http_response`.
7. **Enable Speed Insights** in the Vercel project (section 9 of that runbook).

Rollback always unschedules the worker before it disables email (section 10 of that runbook).
Vercel has no cron job for S5; do not add one.

## S7 manual bank transfer

S7 adds the manual payment provider: readers transfer to a bank account and an admin confirms each
transfer by hand. This is the first provider production can actually take money with. The operator
procedure is in [manual bank transfer](manual-payment.md).

Replace `PAYMENT_PROVIDER=disabled` from section 2 with `manual`, and add the four bank variables
beside it in the Vercel Production environment:

```text
PAYMENT_PROVIDER=manual
BANK_TRANSFER_BANK_CODE=<6-digit Napas/VietQR bank code, e.g. 970436>
BANK_TRANSFER_BANK_NAME=<bank name as the reader should see it>
BANK_TRANSFER_ACCOUNT_NUMBER=<6 to 20 digits>
BANK_TRANSFER_ACCOUNT_HOLDER=<account holder name as the bank prints it>
```

> **All four are required together whenever `PAYMENT_PROVIDER=manual`, and the root layout validates
> the whole server environment on every render.** A missing or badly formatted one makes every route
> fail, `/admin` included - the same failure mode as the S5 variables above. `BANK_TRANSFER_BANK_CODE`
> must be exactly six digits and `BANK_TRANSFER_ACCOUNT_NUMBER` six to twenty. They are not secrets -
> the reader reads all four off the transfer page - but they stay server-side; do not add a
> `NEXT_PUBLIC_` copy.

`PAYMENT_PROVIDER=simulator` is still refused in production, and `PAYMENT_SIMULATOR_SECRET` still has
no place there.

Roll out in this order:

1. **Migrate.** `supabase migration list`, `supabase db push`, `supabase migration list`, as in
   section 3.
2. **Deploy** with the five variables above, while `commerce_settings.payments_enabled` is still
   `false`. Nobody can buy yet, so a misconfigured bank detail cannot reach a reader.
3. **Check** the four values on a pending order's transfer page, against the bank's own records.
4. **Point the database at the same provider**, in the same step, and only then enable buying:

   ```sql
   update public.commerce_settings
   set payment_provider = 'manual', payments_enabled = true;
   ```

   `commerce_settings.payment_provider` is what `create_ebook_order` books each order under, and it
   must match `PAYMENT_PROVIDER`. Nothing enforces that and nothing warns about it; if they
   disagree, readers reach the transfer page and then cannot report their transfer, while
   `/admin/payments` stays empty. This is also the moment real money starts moving, so it is a
   deliberate step, not part of a deployment.
5. **Check one order end to end** - buy, transfer page, report, confirm in `/admin/payments` -
   before telling anyone the provider is live.

To roll back, set `payments_enabled = false` first, work through whatever is left in
`/admin/payments`, and only then change `PAYMENT_PROVIDER` and `commerce_settings.payment_provider`
together. Turning the provider off with reported
transfers still unconfirmed leaves readers who have already paid with no way to be granted access.
