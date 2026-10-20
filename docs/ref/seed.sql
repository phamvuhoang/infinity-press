-- Infinity Books development seed data
-- Safe to re-run. UUIDs are deterministic for local/dev fixtures.
-- IMPORTANT: Book prices and descriptive copy below are development fixtures,
-- not authoritative production catalog data. Replace with approved content before launch.

begin;

-- -----------------------------------------------------------------------------
-- Locales and markets
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_locales
  (code, language_code, region_code, display_name, native_name, direction, is_default, is_active)
values
  ('vi-VN','vi','VN','Vietnamese (Vietnam)','Tiếng Việt','ltr',true,true),
  ('en','en',null,'English','English','ltr',false,true),
  ('ja','ja',null,'Japanese','日本語','ltr',false,true)
on conflict (code) do update set
  language_code = excluded.language_code,
  region_code = excluded.region_code,
  display_name = excluded.display_name,
  native_name = excluded.native_name,
  direction = excluded.direction,
  is_default = excluded.is_default,
  is_active = excluded.is_active;

insert into public.infinitybooks_markets
  (id, code, name, default_locale_code, default_currency_code, country_codes, is_active, metadata)
values
  ('10000000-0000-0000-0000-000000000001','VN','Vietnam','vi-VN','VND',array['VN'],true,'{"launch_market":true}'::jsonb),
  ('10000000-0000-0000-0000-000000000002','GLOBAL','Global digital','en','USD',array[]::text[],false,'{"digital_only_initially":true}'::jsonb)
on conflict (id) do update set
  code = excluded.code,
  name = excluded.name,
  default_locale_code = excluded.default_locale_code,
  default_currency_code = excluded.default_currency_code,
  country_codes = excluded.country_codes,
  is_active = excluded.is_active,
  metadata = excluded.metadata;

insert into public.infinitybooks_market_locales (market_id, locale_code, is_default)
values
  ('10000000-0000-0000-0000-000000000001','vi-VN',true),
  ('10000000-0000-0000-0000-000000000001','en',false),
  ('10000000-0000-0000-0000-000000000002','en',true),
  ('10000000-0000-0000-0000-000000000002','ja',false)
on conflict (market_id, locale_code) do update set is_default = excluded.is_default;

insert into public.infinitybooks_publishers
  (id, canonical_slug, display_name, legal_name, website_url, status, metadata)
values
  ('20000000-0000-0000-0000-000000000001','infinity-books','Infinity Books','Infinity Books',null,'active','{"brand":"Infinity Books"}'::jsonb)
on conflict (id) do update set
  canonical_slug = excluded.canonical_slug,
  display_name = excluded.display_name,
  legal_name = excluded.legal_name,
  status = excluded.status,
  metadata = excluded.metadata;

insert into public.infinitybooks_warehouses
  (id, market_id, code, name, country_code, city, is_active)
values
  ('21000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','VN-MAIN','Vietnam Main Warehouse','VN','Ho Chi Minh City',true)
on conflict (id) do update set
  market_id = excluded.market_id,
  code = excluded.code,
  name = excluded.name,
  country_code = excluded.country_code,
  city = excluded.city,
  is_active = excluded.is_active;

insert into public.infinitybooks_payment_methods
  (id, market_id, provider, method_code, display_name, sort_order, is_active, config)
values
  ('22000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','manual','bank_qr','Bank QR',10,true,'{}'),
  ('22000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','momo','wallet','MoMo',20,false,'{}'),
  ('22000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','vnpay','gateway','VNPay',30,false,'{}'),
  ('22000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','zalopay','wallet','ZaloPay',40,false,'{}'),
  ('22000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','cod','cod','Cash on Delivery',50,true,'{"physical_only":true}')
on conflict (id) do update set
  market_id = excluded.market_id,
  provider = excluded.provider,
  method_code = excluded.method_code,
  display_name = excluded.display_name,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  config = excluded.config;

insert into public.infinitybooks_shipping_zones
  (id, market_id, name, country_codes, is_active)
values
  ('23000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Vietnam',array['VN'],true)
on conflict (id) do update set
  market_id = excluded.market_id,
  name = excluded.name,
  country_codes = excluded.country_codes,
  is_active = excluded.is_active;

insert into public.infinitybooks_shipping_methods
  (id, shipping_zone_id, code, name, provider, price_minor, currency_code, estimated_days_min, estimated_days_max, is_active)
values
  ('24000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','standard','Standard Delivery',null,30000,'VND',2,5,true),
  ('24000000-0000-0000-0000-000000000002','23000000-0000-0000-0000-000000000001','express','Express Delivery',null,50000,'VND',1,2,true)
on conflict (id) do update set
  shipping_zone_id = excluded.shipping_zone_id,
  code = excluded.code,
  name = excluded.name,
  provider = excluded.provider,
  price_minor = excluded.price_minor,
  currency_code = excluded.currency_code,
  estimated_days_min = excluded.estimated_days_min,
  estimated_days_max = excluded.estimated_days_max,
  is_active = excluded.is_active;

