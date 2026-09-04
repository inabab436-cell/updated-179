/**
 * PENDING OFFER USAGE — customers who already got the discount on an order
 * whose payment is NOT confirmed yet.
 *
 * Why it exists: the discount is pinned on the order at pricing time
 * (`orders.applied_offer_ids`), so it stays valid for that order even if the
 * offer's window ends or its limit fills up afterwards. That means the seat is
 * really taken the moment the order is priced — not when the merchant confirms
 * the payment. These pending seats therefore:
 *   - count against the offer's limit (a limited offer is "finished" once the
 *     limit is reached, even while its time window is still open), and
 *   - are shown separately on the offers page so the merchant sees who is
 *     still awaiting payment confirmation.
 *
 * Confirmed usage stays in `offer_redemptions` (the only paid source of truth).
 * Server-only (service-role client).
 */
import { customerKeyOf } from "@/lib/offer-redemptions.server";

export interface PendingOfferUse {
  order_id: string;
  conversation_id: string | null;
  customer_name: string | null;
  customer_key: string;
  order_total: number | null;
  created_at: string;
  /** True when this same customer already has a CONFIRMED redemption. */
  already_confirmed: boolean;
}

export interface PendingOfferUsage {
  /** Unique customers holding a discount on an unconfirmed order. */
  beneficiaries: number;
  /** Unconfirmed orders carrying the discount. */
  uses: number;
  rows: PendingOfferUse[];
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pending (payment not confirmed) usage per offer id, read from the offers the
 * orders themselves recorded.
 */
export async function loadPendingOfferUsage(
  admin: any,
  offerIds: string[],
): Promise<Map<string, PendingOfferUsage>> {
  const out = new Map<string, PendingOfferUsage>();
  const wanted = new Set((offerIds ?? []).filter(Boolean).map(String));
  if (!wanted.size) return out;

  try {
    const { data, error } = await admin
      .from("orders")
      .select(
        "id, conversation_id, customer_id, customer_phone, customer_name, total_price, created_at, payment_status, applied_offer_ids",
      )
      .eq("payment_status", "pending")
      .order("created_at", { ascending: false })
      .limit(5000);
    // Older databases without `applied_offer_ids` simply have no pending seats.
    if (error) return out;

    for (const order of ((data ?? []) as Record<string, unknown>[])) {
      const applied = Array.isArray(order.applied_offer_ids)
        ? (order.applied_offer_ids as unknown[]).map(String).filter(Boolean)
        : [];
      if (!applied.length) continue;
      const row: PendingOfferUse = {
        order_id: String(order.id),
        conversation_id: order.conversation_id ? String(order.conversation_id) : null,
        customer_name: order.customer_name ? String(order.customer_name) : null,
        customer_key: customerKeyOf(order),
        order_total: num(order.total_price),
        created_at: String(order.created_at ?? new Date().toISOString()),
        already_confirmed: false,
      };
      for (const offerId of new Set(applied)) {
        if (!wanted.has(offerId)) continue;
        const entry = out.get(offerId) ?? { beneficiaries: 0, uses: 0, rows: [] };
        entry.rows.push(row);
        out.set(offerId, entry);
      }
    }

    // A customer who already has a confirmed redemption is not a NEW seat, so
    // they are never counted twice against the offer limit.
    const { data: reds } = await admin
      .from("offer_redemptions")
      .select("offer_id, customer_key, order_id")
      .in("offer_id", [...out.keys()]);
    const confirmed = new Map<string, Set<string>>();
    for (const r of ((reds ?? []) as any[])) {
      const key = String(r.offer_id);
      const set = confirmed.get(key) ?? new Set<string>();
      set.add(String(r.customer_key ?? r.order_id));
      confirmed.set(key, set);
    }

    for (const [offerId, entry] of out) {
      const paid = confirmed.get(offerId) ?? new Set<string>();
      for (const row of entry.rows) row.already_confirmed = paid.has(row.customer_key);
      entry.uses = entry.rows.length;
      entry.beneficiaries = new Set(
        entry.rows.filter((r) => !r.already_confirmed).map((r) => r.customer_key),
      ).size;
    }
  } catch {
    return out;
  }
  return out;
}
