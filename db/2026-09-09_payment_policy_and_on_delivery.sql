-- =============================================================================
-- CUPAI — Payment policy per method + "cash on delivery is NOT paid".
--
-- 1) payment_methods gains:
--      payment_kind           'online' | 'on_delivery'
--      allow_full_payment     the customer may pay the full amount up-front
--      allow_partial_payment  the customer may pay a deposit / part
--      partial_payment_type   'percent' | 'amount'  (what the deposit is)
--      partial_payment_value  the percentage or the fixed amount
--    The agent must follow these settings literally and never invent terms.
--
-- 2) orders gains payment_kind, copied from the chosen method at creation.
--    payment_status keeps its stock/fulfilment meaning ('confirmed' = stock
--    deducted, order may be prepared). It NEVER meant "the customer paid" for
--    cash on delivery — payment_kind = 'on_delivery' makes that explicit so no
--    UI or agent text can present a cash-on-delivery order as paid.
--
-- Safe to re-run.
-- =============================================================================

alter table public.payment_methods
  add column if not exists payment_kind          text    not null default 'online',
  add column if not exists allow_full_payment    boolean not null default true,
  add column if not exists allow_partial_payment boolean not null default false,
  add column if not exists partial_payment_type  text    not null default 'percent',
  add column if not exists partial_payment_value numeric not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_methods_payment_kind_check') then
    alter table public.payment_methods
      add constraint payment_methods_payment_kind_check
      check (payment_kind in ('online', 'on_delivery'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_methods_partial_type_check') then
    alter table public.payment_methods
      add constraint payment_methods_partial_type_check
      check (partial_payment_type in ('percent', 'amount'));
  end if;
end $$;

-- Existing "cash on delivery" rows become on_delivery.
update public.payment_methods
   set payment_kind = 'on_delivery'
 where payment_kind = 'online'
   and (
     name ilike '%عند الاستلام%'
     or name ilike '%عند الإستلام%'
     or name ilike '%cash on delivery%'
     or name ilike '%COD%'
   );

-- Seed function now marks the default COD method correctly.
create or replace function public.seed_default_payment_methods(_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.payment_methods
    (user_id, name, enabled, behavior, detail_type, detail_value, instructions, sort_order, payment_kind)
  select _user_id, v.name, true, v.behavior, v.detail_type, '', '', v.sort_order, v.payment_kind
  from (values
    ('الدفع عند الاستلام', 'auto',   'none',  0, 'on_delivery'),
    ('فودافون كاش',        'manual', 'phone', 1, 'online'),
    ('اتصالات كاش',        'manual', 'phone', 2, 'online'),
    ('إنستا باي',          'manual', 'text',  3, 'online')
  ) as v(name, behavior, detail_type, sort_order, payment_kind)
  where not exists (
    select 1 from public.payment_methods pm where pm.user_id = _user_id
  );
$$;

-- Orders remember the kind of the method the customer chose.
alter table public.orders
  add column if not exists payment_kind text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_kind_check') then
    alter table public.orders
      add constraint orders_payment_kind_check
      check (payment_kind is null or payment_kind in ('online', 'on_delivery'));
  end if;
end $$;

-- Backfill from the merchant's own method list (match by name).
update public.orders o
   set payment_kind = pm.payment_kind
  from public.merchants m
  join public.payment_methods pm on pm.user_id = m.user_id
 where o.payment_kind is null
   and o.merchant_id = m.id
   and o.payment_method is not null
   and lower(btrim(o.payment_method)) = lower(btrim(pm.name));

update public.orders
   set payment_kind = 'on_delivery'
 where payment_kind is null
   and (payment_method ilike '%عند الاستلام%' or payment_method ilike '%عند الإستلام%'
        or payment_method ilike '%cash on delivery%');
