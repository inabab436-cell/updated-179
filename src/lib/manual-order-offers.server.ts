/**
 * MANUAL (STOREFRONT) ORDER PRICING — one single source of truth with the agent.
 *
 * The manual order does NOT own any discount logic. It reuses exactly what the
 * agent uses:
 *   - `loadOffers`      → which offers are live RIGHT NOW for THIS customer
 *                          (active, inside the time window, not sold out —
 *                           pending seats included — and not already consumed
 *                           by this customer for "once per customer" offers).
 *   - `priceOrderItems` → the deterministic offer engine (`quoteCart`) that
 *                          decides eligibility, minimums and the discount.
 *
 * Prices always come from the catalogue (products / product_variants), never
 * from the browser, so a manual order can never be priced with spoofed values
 * and can never disagree with what the agent would quote for the same cart.
 *
 * Server-only (service-role client). Never import from client code.
 */
import type { OfferRow } from "@/lib/offers.server";
import type { PricingProduct, RawOrderItem, OrderPricing } from "@/lib/order-pricing.server";

import {
  OFFER_DISPLAY_FIELDS,
  normalizeDisplayFields,
  type OfferDisplayField,
} from "@/lib/offer-display-fields";

export { OFFER_DISPLAY_FIELDS };
export type { OfferDisplayField };

/** What the customer-facing screens may show about ONE applied offer. */
export interface AppliedOfferView {
  offer_id: string;
  title: string;
  discount_amount: number;
  /** ISO end of the offer, when it has one (for the countdown). */
  ends_at: string | null;
  /** Remaining beneficiaries/uses, null when the offer is unlimited. */
  remaining: number | null;
  usage_limit_type: "once_per_customer" | "per_order";
  min_order_total: number | null;
  display_fields: OfferDisplayField[];
}

export interface ManualOrderQuote {
  subtotal: number;
  discount_total: number;
  /** Products total after discount (shipping NOT included). */
  total: number;
  currency: string | null;
  applied_offers: AppliedOfferView[];
  /** Full engine result (items priced from the catalogue). */
  pricing: OrderPricing;
  /** Live offer rows used for pricing — kept for the seat claim. */
  offers: OfferRow[];
}

export interface ManualOrderItemInput {
  product_name: string | null;
  color?: string | null;
  size?: string | null;
  quantity: number | null;
}

/** Remaining seats of a limited offer (confirmed + pending already counted). */
export function remainingSeats(o: OfferRow): number | null {
  if (o.max_redemptions == null || o.max_redemptions <= 0) return null;
  const beneficiaries = o.beneficiary_count + (o.pending_beneficiary_count ?? 0);
  const uses = o.redemption_count + (o.pending_use_count ?? 0);
  return Math.max(0, o.max_redemptions - Math.max(beneficiaries, uses));
}

export function offerDisplayFields(o: OfferRow): OfferDisplayField[] {
  return normalizeDisplayFields((o as unknown as { display_fields?: unknown }).display_fields);
}

/** Catalogue read used for pricing (canonical variant prices first). */
async function loadPricingProducts(admin: any, userId: string): Promise<PricingProduct[]> {
  const { data: prods } = await admin
    .from("products")
    .select("id, name, price, currency, variants")
    .eq("user_id", userId);
  const list = ((prods ?? []) as any[]).map((p) => ({ ...p, id: String(p.id) }));
  if (!list.length) return [];
  let variantRows: any[] = [];
  try {
    const { data: v } = await admin
      .from("product_variants")
      .select("product_id, color, size, price")
      .in("product_id", list.map((p) => p.id));
    variantRows = (v ?? []) as any[];
  } catch {
    variantRows = [];
  }
  const byPid = new Map<string, Array<{ color: string | null; size: string | null; price: number | null }>>();
  for (const v of variantRows) {
    const pid = String(v.product_id);
    const arr = byPid.get(pid) ?? [];
    arr.push({ color: v.color ?? null, size: v.size ?? null, price: v.price ?? null });
    byPid.set(pid, arr);
  }
  return list.map((p) => {
    const canonical = byPid.get(p.id) ?? [];
    const legacy = Array.isArray(p.variants)
      ? (p.variants as any[]).map((v) => ({
          color: v?.color ?? v?.colour ?? null,
          size: v?.size ?? null,
          price: typeof v?.price === "number" ? v.price : null,
        }))
      : [];
    return {
      id: p.id,
      name: String(p.name ?? ""),
      price: p.price ?? null,
      currency: p.currency ?? null,
      variants: canonical.length ? canonical : legacy,
    } satisfies PricingProduct;
  });
}

