-- Close the final nullable-CHECK gap in the original private search-chunk locator constraint.
-- Missing JSON paths yield SQL NULL; CHECK accepts it, so this predicate is deliberately total.

alter table public.ebook_search_chunks
  add constraint ebook_search_chunks_required_text_locator_check check (
    coalesce(
      jsonb_typeof(locator_json -> 'text') = 'object'
      and jsonb_typeof(locator_json #> '{text,highlight}') = 'string'
      and char_length(locator_json #>> '{text,highlight}') between 1 and 160
      and (not (locator_json -> 'text' ? 'before')
        or (jsonb_typeof(locator_json #> '{text,before}') = 'string'
          and char_length(locator_json #>> '{text,before}') <= 64))
      and (not (locator_json -> 'text' ? 'after')
        or (jsonb_typeof(locator_json #> '{text,after}') = 'string'
          and char_length(locator_json #>> '{text,after}') <= 64)),
      false
    )
  );
