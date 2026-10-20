-- 20260913100000 grants authenticated column-level update on authors (canonical_slug,
-- display_name, status) and nothing else, so the admin editor's write of accepts_questions failed
-- with 42501 in production. The RLS policy "admin updates authors" still limits who can write it.
grant update (accepts_questions) on public.authors to authenticated;