-- -----------------------------------------------------------------------------
-- RBAC
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_roles (id, key, name, description, is_system)
values
  ('30000000-0000-0000-0000-000000000001','super_admin','Super Admin','Full platform access',true),
  ('30000000-0000-0000-0000-000000000002','admin','Admin','Administrative access',true),
  ('30000000-0000-0000-0000-000000000003','editor','Editor','Catalog and editorial publishing',true),
  ('30000000-0000-0000-0000-000000000004','commerce_admin','Commerce Admin','Orders, refunds and fulfillment',true),
  ('30000000-0000-0000-0000-000000000005','support','Support','Reader and order support',true)
on conflict (id) do update set
  key = excluded.key,
  name = excluded.name,
  description = excluded.description,
  is_system = excluded.is_system;

insert into public.infinitybooks_permissions (id, key, name, description)
values
  ('31000000-0000-0000-0000-000000000001','catalog.read','Catalog Read','Read catalog/admin catalog data'),
  ('31000000-0000-0000-0000-000000000002','catalog.write','Catalog Write','Create and edit books/authors/series/topics'),
  ('31000000-0000-0000-0000-000000000003','catalog.publish','Catalog Publish','Publish/unpublish catalog entities'),
  ('31000000-0000-0000-0000-000000000004','content.write','Content Write','Create/edit articles/pages/excerpts'),
  ('31000000-0000-0000-0000-000000000005','content.publish','Content Publish','Publish editorial content'),
  ('31000000-0000-0000-0000-000000000006','ebook.manage','Ebook Manage','Upload/process/preview/publish ebook assets'),
  ('31000000-0000-0000-0000-000000000007','orders.read','Orders Read','Read customer orders'),
  ('31000000-0000-0000-0000-000000000008','orders.write','Orders Write','Update order and fulfillment state'),
  ('31000000-0000-0000-0000-000000000009','refunds.manage','Refunds Manage','Request/process refunds'),
  ('31000000-0000-0000-0000-000000000010','pricing.manage','Pricing Manage','Manage offers/coupons/promotions'),
  ('31000000-0000-0000-0000-000000000011','inventory.manage','Inventory Manage','Manage warehouse inventory'),
  ('31000000-0000-0000-0000-000000000012','customers.read','Customers Read','Read customer support data'),
  ('31000000-0000-0000-0000-000000000013','seo.manage','SEO Manage','Manage metadata, redirects and sitemap'),
  ('31000000-0000-0000-0000-000000000014','roles.manage','Roles Manage','Manage roles and permissions'),
  ('31000000-0000-0000-0000-000000000015','audit.read','Audit Read','Read audit logs'),
  ('31000000-0000-0000-0000-000000000016','jobs.manage','Jobs Manage','Operate processing/background jobs'),
  ('31000000-0000-0000-0000-000000000017','settings.manage','Settings Manage','Manage application settings and feature flags')
on conflict (id) do update set
  key = excluded.key,
  name = excluded.name,
  description = excluded.description;

-- Editor permissions
insert into public.infinitybooks_role_permissions (role_id, permission_id)
select '30000000-0000-0000-0000-000000000003'::uuid, id
from public.infinitybooks_permissions
where key in ('catalog.read','catalog.write','catalog.publish','content.write','content.publish','ebook.manage','seo.manage')
on conflict do nothing;

-- Commerce admin permissions
insert into public.infinitybooks_role_permissions (role_id, permission_id)
select '30000000-0000-0000-0000-000000000004'::uuid, id
from public.infinitybooks_permissions
where key in ('orders.read','orders.write','refunds.manage','pricing.manage','inventory.manage','customers.read')
on conflict do nothing;

-- Support permissions
insert into public.infinitybooks_role_permissions (role_id, permission_id)
select '30000000-0000-0000-0000-000000000005'::uuid, id
from public.infinitybooks_permissions
where key in ('orders.read','customers.read')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Authors
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_authors
  (id, canonical_slug, display_name, status, social_links, published_at)
values
  ('40000000-0000-0000-0000-000000000001','phuong-bui','Phương Bùi','published',
   '{"facebook_personal":"https://www.facebook.com/phuongbui195","facebook_author":"https://www.facebook.com/phuongbuiauthor","collshp":"https://collshp.com/phuongbui7"}'::jsonb,
   now())
on conflict (id) do update set
  canonical_slug = excluded.canonical_slug,
  display_name = excluded.display_name,
  status = excluded.status,
  social_links = excluded.social_links;

insert into public.infinitybooks_author_localizations
  (id, author_id, locale_code, slug, display_name, short_bio, bio, philosophy, status)
values
  ('41000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','vi-VN','phuong-bui','Phương Bùi',
   'Tác giả và người sáng lập hệ sinh thái Infinity Books.',
   'Nội dung phát triển nên được thay bằng tiểu sử chính thức đã được tác giả phê duyệt trước khi production launch.',
   'Quan sát rõ hơn, sống sáng hơn và xây dựng một đời sống bình an, yêu thương, thịnh vượng.',
   'published'),
  ('41000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','en','phuong-bui','Phương Bùi',
   'Author and founder in the Infinity Books ecosystem.',
   'Development copy. Replace with approved English author biography before global launch.',
   'Books and ideas for a clearer inner world.',
   'published')
on conflict (author_id, locale_code) do update set
  slug = excluded.slug,
  display_name = excluded.display_name,
  short_bio = excluded.short_bio,
  bio = excluded.bio,
  philosophy = excluded.philosophy,
  status = excluded.status;

