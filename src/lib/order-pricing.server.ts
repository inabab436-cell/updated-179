/**
 * ORDER PRICING — turns the raw order lines into PRICED lines and a final
 * total, using the exact same deterministic offer engine the agent must call
 * before quoting anything.
 *
 * Why this exists: orders used to be stored without any price at all
 * (`total_price` null, items with only name/color/size/quantity). Because of
 * that, no offer could ever be recorded for a customer — the redemption check
 * compares the order value against the offer minimum, and the value was always
 * zero. The discount the agent quoted was also lost.
 *
 * Server-only. Never import from client code.
 */
import { quoteCart, type CartLine, type CartQuote } from "@/lib/offer-engine.server";
import type { OfferRow } from "@/lib/offers.server";

export interface PricingProduct {
  id: string;
  name: string;
  price: number | null;
  currency?: string | null;
  variants?: Array<{ color: string | null; size: string | null; price: number | null }>;
}

export interface RawOrderItem {
  product_name: string | null;
  color: string | null;
  size: string | null;
  quantity: number | null;
  [k: string]: unknown;
}

export interface PricedOrderItem extends RawOrderItem {
  product_id: string | null;
  unit_price: number;
  line_total: number;
}

export interface OrderPricing {
  items: PricedOrderItem[];
  currency: string | null;
  subtotal: number;
  discount_total: number;
  total: number;
  quote: CartQuote;
  applied_offers: Array<{ offer_id: string; title: string; discount_amount: number }>;
}

import { fuzzyPick, matchCatalogLabel } from "./fuzzy-match";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function norm(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ar");
}

/** Unit price of a line: the matching variant price, else the product price. */
export function unitPriceFor(
  product: PricingProduct,
  color: string | null,
  size: string | null,
): number {
  const variants = product.variants ?? [];
  // Resolve the requested colour/size to the catalogue's own wording first, so
  // a different spelling ("لارج" vs "L") still finds the variant's real price
  // instead of silently falling back to the base product price.
  const wantColor = matchCatalogLabel(variants.map((v) => v.color ?? null), color, "color") ?? color;
  const wantSize = matchCatalogLabel(variants.map((v) => v.size ?? null), size, "size") ?? size;
  const match = variants.find(
    (v) =>
      (!wantColor || norm(v.color) === norm(wantColor)) &&
      (!wantSize || norm(v.size) === norm(wantSize)) &&
      v.price != null,
  );
  const price = match?.price ?? product.price ?? 0;
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Prices the order lines and applies the live offers through the engine, so a
 * stored order carries exactly the numbers the customer was quoted.
 */
export function priceOrderItems(opts: {
  products: PricingProduct[];
  offers: OfferRow[];
  items: RawOrderItem[];
}): OrderPricing {
  const currency = opts.products.find((p) => p.currency)?.currency ?? null;
  const priced: PricedOrderItem[] = [];
  const lines: CartLine[] = [];

  for (const it of opts.items ?? []) {
    // Graded name matching: an exact-string miss used to price the line at 0
    // and drop it from the offers engine, so the stored order silently
    // disagreed with the price the customer was quoted.
    const product =
      opts.products.find((p) => norm(p.name) === norm(it.product_name)) ??
      fuzzyPick(opts.products, (p) => p.name, it.product_name, { threshold: 0.5 }).match ??
      null;
    const qty = Number(it.quantity);
    const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const unit = product ? unitPriceFor(product, it.color ?? null, it.size ?? null) : 0;
    priced.push({
      ...it,
      product_id: product ? String(product.id) : null,
      unit_price: unit,
      line_total: round2(unit * quantity),
    });
    if (product && unit > 0) {
      lines.push({
        product_id: String(product.id),
        unit_price: unit,
        quantity,
        name: product.name,
      });
    }
  }

  const quote = quoteCart(opts.offers ?? [], lines, currency);
  return {
    items: priced,
    currency,
    subtotal: quote.subtotal,
    discount_total: quote.discount_total,
    total: quote.total,
    quote,
    applied_offers: quote.offers
      .filter((o) => o.applies)
      .map((o) => ({ offer_id: o.offer_id, title: o.title, discount_amount: o.discount_amount })),
  };
}
