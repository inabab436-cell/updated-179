-- =============================================================================
-- OFFER QUOTE LOCK — the discount the customer was actually QUOTED.
--
-- Why: the order used to be priced by re-evaluating the live offers at
-- `create_order` time. If the offer ended (or changed) between the quote the
-- customer received and the moment the order was created, the customer was
-- charged the FULL price; and a discount that was never quoted could suddenly
-- appear on the order.
--
-- One row per (conversation, offer) recorded the moment the deterministic offer
-- engine priced that offer for the customer. `create_order` prices the order
-- with these offers ONLY, so:
--   * a discount that was quoted while the offer was live stays on the order,
--     even if the offer ends before the order is created is NOT the case —
--     liveness is checked when the quote is made, not when the order is stored;
--   * a discount that was never quoted can never be applied.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.offer_quotes (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  merchant_id     uuid,
  offer_id        uuid not null references public.offers(id) on delete cascade,
  discount_amount numeric,
  quoted_at       timestamptz not null default now(),
  unique (conversation_id, offer_id)
);

create index if not exists offer_quotes_conversation_idx
  on public.offer_quotes (conversation_id);

grant all on public.offer_quotes to service_role;

alter table public.offer_quotes enable row level security;
-- Server-only table (service role). No policies on purpose.
