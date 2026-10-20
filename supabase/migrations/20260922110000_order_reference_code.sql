-- S7: the human-readable order reference (spec 5.3). It is the bank transfer memo, the string the
-- reader copies, and the admin's search key.

-- Crockford base32 without I, L, O and U: a memo typed from a screen into a banking app should not
-- depend on telling I from 1 or O from 0.
create function public.generate_order_reference()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'IB-' || string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), ''
  )
  from generate_series(1, 5);
$$;

alter table public.orders add column reference_code text;

-- The unique constraint goes on before the backfill runs, not after. A nullable unique column
-- accepts any number of nulls, so it is safe here, and it is what lets the backfill's own retry
-- loop work: without an index to violate, `update ... set reference_code = v_code` cannot raise
-- unique_violation, so the exception handler below would never fire and two rows could silently
-- draw the same code, surfacing only later when this constraint is added over already-duplicated
-- data and the whole migration aborts.
alter table public.orders add constraint orders_reference_code_key unique (reference_code);

-- Backfill before the not-null constraint. The loop retries a collision rather than assuming one
-- cannot happen: 32^5 is large but not large enough to assume uniqueness.
do $$
declare
  v_id uuid;
  v_code text;
begin
  for v_id in select id from public.orders where reference_code is null loop
    loop
      v_code := public.generate_order_reference();
      begin
        update public.orders set reference_code = v_code where id = v_id;
        exit;
      exception when unique_violation then
        -- try another code
      end;
    end loop;
  end loop;
end;
$$;

alter table public.orders
  add constraint orders_reference_code_format
    check (reference_code ~ '^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$'),
  alter column reference_code set not null;

-- Every insert gets a code, including the ones create_ebook_order makes, without changing that
-- function's body. A trigger keeps the rule in one place for any future order-creating RPC.
create function public.orders_reference_code_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reference_code is null then
    loop
      new.reference_code := public.generate_order_reference();
      exit when not exists (select 1 from public.orders o where o.reference_code = new.reference_code);
    end loop;
  end if;
  return new;
end;
$$;

create trigger orders_set_reference_code
  before insert on public.orders
  for each row execute function public.orders_reference_code_trigger();