-- -----------------------------------------------------------------------------
-- Topics and concepts
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_topics (id, canonical_key, status, sort_order)
values
  ('50000000-0000-0000-0000-000000000001','awareness','published',10),
  ('50000000-0000-0000-0000-000000000002','love','published',20),
  ('50000000-0000-0000-0000-000000000003','parenting','published',30),
  ('50000000-0000-0000-0000-000000000004','education','published',40),
  ('50000000-0000-0000-0000-000000000005','work','published',50),
  ('50000000-0000-0000-0000-000000000006','money','published',60),
  ('50000000-0000-0000-0000-000000000007','prosperity','published',70)
on conflict (id) do update set canonical_key = excluded.canonical_key, status = excluded.status, sort_order = excluded.sort_order;

insert into public.infinitybooks_topic_localizations
  (id, topic_id, locale_code, slug, name, short_description, status)
values
  ('51000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','vi-VN','quan-sat-tinh-biet','Quan sát tỉnh biết','Quan sát tâm trí và đời sống với sự rõ ràng hơn.','published'),
  ('51000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002','vi-VN','tinh-yeu','Tình yêu','Tình yêu, kết nối và mối quan hệ với chính mình.','published'),
  ('51000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000003','vi-VN','nuoi-day-con','Nuôi dạy con','Nuôi con với nhiều bình an và thấu hiểu hơn.','published'),
  ('51000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','vi-VN','giao-duc','Giáo dục','Học tập và giáo dục trong một thế giới thay đổi nhanh.','published'),
  ('51000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000005','vi-VN','cong-viec','Công việc','Công việc, hành động và cách tư duy rõ ràng.','published'),
  ('51000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000006','vi-VN','tien-bac','Tiền bạc','Cách nhìn về tiền, tài sản và quyết định tài chính.','published'),
  ('51000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000007','vi-VN','thinh-vuong','Thịnh vượng','Thịnh vượng như một trạng thái toàn diện của đời sống.','published'),
  ('51000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000001','en','awareness','Awareness','Observation, presence and clarity.','published'),
  ('51000000-0000-0000-0000-000000000012','50000000-0000-0000-0000-000000000002','en','love','Love','Love, connection and relationship with self.','published')
on conflict (topic_id, locale_code) do update set
  slug = excluded.slug, name = excluded.name, short_description = excluded.short_description, status = excluded.status;

insert into public.infinitybooks_concepts (id, canonical_key, status)
values
  ('52000000-0000-0000-0000-000000000001','observing-the-mind','published'),
  ('52000000-0000-0000-0000-000000000002','overthinking','published'),
  ('52000000-0000-0000-0000-000000000003','enoughness','published'),
  ('52000000-0000-0000-0000-000000000004','inner-stability','published')
on conflict (id) do update set canonical_key = excluded.canonical_key, status = excluded.status;

insert into public.infinitybooks_concept_localizations
  (id, concept_id, locale_code, slug, name, short_answer, description, status)
values
  ('53000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-000000000001','vi-VN','quan-sat-tam-tri','Quan sát tâm trí','Nhận biết điều đang diễn ra trong tâm trí trước khi phản ứng tự động.','Development copy for the structured Ideas layer.','published'),
  ('53000000-0000-0000-0000-000000000002','52000000-0000-0000-0000-000000000002','vi-VN','suy-nghi-qua-nhieu','Suy nghĩ quá nhiều','Nhận diện khi suy nghĩ không còn giúp giải quyết vấn đề mà trở thành vòng lặp.','Development copy for the structured Ideas layer.','published'),
  ('53000000-0000-0000-0000-000000000003','52000000-0000-0000-0000-000000000003','vi-VN','cam-giac-du','Cảm giác đủ','Một cách nhìn về sự đầy đủ không phụ thuộc hoàn toàn vào việc tích lũy thêm.','Development copy for the structured Ideas layer.','published'),
  ('53000000-0000-0000-0000-000000000004','52000000-0000-0000-0000-000000000004','vi-VN','vung-chai-ben-trong','Vững chãi bên trong','Khả năng giữ sự ổn định và rõ ràng trước biến động bên ngoài.','Development copy for the structured Ideas layer.','published')
on conflict (concept_id, locale_code) do update set
  slug = excluded.slug, name = excluded.name, short_answer = excluded.short_answer, description = excluded.description, status = excluded.status;

-- -----------------------------------------------------------------------------
-- Books, series, editions, SKUs and offers
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_books
  (id, canonical_key, original_language_code, primary_author_id, publisher_id, status, publication_kind, published_at)
values
  ('60000000-0000-0000-0000-000000000001','quan-sat-tinh-biet','vi','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','published','book',now()),
  ('60000000-0000-0000-0000-000000000002','observe-and-love','vi','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','published','book',now()),
  ('60000000-0000-0000-0000-000000000003','lam-thay-de-nghi-moi-kho','vi','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','published','book',now()),
  ('60000000-0000-0000-0000-000000000004','nuoi-con-thanh-thoi','vi','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','published','book',now()),
  ('60000000-0000-0000-0000-000000000005','dear-sunny','vi','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','published','book',now())
