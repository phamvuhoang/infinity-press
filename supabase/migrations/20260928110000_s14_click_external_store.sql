-- S14: the browser reports a click on a paperback retailer link. The retailer is a constrained
-- column, not a JSON property: the table keeps its no-free-text rule.
alter table public.analytics_events
  add column retailer text check (retailer is null or retailer in ('shopee', 'fahasa', 'tiki', 'other'));

alter table public.analytics_events
  drop constraint analytics_events_event_name_check,
  add constraint analytics_events_event_name_check check (event_name in (
    'view_book', 'open_sample', 'begin_checkout', 'purchase', 'payment_failed',
    'open_reader', 'progress_25', 'progress_50', 'progress_75', 'progress_100',
    'change_reader_setting', 'view_library', 'book_published',
    'epub_job_started', 'epub_job_completed', 'epub_job_failed',
    'click_external_store'
  ));
