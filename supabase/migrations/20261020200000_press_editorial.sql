-- Press editorial accountability (Task 9).
--
-- Press republishes works whose translations have a history. Before an edition goes on sale an admin
-- records where the text and the translation come from, what the rights note says and for which
-- territories, and a reviewer approves or blocks it. This stores evidence and a decision; it is not a
-- legal determination that a work is free to use.
--
-- Readers can report a translation error against the publication and place they were reading. Reports
-- go to an admin inbox. Nothing is emailed to the original author.

alter table public.editions
  add column text_source_note text,
  add column translation_source text,
  add column rights_note text,
  add column territory_note text,
  add column editorial_state text not null default 'unreviewed'
    check (editorial_state in ('unreviewed', 'approved', 'blocked')),
  add column reviewed_by uuid references public.profiles(id),
  add column reviewed_at timestamptz,
  add column review_note text;

alter table public.editions add constraint editions_review_evidence
  check (editorial_state = 'unreviewed' or (reviewed_by is not null and reviewed_at is not null));

-- An edition that already existed (published or archived) was reviewed by whoever published it.
-- Marking it approved keeps its rollbacks and republishes working; it records that no separate review
-- exists for it.
alter table public.editions disable trigger user;
update public.editions e
set editorial_state = 'approved', reviewed_at = now(), reviewed_by = a.profile_id,
    review_note = 'Existing edition when editorial review was introduced.'
from (select ur.profile_id from public.user_roles ur where ur.role = 'admin' order by ur.profile_id limit 1) a
where e.status in ('published', 'archived');
alter table public.editions enable trigger user;

create function public.admin_save_edition_provenance(
  p_edition_id uuid,
  p_text_source_note text,
  p_translation_source text,
  p_rights_note text,
  p_territory_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_old public.editions;
  v_text text := nullif(btrim(p_text_source_note), '');
  v_translation text := nullif(btrim(p_translation_source), '');
  v_rights text := nullif(btrim(p_rights_note), '');
  v_territory text := nullif(btrim(p_territory_note), '');
  v_changed boolean;
begin
  if not public.is_admin() then
    raise exception 'admin_save_edition_provenance: caller is not an admin' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(array[v_text, v_translation, v_rights, v_territory]) t(v) where length(coalesce(v, '')) > 2000) then
    raise exception 'admin_save_edition_provenance: each note is limited to 2000 characters' using errcode = '22023';
  end if;

  select * into v_old from public.editions where id = p_edition_id for update;
  if not found then
    raise exception 'admin_save_edition_provenance: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  -- Evidence changed after an approval: the approval no longer describes it, so it must be given
  -- again (and its reviewer and date go with it). A block stays a block until someone lifts it.
  v_changed := v_old.text_source_note is distinct from v_text
    or v_old.translation_source is distinct from v_translation
    or v_old.rights_note is distinct from v_rights
    or v_old.territory_note is distinct from v_territory;

  update public.editions
  set text_source_note = v_text, translation_source = v_translation, rights_note = v_rights, territory_note = v_territory,
      editorial_state = case when v_changed and editorial_state = 'approved' then 'unreviewed' else editorial_state end,
      reviewed_by = case when v_changed and editorial_state = 'approved' then null else reviewed_by end,
      reviewed_at = case when v_changed and editorial_state = 'approved' then null else reviewed_at end
  where id = p_edition_id;

  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'save_edition_provenance', 'editions', p_edition_id, '{}'::jsonb);
end;
$$;
revoke all on function public.admin_save_edition_provenance(uuid, text, text, text, text) from public, anon;
grant execute on function public.admin_save_edition_provenance(uuid, text, text, text, text) to authenticated, service_role;

-- The decision. Approval needs the three facts a reviewer actually looks at; blocking needs a reason.
create function public.admin_set_edition_review(p_edition_id uuid, p_state text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_edition public.editions;
begin
  if not public.is_admin() then
    raise exception 'admin_set_edition_review: caller is not an admin' using errcode = '42501';
  end if;
  if p_state not in ('unreviewed', 'approved', 'blocked') then
    raise exception 'admin_set_edition_review: unknown state %', p_state using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 2000 then
    raise exception 'admin_set_edition_review: the note is limited to 2000 characters' using errcode = '22023';
  end if;

  select * into v_edition from public.editions where id = p_edition_id for update;
  if not found then
    raise exception 'admin_set_edition_review: edition % does not exist', p_edition_id using errcode = 'P0002';
  end if;

  if p_state = 'approved' and (
    v_edition.translation_source is null or v_edition.rights_note is null or v_edition.territory_note is null
  ) then
    raise exception 'admin_set_edition_review: record the translation source, rights note and territories before approving'
      using errcode = 'EB044';
  end if;
  if p_state = 'blocked' and btrim(coalesce(p_note, '')) = '' then
    raise exception 'admin_set_edition_review: a reason is required to block an edition' using errcode = '22023';
  end if;

  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  update public.editions
  set editorial_state = p_state,
      reviewed_by = case when p_state = 'unreviewed' then null else v_actor end,
      reviewed_at = case when p_state = 'unreviewed' then null else now() end,
      review_note = nullif(btrim(p_note), '')
  where id = p_edition_id;

  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'set_edition_review', 'editions', p_edition_id, jsonb_build_object('state', p_state));
end;
$$;
revoke all on function public.admin_set_edition_review(uuid, text, text) from public, anon;
grant execute on function public.admin_set_edition_review(uuid, text, text) to authenticated, service_role;