on conflict (id) do update set
  canonical_key = excluded.canonical_key,
  primary_author_id = excluded.primary_author_id,
  publisher_id = excluded.publisher_id,
  status = excluded.status,
  publication_kind = excluded.publication_kind;

insert into public.infinitybooks_book_localizations
  (id, book_id, locale_code, slug, title, subtitle, short_description, description, audience, key_ideas, what_you_may_discover, status)
values
  ('61000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','vi-VN','quan-sat-tinh-biet','Quan sát tỉnh biết',null,
   'Một không gian đọc về quan sát, nhận biết và sự rõ ràng bên trong.',
   'Dữ liệu mô tả development. Thay bằng nội dung chính thức do Infinity Books phê duyệt trước khi production launch.',
   'Độc giả quan tâm đến sự rõ ràng, hiện diện và cách quan sát tâm trí.',
   '["Quan sát tâm trí","Hiện diện","Vững chãi"]'::jsonb,
   '["Nhận diện phản ứng tự động","Quan sát suy nghĩ rõ hơn"]'::jsonb,'published'),
  ('61000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000002','vi-VN','observe-and-love','Observe & Love — Tình yêu luôn ở đây',null,
   'Một đầu sách trong hệ sinh thái Infinity Books về tình yêu và sự quan sát.',
   'Dữ liệu mô tả development. Thay bằng nội dung chính thức trước khi production launch.',
   'Độc giả muốn nhìn lại tình yêu, kết nối và mối quan hệ với chính mình.',
   '["Tình yêu","Quan sát","Kết nối"]'::jsonb,
   '["Quan sát cách mình yêu","Nhìn mối quan hệ rõ hơn"]'::jsonb,'published'),
  ('61000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000003','vi-VN','lam-thay-de-nghi-moi-kho','Làm thấy dễ – Nghĩ mới khó',null,
   'Một đầu sách về suy nghĩ, hành động và cách nhìn rõ vấn đề.',
   'Dữ liệu mô tả development. Thay bằng nội dung chính thức trước khi production launch.',
   'Độc giả quan tâm đến overthinking, hành động và công việc.',
   '["Overthinking","Hành động","Công việc"]'::jsonb,
   '["Nhận diện vòng lặp suy nghĩ","Tách suy nghĩ khỏi hành động"]'::jsonb,'published'),
  ('61000000-0000-0000-0000-000000000004','60000000-0000-0000-0000-000000000004','vi-VN','nuoi-con-thanh-thoi','Nuôi con thảnh thơi',null,
   'Một đầu sách về nuôi dạy con với nhiều thấu hiểu và bình an hơn.',
   'Dữ liệu mô tả development. Thay bằng nội dung chính thức trước khi production launch.',
   'Cha mẹ và người chăm sóc trẻ.',
   '["Nuôi dạy con","Bình an","Thấu hiểu"]'::jsonb,
   '["Quan sát phản ứng khi nuôi con","Tạo không gian kết nối với trẻ"]'::jsonb,'published'),
  ('61000000-0000-0000-0000-000000000005','60000000-0000-0000-0000-000000000005','vi-VN','dear-sunny','Dear Sunny',null,
   'Một đầu sách trong hệ sinh thái Infinity Books.',
   'Dữ liệu mô tả development. Thay bằng nội dung chính thức trước khi production launch.',
   'Độc giả của Infinity Books.',
   '[]'::jsonb,'[]'::jsonb,'published')
on conflict (book_id, locale_code) do update set
  slug = excluded.slug,
  title = excluded.title,
  subtitle = excluded.subtitle,
  short_description = excluded.short_description,
  description = excluded.description,
  audience = excluded.audience,
  key_ideas = excluded.key_ideas,
  what_you_may_discover = excluded.what_you_may_discover,
  status = excluded.status;

insert into public.infinitybooks_book_authors (book_id, author_id, role, sort_order)
select b.id, '40000000-0000-0000-0000-000000000001'::uuid, 'author', 0
from public.infinitybooks_books b
where b.id in (
  '60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000004',
  '60000000-0000-0000-0000-000000000005'
)
on conflict do nothing;

insert into public.infinitybooks_series
  (id, canonical_key, primary_author_id, status, recommended_start_book_id, published_at)
values
  ('62000000-0000-0000-0000-000000000001','observe-and-love','40000000-0000-0000-0000-000000000001','published','60000000-0000-0000-0000-000000000002',now())
on conflict (id) do update set
  canonical_key = excluded.canonical_key,
  primary_author_id = excluded.primary_author_id,
  status = excluded.status,
  recommended_start_book_id = excluded.recommended_start_book_id;

insert into public.infinitybooks_series_localizations
  (id, series_id, locale_code, slug, name, short_description, description, status)
values
  ('62100000-0000-0000-0000-000000000001','62000000-0000-0000-0000-000000000001','vi-VN','observe-and-love','Observe & Love','Series phát triển quanh quan sát và tình yêu.','Development copy; replace with approved editorial copy.','published')
on conflict (series_id, locale_code) do update set
  slug = excluded.slug, name = excluded.name, short_description = excluded.short_description, description = excluded.description, status = excluded.status;

insert into public.infinitybooks_series_books (series_id, book_id, sequence_number, sort_order, is_recommended_start)
values
  ('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',1,10,true),
  ('62000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',2,20,false)
