import { describe, it, expect } from "vitest";
import { mergeOfferIds, pricingOffers } from "@/lib/offer-quote-lock.server";
import { mapOfferRow } from "@/lib/offers.server";
import { priceOrderItems } from "@/lib/order-pricing.server";

const dress = {
  id: "p-dress",
  name: "فستان",
  price: 100,
  currency: "جنيه",
  variants: [],
};

const offerRow = (over: Record<string, unknown> = {}) =>
  mapOfferRow({
    id: "o1",
    user_id: "u1",
    title: "عرض",
    scope: "product",
    product_id: "p-dress",
    discount_type: "percent",
    discount_value: 50,
    is_active: true,
    starts_at: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  });

const item = (qty = 1) => ({ product_name: "فستان", color: null, size: null, quantity: qty });

describe("quoted offer ids", () => {
  it("merges without duplicates and drops blanks", () => {
    expect(mergeOfferIds(["a", "", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeOfferIds(null, undefined)).toEqual([]);
  });
});

describe("which offers may price an order", () => {
  const live = [offerRow({ id: "live" })];

  it("falls back to the live offers when nothing was quoted", () => {
    expect(pricingOffers({ lockedIds: [], lockedOffers: [], liveOffers: live })).toBe(live);
  });

  it("keeps a quoted offer that has since ended", () => {
    const expired = offerRow({ id: "o1", ends_at: new Date(Date.now() - 60_000).toISOString() });
    const chosen = pricingOffers({ lockedIds: ["o1"], lockedOffers: [expired], liveOffers: [] });
    expect(chosen.map((o) => o.id)).toEqual(["o1"]);
    const priced = priceOrderItems({ products: [dress], offers: chosen, items: [item()] });
    expect(priced.discount_total).toBe(50);
    expect(priced.total).toBe(50);
    expect(priced.applied_offers[0]!.offer_id).toBe("o1");
  });

  it("never applies a live offer that was never quoted", () => {
    const quoted = offerRow({ id: "o1", discount_value: 10 });
    const unquoted = offerRow({ id: "o2", discount_value: 90 });
    const chosen = pricingOffers({
      lockedIds: ["o1"],
      lockedOffers: [quoted, unquoted],
      liveOffers: [quoted, unquoted],
    });
    expect(chosen.map((o) => o.id)).toEqual(["o1"]);
    const priced = priceOrderItems({ products: [dress], offers: chosen, items: [item()] });
    expect(priced.discount_total).toBe(10);
  });

  it("an offer that ended BEFORE any quote is never locked, so no discount", () => {
    const priced = priceOrderItems({
      products: [dress],
      offers: [], // live snapshot excludes it, and nothing was quoted
      items: [item()],
    });
    expect(priced.discount_total).toBe(0);
    expect(priced.total).toBe(100);
  });
});

describe("once-per-customer guard", () => {
  it("drops an offer the customer already used, keeps per-order offers", async () => {
    const { dropConsumedOnceOffers } = await import("@/lib/offer-quote-lock.server");
    const once = { id: "a", usage_limit_type: "once_per_customer" } as any;
    const per = { id: "b", usage_limit_type: "per_order" } as any;
    expect(dropConsumedOnceOffers([once, per], ["a"]).map((o: any) => o.id)).toEqual(["b"]);
    expect(dropConsumedOnceOffers([once, per], []).length).toBe(2);
  });
});
