/**
 * Extra facts a merchant can choose to show next to the discount on the
 * customer-facing screens (the manual/storefront order). The price after the
 * discount and the discount value are ALWAYS shown and are not listed here.
 *
 * Client-safe: used by the dashboard offers form and by the storefront.
 */
export type OfferDisplayField =
  | "title"
  | "countdown"
  | "remaining"
  | "usage_type"
  | "min_order_total";

export const OFFER_DISPLAY_FIELDS: Array<{ key: OfferDisplayField; label: string }> = [
  { key: "title", label: "اسم العرض" },
  { key: "countdown", label: "العد التنازلي لانتهاء العرض" },
  { key: "remaining", label: "عدد المستفيدين/الاستخدامات المتبقية" },
  { key: "usage_type", label: "نوع الاستخدام (مرة لكل عميل / كل أوردر)" },
  { key: "min_order_total", label: "الحد الأدنى للطلب" },
];

export function normalizeDisplayFields(raw: unknown): OfferDisplayField[] {
  const allowed = new Set(OFFER_DISPLAY_FIELDS.map((f) => f.key));
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v) as OfferDisplayField).filter((v) => allowed.has(v));
}