on conflict (series_id, book_id) do update set
  sequence_number = excluded.sequence_number,
  sort_order = excluded.sort_order,
  is_recommended_start = excluded.is_recommended_start;

insert into public.infinitybooks_book_topics (book_id, topic_id, relation_type, weight, sort_order)
values
  ('60000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','primary',1,10),
  ('60000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000007','secondary',0.6,20),
  ('60000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002','primary',1,10),
  ('60000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000001','secondary',0.8,20),
  ('60000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000005','primary',1,10),
  ('60000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000003','primary',1,10),
  ('60000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','secondary',0.7,20)
on conflict (book_id, topic_id) do update set
  relation_type = excluded.relation_type, weight = excluded.weight, sort_order = excluded.sort_order;

insert into public.infinitybooks_book_concepts (book_id, concept_id, relation_type, weight, sort_order)
values
  ('60000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-000000000001','primary',1,10),
  ('60000000-0000-0000-0000-000000000001','52000000-0000-0000-0000-000000000004','explores',0.8,20),
  ('60000000-0000-0000-0000-000000000003','52000000-0000-0000-0000-000000000002','primary',1,10),
  ('60000000-0000-0000-0000-000000000002','52000000-0000-0000-0000-000000000003','explores',0.7,20)
on conflict (book_id, concept_id) do update set
  relation_type = excluded.relation_type, weight = excluded.weight, sort_order = excluded.sort_order;

insert into public.infinitybooks_book_relations (source_book_id, target_book_id, relation_type, weight)
values
  ('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','companion',0.9),
  ('60000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000001','companion',0.9),
  ('60000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000001','related',0.7),
  ('60000000-0000-0000-0000-000000000004','60000000-0000-0000-0000-000000000001','related',0.6)
on conflict do update set weight = excluded.weight;

-- One Vietnamese development edition for each sample book.
insert into public.infinitybooks_editions
  (id, book_id, publisher_id, language_code, edition_name, status)
values
  ('63000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','vi','Vietnamese edition','published'),
  ('63000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','vi','Vietnamese edition','published'),
  ('63000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','vi','Vietnamese edition','published'),
  ('63000000-0000-0000-0000-000000000004','60000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001','vi','Vietnamese edition','published'),
  ('63000000-0000-0000-0000-000000000005','60000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000001','vi','Vietnamese edition','published')
on conflict (id) do update set
  book_id = excluded.book_id,
  publisher_id = excluded.publisher_id,
  language_code = excluded.language_code,
  edition_name = excluded.edition_name,
  status = excluded.status;

-- Physical + ebook SKUs. Ebook SKUs intentionally have no ebook asset yet.
insert into public.infinitybooks_skus
  (id, edition_id, sku_code, format, fulfillment_type, active)
values
  ('64000000-0000-0000-0000-000000000001','63000000-0000-0000-0000-000000000001','QSTB-PB-VI','paperback','physical',true),
  ('64000000-0000-0000-0000-000000000002','63000000-0000-0000-0000-000000000001','QSTB-EB-VI','ebook','digital',true),
  ('64000000-0000-0000-0000-000000000003','63000000-0000-0000-0000-000000000002','OAL-PB-VI','paperback','physical',true),
  ('64000000-0000-0000-0000-000000000004','63000000-0000-0000-0000-000000000002','OAL-EB-VI','ebook','digital',true),
  ('64000000-0000-0000-0000-000000000005','63000000-0000-0000-0000-000000000003','LTDNMK-PB-VI','paperback','physical',true),
  ('64000000-0000-0000-0000-000000000006','63000000-0000-0000-0000-000000000003','LTDNMK-EB-VI','ebook','digital',true),
  ('64000000-0000-0000-0000-000000000007','63000000-0000-0000-0000-000000000004','NCTT-PB-VI','paperback','physical',true),
  ('64000000-0000-0000-0000-000000000008','63000000-0000-0000-0000-000000000004','NCTT-EB-VI','ebook','digital',true),
  ('64000000-0000-0000-0000-000000000009','63000000-0000-0000-0000-000000000005','DS-PB-VI','paperback','physical',true),
  ('64000000-0000-0000-0000-000000000010','63000000-0000-0000-0000-000000000005','DS-EB-VI','ebook','digital',true)
on conflict (id) do update set
  edition_id = excluded.edition_id,
  sku_code = excluded.sku_code,
  format = excluded.format,
  fulfillment_type = excluded.fulfillment_type,
  active = excluded.active;

-- Illustrative development pricing only.
insert into public.infinitybooks_offers
  (id, sku_id, market_id, currency_code, price_minor, compare_at_price_minor, active)
values
  ('65000000-0000-0000-0000-000000000001','64000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','VND',199000,null,true),
  ('65000000-0000-0000-0000-000000000002','64000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','VND',99000,null,true),
  ('65000000-0000-0000-0000-000000000003','64000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','VND',189000,null,true),
  ('65000000-0000-0000-0000-000000000004','64000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','VND',89000,null,true),
  ('65000000-0000-0000-0000-000000000005','64000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000001','VND',179000,null,true),
  ('65000000-0000-0000-0000-000000000006','64000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000001','VND',89000,null,true),
  ('65000000-0000-0000-0000-000000000007','64000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000001','VND',169000,null,true),
  ('65000000-0000-0000-0000-000000000008','64000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000001','VND',79000,null,true),
  ('65000000-0000-0000-0000-000000000009','64000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000001','VND',159000,null,true),
  ('65000000-0000-0000-0000-000000000010','64000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001','VND',79000,null,true)