/**
 * Prices a manual order EXACTLY like the agent would, at the moment it is
 * called. Every check happens here, live: offer state, time window, usage
 * limits, customer eligibility, products and quantities.
 */
export async function quoteManualOrder(
  admin: any,
  opts: {
    userId: string;
    /** Every identity this customer may have redeemed under. */
    customerKeys: string[];
    items: ManualOrderItemInput[];
    /** Restrict pricing to these offers (used after an atomic seat claim). */
    restrictToOfferIds?: string[] | null;
    now?: number;
  },
): Promise<ManualOrderQuote> {
  const { loadOffers } = await import("@/lib/offers.server");
  const { priceOrderItems } = await import("@/lib/order-pricing.server");

  const now = opts.now ?? Date.now();
  const products = await loadPricingProducts(admin, opts.userId);
  const snapshot = await loadOffers(admin, opts.userId, now, opts.customerKeys);
  let offers = snapshot.live;
  if (opts.restrictToOfferIds) {
    const keep = new Set(opts.restrictToOfferIds.map(String));
    offers = offers.filter((o) => keep.has(o.id));
  }

  const items: RawOrderItem[] = (opts.items ?? []).map((it) => ({
    product_name: it.product_name ?? null,
    color: it.color ?? null,
    size: it.size ?? null,
    quantity: it.quantity ?? 1,
  }));

  const pricing = priceOrderItems({ products, offers, items });
  const byId = new Map(offers.map((o) => [o.id, o]));

  return {
    subtotal: pricing.subtotal,
    discount_total: pricing.discount_total,
    total: pricing.total,
    currency: pricing.currency,
    pricing,
    offers,
    applied_offers: pricing.applied_offers.map((a) => {
      const o = byId.get(a.offer_id);
      return {
        offer_id: a.offer_id,
        title: a.title,
        discount_amount: a.discount_amount,
        ends_at: o?.ends_at ?? null,
        remaining: o ? remainingSeats(o) : null,
        usage_limit_type: o?.usage_limit_type ?? "per_order",
        min_order_total: o?.min_order_total ?? null,
        display_fields: o ? offerDisplayFields(o) : [],
      } satisfies AppliedOfferView;
    }),
  };
}

/**
 * Atomically reserves the seats of the applied offers for this order.
 *
 * The database locks each offer row, so several orders created at the very
 * same moment can never push a limited offer past its maximum. Returns the
 * offer ids that were really granted (possibly fewer than requested).
 */
export async function claimOfferSeats(
  admin: any,
  opts: { offerIds: string[]; customerKey: string; orderId?: string | null },
): Promise<string[]> {
  const ids = (opts.offerIds ?? []).filter(Boolean).map(String);
  if (!ids.length) return [];
  try {
    const { data, error } = await admin.rpc("claim_offer_seats", {
      p_offer_ids: ids,
      p_customer_key: opts.customerKey,
      p_order_id: opts.orderId ?? null,
    });
    if (error) throw error;
    const granted = (data as any)?.granted;
    return Array.isArray(granted) ? granted.map(String) : [];
  } catch {
    // The function is not deployed yet → keep today's behaviour (the offer
    // snapshot already excluded sold-out offers before pricing).
    return ids;
  }
}
