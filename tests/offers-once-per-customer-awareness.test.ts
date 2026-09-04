import { describe, it, expect } from "vitest";
import { mapOfferRow, buildOffersBlock, type OffersSnapshot } from "@/lib/offers.server";

const offer = (over: Record<string, unknown> = {}) =>
  mapOfferRow({
    id: "o1",
    title: "عرض الفستان",
    scope: "product",
    product_id: "p-dress",
    discount_type: "percent",
    discount_value: 20,
    usage_limit_type: "once_per_customer",
    is_active: true,
    starts_at: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  });

const names = new Map([["p-dress", "فستان"]]);
const block = (s: Partial<OffersSnapshot>) =>
  buildOffersBlock({ live: [], past: [], ...s } as OffersSnapshot, names, "جنيه");

describe("once-per-customer offer already used", () => {
  it("stays visible to the agent with its real state instead of vanishing", () => {
    const b = block({ consumed: [offer()] });
    expect(b).toContain("عرض الفستان");
    expect(b).toContain("مرة واحدة لكل عميل");
    expect(b).toContain("استفاد منه بالفعل");
  });

  it("forbids quoting it, and requires saying it from the first message", () => {
    const b = block({ consumed: [offer()] });
    expect(b).toContain("ممنوع تحسبها");
    expect(b).toContain("من أول مرة");
  });

  it("never claims a discount exists for this customer", () => {
    const b = block({ consumed: [offer()] });
    expect(b).toContain("لا يوجد أي عرض أو خصم متاح لهذا العميل");
  });

  it("a deleted product hides the consumed offer entirely", () => {
    expect(block({ consumed: [offer({ product_id: "gone" })] })).not.toContain("عرض الفستان");
  });

  it("an offer the customer can still use is not reported as consumed", () => {
    const b = block({ live: [offer({ usage_limit_type: "per_order" })] });
    expect(b).not.toContain("استفاد منه بالفعل");
  });
});