on conflict (id) do update set
  sku_id = excluded.sku_id,
  market_id = excluded.market_id,
  currency_code = excluded.currency_code,
  price_minor = excluded.price_minor,
  compare_at_price_minor = excluded.compare_at_price_minor,
  active = excluded.active;

insert into public.infinitybooks_inventory_items
  (id, sku_id, warehouse_id, on_hand, reserved, reorder_point, allow_backorder)
values
  ('66000000-0000-0000-0000-000000000001','64000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001',100,0,20,false),
  ('66000000-0000-0000-0000-000000000002','64000000-0000-0000-0000-000000000003','21000000-0000-0000-0000-000000000001',100,0,20,false),
  ('66000000-0000-0000-0000-000000000003','64000000-0000-0000-0000-000000000005','21000000-0000-0000-0000-000000000001',100,0,20,false),
  ('66000000-0000-0000-0000-000000000004','64000000-0000-0000-0000-000000000007','21000000-0000-0000-0000-000000000001',100,0,20,false),
  ('66000000-0000-0000-0000-000000000005','64000000-0000-0000-0000-000000000009','21000000-0000-0000-0000-000000000001',100,0,20,false)
on conflict (id) do update set
  sku_id = excluded.sku_id,
  warehouse_id = excluded.warehouse_id,
  on_hand = excluded.on_hand,
  reserved = excluded.reserved,
  reorder_point = excluded.reorder_point,
  allow_backorder = excluded.allow_backorder;

-- -----------------------------------------------------------------------------
-- Editorial discovery fixtures
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_articles
  (id, canonical_key, primary_author_id, status, article_type, published_at)
values
  ('70000000-0000-0000-0000-000000000001','what-is-awareness','40000000-0000-0000-0000-000000000001','published','article',now()),
  ('70000000-0000-0000-0000-000000000002','why-we-overthink','40000000-0000-0000-0000-000000000001','published','article',now())
on conflict (id) do update set
  canonical_key = excluded.canonical_key,
  primary_author_id = excluded.primary_author_id,
  status = excluded.status,
  article_type = excluded.article_type;

insert into public.infinitybooks_article_localizations
  (id, article_id, locale_code, slug, title, dek, body_markdown, estimated_reading_minutes, status)
values
  ('71000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','vi-VN','quan-sat-tinh-biet-la-gi','Quan sát tỉnh biết là gì?','Một trang nội dung mẫu cho Knowledge layer.','# Quan sát tỉnh biết là gì?\n\nNội dung development. Thay bằng bài viết chính thức trước khi production launch.',4,'published'),
  ('71000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000002','vi-VN','tai-sao-chung-ta-suy-nghi-qua-nhieu','Tại sao chúng ta suy nghĩ quá nhiều?','Một trang nội dung mẫu kết nối từ search intent tới sách.','# Tại sao chúng ta suy nghĩ quá nhiều?\n\nNội dung development. Thay bằng bài viết chính thức trước khi production launch.',5,'published')
on conflict (article_id, locale_code) do update set
  slug = excluded.slug,
  title = excluded.title,
  dek = excluded.dek,
  body_markdown = excluded.body_markdown,
  estimated_reading_minutes = excluded.estimated_reading_minutes,
  status = excluded.status;

insert into public.infinitybooks_article_relations
  (id, article_id, relation_type, book_id, topic_id, concept_id, weight, sort_order)
values
  ('72000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','book','60000000-0000-0000-0000-000000000001',null,null,1,10),
  ('72000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000001','concept',null,null,'52000000-0000-0000-0000-000000000001',1,20),
  ('72000000-0000-0000-0000-000000000003','70000000-0000-0000-0000-000000000002','book','60000000-0000-0000-0000-000000000003',null,null,1,10),
  ('72000000-0000-0000-0000-000000000004','70000000-0000-0000-0000-000000000002','concept',null,null,'52000000-0000-0000-0000-000000000002',1,20)
on conflict (id) do update set
  article_id = excluded.article_id,
  relation_type = excluded.relation_type,
  book_id = excluded.book_id,
  topic_id = excluded.topic_id,
  concept_id = excluded.concept_id,
  weight = excluded.weight,
  sort_order = excluded.sort_order;

insert into public.infinitybooks_collections
  (id, canonical_key, status, collection_type, sort_order)
values
  ('73000000-0000-0000-0000-000000000001','start-here','published','editorial',10),
  ('73000000-0000-0000-0000-000000000002','love','published','editorial',20),
  ('73000000-0000-0000-0000-000000000003','for-parents','published','editorial',30)
on conflict (id) do update set
  canonical_key = excluded.canonical_key,
  status = excluded.status,
  collection_type = excluded.collection_type,
  sort_order = excluded.sort_order;

insert into public.infinitybooks_collection_localizations
  (id, collection_id, locale_code, slug, name, short_description, status)
