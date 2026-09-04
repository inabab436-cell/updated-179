-- =============================================================================
-- CUPAI — FIX: the beneficiary counter did not move after confirming the payment
-- of an order that really carried a discount.
--
-- Cause: record_order_offer_redemptions re-evaluated the offer at confirmation
-- time (time window, max_redemptions cap, product-name match, and
-- min_order_total compared against the ALREADY DISCOUNTED total_price). Any of
-- those made a real beneficiary silently skipped.
--
-- Rule: when the ORDER itself records which offers were applied
-- (orders.applied_offer_ids, written at pricing time), those offers are counted
-- unconditionally — the customer really got the discount. The old
-- re-evaluation stays only as a fallback for older, price-less orders.
--
-- Idempotent through unique (offer_id, order_id). Safe to re-run.
-- =============================================================================

create or replace function public.record_order_offer_redemptions(
  p_order_id    uuid,
  p_merchant_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        public.orders;
  v_user_id      uuid;
  v_total        numeric;
  v_key          text;
  v_offer        record;
  v_applies      boolean;
  v_already_used boolean;
  v_inserted     integer;
  v_recorded     integer := 0;
  v_applied      uuid[];
begin
  select * into v_order
  from public.orders
  where id = p_order_id and merchant_id = p_merchant_id;
  if not found then
    return 0;
  end if;

  -- Never count an order that is not actually paid.
  if coalesce(v_order.payment_status, 'confirmed') <> 'confirmed' then
    return 0;
  end if;
  if v_order.status = 'cancelled' then
    return 0;
  end if;

  select m.user_id into v_user_id from public.merchants m where m.id = p_merchant_id;
  if v_user_id is null then
    return 0;
  end if;

  v_total := public.order_total_value(v_order);
  v_key   := public.order_customer_key(v_order);

  begin
    select array_agg(x::uuid)
      into v_applied
      from jsonb_array_elements_text(coalesce(v_order.applied_offer_ids, '[]'::jsonb)) x
     where coalesce(btrim(x), '') <> '';
  exception when others then
    v_applied := null;  -- column missing on older databases
  end;

  -- ---------------------------------------------------------------------------
  -- 1. Offers PINNED on the order: counted without any re-evaluation.
  -- ---------------------------------------------------------------------------
  if v_applied is not null and array_length(v_applied, 1) > 0 then
    for v_offer in
      select o.*
      from public.offers o
      where o.user_id = v_user_id
        and o.id = any(v_applied)
      order by o.id
      for update of o
    loop
      insert into public.offer_redemptions (
        offer_id, order_id, conversation_id, customer_name, order_total, customer_key
      ) values (
        v_offer.id, v_order.id, v_order.conversation_id, v_order.customer_name, v_total, v_key
      )
      on conflict (offer_id, order_id) do nothing;

      get diagnostics v_inserted = row_count;
      v_recorded := v_recorded + coalesce(v_inserted, 0);

      update public.offers o
        set redemption_count = stats.uses,
            beneficiary_count = stats.customers
      from (
        select count(*)::integer as uses,
               count(distinct coalesce(r.customer_key, r.order_id::text))::integer as customers
        from public.offer_redemptions r
        where r.offer_id = v_offer.id
      ) stats
      where o.id = v_offer.id
        and (o.redemption_count is distinct from stats.uses
          or o.beneficiary_count is distinct from stats.customers);
    end loop;

    return v_recorded;
  end if;

  -- ---------------------------------------------------------------------------
  -- 2. Fallback for orders that never recorded their applied offers.
  -- ---------------------------------------------------------------------------
  for v_offer in
    select o.*, p.name as product_name
    from public.offers o
    left join public.products p on p.id = o.product_id
    where o.user_id = v_user_id
      and o.is_active is not false
      and coalesce(o.starts_at, now()) <= now()
      and (o.ends_at is null or o.ends_at > now())
      and (
        o.max_redemptions is null
        or o.max_redemptions <= 0
        or coalesce(o.beneficiary_count, 0) < o.max_redemptions
      )
    order by o.id
    for update of o
  loop
    if v_offer.min_order_total is not null and v_total < v_offer.min_order_total then
      continue;
    end if;

    if coalesce(v_offer.scope, 'product') = 'all' then
      v_applies := true;
    elsif coalesce(btrim(v_offer.product_name), '') = '' then
      v_applies := false;
    else
      select exists (
        select 1
        from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) it
        where lower(btrim(coalesce(it->>'product_name', ''))) = lower(btrim(v_offer.product_name))
      ) into v_applies;
    end if;
    if not v_applies then
      continue;
    end if;

    select exists (
      select 1 from public.offer_redemptions r
      where r.offer_id = v_offer.id and r.customer_key = v_key
    ) into v_already_used;
    if coalesce(v_offer.usage_limit_type, 'per_order') = 'once_per_customer' and v_already_used then
      continue;
    end if;

    insert into public.offer_redemptions (
      offer_id, order_id, conversation_id, customer_name, order_total, customer_key
    ) values (
      v_offer.id, v_order.id, v_order.conversation_id, v_order.customer_name, v_total, v_key
    )
    on conflict (offer_id, order_id) do nothing;

    get diagnostics v_inserted = row_count;
    v_recorded := v_recorded + coalesce(v_inserted, 0);

    update public.offers o
      set redemption_count = stats.uses,
          beneficiary_count = stats.customers
    from (
      select count(*)::integer as uses,
             count(distinct coalesce(r.customer_key, r.order_id::text))::integer as customers
      from public.offer_redemptions r
      where r.offer_id = v_offer.id
    ) stats
    where o.id = v_offer.id
      and (o.redemption_count is distinct from stats.uses
        or o.beneficiary_count is distinct from stats.customers);
  end loop;

  return v_recorded;
end;
$$;

grant execute on function public.record_order_offer_redemptions(uuid, uuid) to service_role;
