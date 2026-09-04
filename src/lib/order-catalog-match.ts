/**
 * ORDER ITEM CANONICALIZATION — the missing link between the agent's wording
 * and the stock rows.
 *
 * Stock is deducted inside the database functions (`create_order_with_stock`
 * and `confirm_order_payment`), and those functions find the rows to lock and
 * decrement with an EXACT (lower + trim) comparison against
 * `products.name` / `product_variants.color` / `product_variants.size`.
 *
 * Everything else in the app matches leniently (Arabic normalization, ignoring
 * diacritics, hamza forms, punctuation and spacing), so the agent can write
 * "هودي مخطط" or "أبيض" while the catalogue stores "IKE BRAS هودي مخطط" or
 * "ابيض". In that case:
 *   - the availability pre-check passes (lenient match),
 *   - the order is inserted successfully,
 *   - but the SQL sees NO matching variant → the product looks "not tracked"
 *     → NOTHING is deducted, silently, with no error, for automatic payments
 *     and for the merchant's later manual payment confirmation alike.
 *
 * This module rewrites every order line to the EXACT catalogue strings before
 * the order is stored, so the deduction always finds its rows. It is pure so
 * both entry points (chat agent + storefront checkout) share one behaviour.
 */

import { fuzzyPick, matchCatalogLabel } from "./fuzzy-match";

export interface CatalogVariant {
  color?: string | null;
  size?: string | null;
  stock?: number | null;
}

export interface CatalogProduct {
  id?: string | null;
  name?: string | null;
  variants?: CatalogVariant[] | null;
}

export interface OrderItemLike {
  product_id?: string | null;
  product_name?: string | null;
  color?: string | null;
  size?: string | null;
  quantity?: number | string | null;
  [key: string]: unknown;
}

/** Same lenient normalization used by the availability pre-check. */
export function normKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[يى]/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function pickProduct(
  products: CatalogProduct[],
  item: OrderItemLike,
): CatalogProduct | null {
  const list = products ?? [];
  if (item.product_id) {
    const byId = list.find((p) => p?.id && String(p.id) === String(item.product_id));
    if (byId) return byId;
  }
  const key = normKey(item.product_name);
  if (!key) return null;
  const exact = list.find((p) => normKey(p?.name) === key);
  if (exact) return exact;

  // Graded matching. The previous version returned null as soon as more than
  // one product matched partially, so the order was stored with the agent's
  // own wording and the SQL deduction silently found no variant row: the
  // order existed but stock never moved. Picking the BEST candidate (and, when
  // two are equally close, the one whose stock can actually serve the line)
  // keeps the deduction working instead of failing quietly.
  const picked = fuzzyPick(list, (p) => p?.name, item.product_name, { threshold: 0.5 });
  if (!picked.match) return null;
  if (!picked.ambiguous) return picked.match;

  const top = picked.ranked.filter((r) => r.score >= picked.score - 0.06);
  const serves = top.find((r) => {
    const variants = (r.item?.variants ?? []).filter(Boolean) as CatalogVariant[];
    if (!variants.length) return false;
    const color = matchCatalogLabel(variants.map((v) => v.color ?? null), item.color, "color");
    const size = matchCatalogLabel(variants.map((v) => v.size ?? null), item.size, "size");
    return (!item.color || !!color) && (!item.size || !!size);
  });
  return (serves?.item ?? picked.match) as CatalogProduct;
}

function pickLabel(
  variants: CatalogVariant[],
  field: "color" | "size",
  requested: unknown,
): string | null {
  const labels = variants.map((v) => (v?.[field] ?? null) as string | null);
  return matchCatalogLabel(labels, requested, field);
}

/**
 * Returns a copy of `items` where `product_name`, `color` and `size` are the
 * EXACT catalogue strings whenever the line can be matched. Unmatched values
 * are left untouched (never invented, never dropped).
 */
export function canonicalizeOrderItems<T extends OrderItemLike>(
  products: CatalogProduct[],
  items: T[],
): T[] {
  return (items ?? []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const product = pickProduct(products ?? [], item);
    if (!product) return item;
    const variants = (product.variants ?? []).filter(Boolean) as CatalogVariant[];
    const next: T = { ...item };
    if (product.name) next.product_name = product.name;
    if (product.id && !next.product_id) next.product_id = String(product.id);
    const color = pickLabel(variants, "color", item.color);
    if (color) next.color = color;
    const size = pickLabel(variants, "size", item.size);
    if (size) next.size = size;
    return next;
  });
}