values
  ('73100000-0000-0000-0000-000000000001','73000000-0000-0000-0000-000000000001','vi-VN','bat-dau-tu-day','Bắt đầu từ đây','Gợi ý điểm bắt đầu cho độc giả mới của Infinity Books.','published'),
  ('73100000-0000-0000-0000-000000000002','73000000-0000-0000-0000-000000000002','vi-VN','tinh-yeu','Sách về tình yêu','Những đầu sách kết nối với chủ đề tình yêu.','published'),
  ('73100000-0000-0000-0000-000000000003','73000000-0000-0000-0000-000000000003','vi-VN','danh-cho-cha-me','Dành cho cha mẹ','Những đầu sách dành cho hành trình nuôi dạy con.','published')
on conflict (collection_id, locale_code) do update set
  slug = excluded.slug,
  name = excluded.name,
  short_description = excluded.short_description,
  status = excluded.status;

insert into public.infinitybooks_collection_books (collection_id, book_id, sort_order, featured)
values
  ('73000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001',10,true),
  ('73000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',20,false),
  ('73000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000002',10,true),
  ('73000000-0000-0000-0000-000000000003','60000000-0000-0000-0000-000000000004',10,true)
on conflict (collection_id, book_id) do update set sort_order = excluded.sort_order, featured = excluded.featured;

insert into public.infinitybooks_excerpts
  (id, book_id, edition_id, locale_code, excerpt_type, body, source_label, is_public, is_featured, sort_order, status)
values
  ('74000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','63000000-0000-0000-0000-000000000001','vi-VN','sample_teaser','Đây là excerpt development dùng để kiểm thử layout. Không phải trích dẫn chính thức từ sách.',null,true,true,10,'published'),
  ('74000000-0000-0000-0000-000000000002','60000000-0000-0000-0000-000000000002','63000000-0000-0000-0000-000000000002','vi-VN','sample_teaser','Đây là excerpt development dùng để kiểm thử layout. Không phải trích dẫn chính thức từ sách.',null,true,true,10,'published')
on conflict (id) do update set
  body = excluded.body,
  is_public = excluded.is_public,
  is_featured = excluded.is_featured,
  status = excluded.status;

insert into public.infinitybooks_faqs (id, canonical_key, category, status)
values
  ('75000000-0000-0000-0000-000000000001','ebook-access','ebook','published'),
  ('75000000-0000-0000-0000-000000000002','physical-shipping','shipping','published'),
  ('75000000-0000-0000-0000-000000000003','ebook-device-support','ebook','published')
on conflict (id) do update set canonical_key = excluded.canonical_key, category = excluded.category, status = excluded.status;

insert into public.infinitybooks_faq_localizations
  (id, faq_id, locale_code, question, answer_markdown, status)
values
  ('75100000-0000-0000-0000-000000000001','75000000-0000-0000-0000-000000000001','vi-VN','Sau khi mua ebook, tôi đọc sách ở đâu?','Sau khi thanh toán thành công, ebook sẽ xuất hiện trong **Thư viện của tôi** và có thể mở ngay bằng trình đọc trên web.','published'),
  ('75100000-0000-0000-0000-000000000002','75000000-0000-0000-0000-000000000002','vi-VN','Infinity Books giao sách như thế nào?','Thông tin giao hàng development; thay bằng chính sách fulfillment chính thức trước khi launch.','published'),
  ('75100000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000003','vi-VN','Tôi có thể đọc ebook trên điện thoại không?','Có. Reader được thiết kế responsive cho desktop, tablet và mobile.','published')
on conflict (faq_id, locale_code) do update set
  question = excluded.question,
  answer_markdown = excluded.answer_markdown,
  status = excluded.status;

insert into public.infinitybooks_faq_links (id, faq_id, entity_type, entity_id, sort_order)
values
  ('75200000-0000-0000-0000-000000000001','75000000-0000-0000-0000-000000000001','global',null,10),
  ('75200000-0000-0000-0000-000000000002','75000000-0000-0000-0000-000000000002','global',null,20),
  ('75200000-0000-0000-0000-000000000003','75000000-0000-0000-0000-000000000003','global',null,30)
on conflict (id) do update set sort_order = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- Static pages / merchandising / settings
-- -----------------------------------------------------------------------------

insert into public.infinitybooks_pages (id, canonical_key, page_type, status, published_at)
values
  ('80000000-0000-0000-0000-000000000001','about','about','published',now()),
  ('80000000-0000-0000-0000-000000000002','privacy','legal','published',now()),
  ('80000000-0000-0000-0000-000000000003','terms','legal','published',now()),
  ('80000000-0000-0000-0000-000000000004','ebook-license','legal','published',now()),
  ('80000000-0000-0000-0000-000000000005','shipping','help','published',now()),
  ('80000000-0000-0000-0000-000000000006','returns','help','published',now())
on conflict (id) do update set canonical_key = excluded.canonical_key, page_type = excluded.page_type, status = excluded.status;

insert into public.infinitybooks_page_localizations
  (id, page_id, locale_code, slug, title, body_markdown, status)
