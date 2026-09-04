-- ============================================================================
-- 2026-09-10 — Offers: merchant-chosen display fields + ATOMIC seat claiming
--
-- 1. offers.display_fields
--    Which extra facts the merchant wants shown next to the discount on the
--    customer-facing order screens (beyond "price after discount" and
--    "discount value", which are always shown).
--    Allowed values: 'countdown', 'remaining', 'usage_type', 'title',
--    'min_order_total'.
--
-- 2. claim_offer_seats(...)
--    A limited offer (max_redemptions) must never be granted to more
--    customers than allowed, even when several orders are created at the very
--    same moment. Every claim locks the offer row (SELECT ... FOR UPDATE), so
--    concurrent claims are serialised and the caps are evaluated on the latest
--    committed state: confirmed redemptions + seats pinned on orders that are
--    still awaiting payment confirmation.
-- ============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS display_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.offers.display_fields IS
  'Extra facts shown next to the discount on customer-facing screens.';

CREATE OR REPLACE FUNCTION public.claim_offer_seats(
  p_offer_ids uuid[],
  p_customer_key text,
  p_order_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_offer        public.offers%ROWTYPE;
  v_id           uuid;
  v_granted      uuid[] := '{}';
  v_keys         text[];
  v_uses         integer;
  v_already      boolean;
BEGIN
  IF p_offer_ids IS NULL OR array_length(p_offer_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('granted', '[]'::jsonb);
  END IF;

  FOREACH v_id IN ARRAY p_offer_ids LOOP
    SELECT * INTO v_offer FROM public.offers WHERE id = v_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;

    -- Every identity that already holds a seat: confirmed redemptions plus
    -- seats pinned on orders awaiting payment confirmation (this order is
    -- excluded — it is the one being decided right now).
    SELECT coalesce(array_agg(DISTINCT k), '{}') INTO v_keys
    FROM (
      SELECT r.customer_key AS k
        FROM public.offer_redemptions r
       WHERE r.offer_id = v_id
         AND (p_order_id IS NULL OR r.order_id IS DISTINCT FROM p_order_id)
      UNION ALL
      SELECT coalesce(
               nullif('c:' || coalesce(o.customer_id::text, ''), 'c:'),
               nullif('p:' || coalesce(o.customer_phone, ''), 'p:'),
               nullif('v:' || coalesce(o.conversation_id::text, ''), 'v:'),
               'o:' || o.id::text
             ) AS k
        FROM public.orders o
       WHERE o.applied_offer_ids ? v_id::text
         AND coalesce(o.payment_status, 'confirmed') <> 'confirmed'
         AND (p_order_id IS NULL OR o.id IS DISTINCT FROM p_order_id)
    ) s;

    SELECT count(*) INTO v_uses
    FROM (
      SELECT r.id FROM public.offer_redemptions r
       WHERE r.offer_id = v_id
         AND (p_order_id IS NULL OR r.order_id IS DISTINCT FROM p_order_id)
      UNION ALL
      SELECT o.id FROM public.orders o
       WHERE o.applied_offer_ids ? v_id::text
         AND coalesce(o.payment_status, 'confirmed') <> 'confirmed'
         AND (p_order_id IS NULL OR o.id IS DISTINCT FROM p_order_id)
    ) u;

    v_already := p_customer_key = ANY (v_keys);

    -- Once per customer: a customer who already benefited never gets it again.
    IF v_offer.usage_limit_type = 'once_per_customer' AND v_already THEN
      CONTINUE;
    END IF;

    -- Hard cap on beneficiaries AND on total uses.
    IF v_offer.max_redemptions IS NOT NULL AND v_offer.max_redemptions > 0 THEN
      IF (NOT v_already AND coalesce(array_length(v_keys, 1), 0) >= v_offer.max_redemptions)
         OR v_uses >= v_offer.max_redemptions THEN
        CONTINUE;
      END IF;
    END IF;

    v_granted := array_append(v_granted, v_id);
  END LOOP;

  RETURN jsonb_build_object(
    'granted',
    coalesce((SELECT jsonb_agg(x::text) FROM unnest(v_granted) x), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_offer_seats(uuid[], text, uuid) TO service_role;