-- A new publication cannot go live for an edition nobody has approved. (Rolling back to an earlier
-- publication of an already approved edition is unaffected: the approval belongs to the edition.)
create or replace function public.publication_readiness_issues(p_publication_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select array_remove(array[
      case
        when p.epub_language is null or btrim(p.epub_language) = '' then 'epub_language_unverified'
        when lower(split_part(btrim(p.epub_language), '-', 1)) <> lower(split_part(e.language_code, '-', 1))
          then 'epub_language_mismatch'
      end,
      case when e.editorial_state = 'blocked' then 'editorial_blocked'
           when e.editorial_state <> 'approved' then 'editorial_unreviewed' end
    ], null)
    from public.ebook_publications p
    join public.ebook_assets a on a.id = p.ebook_asset_id
    join public.editions e on e.id = a.edition_id
    where p.id = p_publication_id
  ), '{}'::text[]);
$$;

-- ---- translation error reports -----------------------------------------------------------------

create table public.edition_feedback (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id),
  publication_id uuid not null references public.ebook_publications(id),
  profile_id uuid not null references public.profiles(id),
  locator jsonb,
  message text not null check (length(btrim(message)) between 1 and 2000),
  status text not null default 'new' check (status in ('new', 'resolved', 'dismissed')),
  handled_by uuid references public.profiles(id),
  handled_at timestamptz,
  admin_note text check (length(admin_note) <= 2000),
  created_at timestamptz not null default now(),
  check (locator is null or pg_column_size(locator) <= 2048)
);
create index edition_feedback_status_created_idx on public.edition_feedback (status, created_at desc);
create index edition_feedback_profile_created_idx on public.edition_feedback (profile_id, created_at desc);

alter table public.edition_feedback enable row level security;
revoke all on public.edition_feedback from public, anon, authenticated;
grant select on public.edition_feedback to service_role;
create policy "admin reads edition feedback" on public.edition_feedback for select to authenticated using ((select public.is_admin()));
grant select on public.edition_feedback to authenticated;

-- A reader reports on a publication they may read (the same rule as the reader itself), at most 5 an
-- hour and 20 a day. The message is plain text; the locator is a small object.
create function public.submit_edition_feedback(p_publication_id uuid, p_locator jsonb, p_message text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_edition_id uuid;
  v_id uuid;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'submit_edition_feedback: no profile for the current session' using errcode = 'P0002';
  end if;
  if p_message is null or length(btrim(p_message)) < 1 or length(btrim(p_message)) > 2000 or p_message ~* '</?[a-z][^>]*>' then
    raise exception 'submit_edition_feedback: the message must be 1..2000 characters of plain text' using errcode = '22023';
  end if;
  if p_locator is not null and (jsonb_typeof(p_locator) <> 'object' or length(p_locator::text) > 2000
      or (p_locator ? 'href' and (jsonb_typeof(p_locator -> 'href') <> 'string' or length(p_locator ->> 'href') > 500))) then
    raise exception 'submit_edition_feedback: the location is not valid' using errcode = '22023';
  end if;

  v_edition_id := public.reader_edition_for_publication(v_profile_id, p_publication_id);
  if v_edition_id is null then
    raise exception 'submit_edition_feedback: no readable publication %', p_publication_id using errcode = 'EB008';
  end if;

  if (select count(*) from public.edition_feedback f where f.profile_id = v_profile_id and f.created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.edition_feedback f where f.profile_id = v_profile_id and f.created_at > now() - interval '1 day') >= 20 then
    raise exception 'submit_edition_feedback: too many reports' using errcode = 'EB045';
  end if;

  insert into public.edition_feedback (edition_id, publication_id, profile_id, locator, message)
  values (v_edition_id, p_publication_id, v_profile_id, p_locator, btrim(p_message))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.submit_edition_feedback(uuid, jsonb, text) from public, anon;
grant execute on function public.submit_edition_feedback(uuid, jsonb, text) to authenticated;

create function public.admin_list_edition_feedback(p_status text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_admin() then null else coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'editionId', f.edition_id, 'bookId', e.book_id, 'languageCode', e.language_code,
      'bookTitle', coalesce((select bl.title from public.book_localizations bl where bl.book_id = e.book_id order by bl.locale = e.language_code desc, bl.locale limit 1), e.book_id::text),
      'publicationId', f.publication_id, 'locator', f.locator, 'message', f.message, 'status', f.status,
      'adminNote', f.admin_note, 'createdAt', f.created_at
    ) order by f.created_at desc, f.id)
    from (select * from public.edition_feedback where status = p_status order by created_at desc limit 200) f
    join public.editions e on e.id = f.edition_id
  ), '[]'::jsonb) end;
$$;
revoke all on function public.admin_list_edition_feedback(text) from public, anon;
grant execute on function public.admin_list_edition_feedback(text) to authenticated, service_role;

create function public.admin_resolve_edition_feedback(p_id uuid, p_status text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if not public.is_admin() then
    raise exception 'admin_resolve_edition_feedback: caller is not an admin' using errcode = '42501';
  end if;
  if p_status not in ('new', 'resolved', 'dismissed') then
    raise exception 'admin_resolve_edition_feedback: unknown status %', p_status using errcode = '22023';
  end if;
  select pr.id into v_actor from public.profiles pr where pr.auth_user_id = auth.uid();
  update public.edition_feedback
  set status = p_status,
      handled_by = case when p_status = 'new' then null else v_actor end,
      handled_at = case when p_status = 'new' then null else now() end,
      admin_note = nullif(btrim(p_note), '')
  where id = p_id;
  if not found then
    raise exception 'admin_resolve_edition_feedback: report % does not exist', p_id using errcode = 'P0002';
  end if;
  insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'resolve_edition_feedback', 'edition_feedback', p_id, jsonb_build_object('status', p_status));
end;
$$;
revoke all on function public.admin_resolve_edition_feedback(uuid, text, text) from public, anon;
grant execute on function public.admin_resolve_edition_feedback(uuid, text, text) to authenticated, service_role;