values
  ('81000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001','vi-VN','about','Về Infinity Books','# Infinity Books\n\nKhông gian sách, đọc và khám phá tri thức. Nội dung development.','published'),
  ('81000000-0000-0000-0000-000000000002','80000000-0000-0000-0000-000000000002','vi-VN','privacy','Chính sách quyền riêng tư','# Chính sách quyền riêng tư\n\nPlaceholder development. Phải được legal review trước launch.','published'),
  ('81000000-0000-0000-0000-000000000003','80000000-0000-0000-0000-000000000003','vi-VN','terms','Điều khoản sử dụng','# Điều khoản sử dụng\n\nPlaceholder development. Phải được legal review trước launch.','published'),
  ('81000000-0000-0000-0000-000000000004','80000000-0000-0000-0000-000000000004','vi-VN','ebook-license','Giấy phép sử dụng ebook','# Giấy phép sử dụng ebook\n\nPlaceholder development. Phải được legal review trước launch.','published'),
  ('81000000-0000-0000-0000-000000000005','80000000-0000-0000-0000-000000000005','vi-VN','shipping','Giao hàng','# Giao hàng\n\nPlaceholder development.','published'),
  ('81000000-0000-0000-0000-000000000006','80000000-0000-0000-0000-000000000006','vi-VN','returns','Đổi trả & hoàn tiền','# Đổi trả & hoàn tiền\n\nPlaceholder development.','published')
on conflict (page_id, locale_code) do update set slug = excluded.slug, title = excluded.title, body_markdown = excluded.body_markdown, status = excluded.status;

insert into public.infinitybooks_merchandising_slots
  (id, slot_key, page_key, locale_code, market_id, title, is_active)
values
  ('82000000-0000-0000-0000-000000000001','home.hero','home','vi-VN','10000000-0000-0000-0000-000000000001','Featured',true),
  ('82000000-0000-0000-0000-000000000002','home.featured_books','home','vi-VN','10000000-0000-0000-0000-000000000001','Sách nổi bật',true),
  ('82000000-0000-0000-0000-000000000003','home.start_here','home','vi-VN','10000000-0000-0000-0000-000000000001','Bắt đầu từ đây',true)
on conflict (id) do update set
  slot_key = excluded.slot_key,
  page_key = excluded.page_key,
  locale_code = excluded.locale_code,
  market_id = excluded.market_id,
  title = excluded.title,
  is_active = excluded.is_active;

insert into public.infinitybooks_merchandising_items
  (id, slot_id, entity_type, entity_id, sort_order)
values
  ('82100000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','book','60000000-0000-0000-0000-000000000001',10),
  ('82100000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000002','book','60000000-0000-0000-0000-000000000001',10),
  ('82100000-0000-0000-0000-000000000003','82000000-0000-0000-0000-000000000002','book','60000000-0000-0000-0000-000000000002',20),
  ('82100000-0000-0000-0000-000000000004','82000000-0000-0000-0000-000000000002','book','60000000-0000-0000-0000-000000000004',30),
  ('82100000-0000-0000-0000-000000000005','82000000-0000-0000-0000-000000000003','collection','73000000-0000-0000-0000-000000000001',10)
on conflict (id) do update set
  slot_id = excluded.slot_id,
  entity_type = excluded.entity_type,
  entity_id = excluded.entity_id,
  sort_order = excluded.sort_order;

insert into public.infinitybooks_application_settings (key, value, is_public, description)
values
  ('brand.name','"Infinity Books"'::jsonb,true,'Public brand name'),
  ('brand.tagline','"Read to see more clearly."'::jsonb,true,'Development tagline; replace with approved brand copy'),
  ('commerce.default_market','"VN"'::jsonb,true,'Default launch market'),
  ('commerce.guest_checkout','true'::jsonb,true,'Allow checkout without account creation'),
  ('reader.default_theme','"paper"'::jsonb,true,'Default ebook reader theme'),
  ('reader.copy_limit_enabled','true'::jsonb,false,'Server-side/content-policy toggle for copied excerpts'),
  ('seo.default_locale','"vi-VN"'::jsonb,true,'Default SEO locale'),
  ('seo.llms_txt_enabled','true'::jsonb,true,'Expose optional canonical entity index for compatible consumers')
on conflict (key) do update set
  value = excluded.value,
  is_public = excluded.is_public,
  description = excluded.description;

insert into public.infinitybooks_feature_flags (key, description, enabled, rollout_percentage, config)
values
  ('ask_infinity','AI-assisted book Q&A; not a launch dependency',false,0,'{}'),
  ('semantic_search','Semantic search / reranking',false,0,'{}'),
  ('global_market','Enable international market switching',false,0,'{}'),
  ('ebook_reader','Browser ebook reader',true,100,'{}'),
  ('knowledge_hub','Ideas / structured knowledge pages',true,100,'{}')
on conflict (key) do update set
  description = excluded.description,
  enabled = excluded.enabled,
  rollout_percentage = excluded.rollout_percentage,
  config = excluded.config;

-- Example promotion/coupon fixture; disabled by default.
insert into public.infinitybooks_coupons
  (id, code, market_id, discount_type, percentage, starts_at, ends_at, status, metadata)
values
  ('83000000-0000-0000-0000-000000000001','WELCOME10','10000000-0000-0000-0000-000000000001','percentage',0.10,null,null,'inactive','{"fixture":true}'::jsonb)
on conflict (id) do update set
  code = excluded.code,
  market_id = excluded.market_id,
  discount_type = excluded.discount_type,
  percentage = excluded.percentage,
  status = excluded.status,
  metadata = excluded.metadata;

commit;
