begin;
select plan(3);

select has_column('public', 'analytics_events', 'retailer', 'analytics_events has a retailer column');
select lives_ok(
  $$insert into public.analytics_events (event_name, retailer, locale) values ('click_external_store', 'shopee', 'vi')$$,
  'click_external_store with a known retailer is accepted');
select throws_ok(
  $$insert into public.analytics_events (event_name, retailer, locale) values ('click_external_store', 'amazon', 'vi')$$,
  '23514', null, 'an unknown retailer is refused');

select * from finish();
rollback;
