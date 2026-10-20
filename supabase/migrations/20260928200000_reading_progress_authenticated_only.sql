-- Restoring the explicit S4 privilege contract after the completion RPC was recreated.
-- Supabase default privileges can grant service_role EXECUTE on newly created functions.
revoke execute on function public.save_reading_progress(uuid, jsonb, numeric, numeric, text, bigint)
  from service_role;
