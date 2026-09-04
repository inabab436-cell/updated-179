import { describe, expect, it } from "vitest";

import { buildLiveAvailabilityBlock } from "@/lib/order-availability";
import {
  scrubAgainstInternalContext,
  stripInternalMarkers,
} from "@/lib/reply-egress-guard";

const internalBlock = buildLiveAvailabilityBlock({
  status: "ok",
  verified: [],
  available: 3,
  requested: 1,
  inStockColors: ["أسود"],
  inStockSizes: ["L"],
  message: "",
} as never);

describe("internal section markers never reach the customer", () => {
  it("removes the closing counterpart the model invents", () => {
    const reply = "تمام، المنتج متاح.\n[/LIVE AVAILABILITY VERDICT]";
    const out = scrubAgainstInternalContext(reply, [internalBlock], []);
    expect(out).not.toMatch(/LIVE AVAILABILITY VERDICT/i);
    expect(out).toContain("المنتج متاح");
  });

  it("removes the opening marker with its description", () => {
    const reply = `${internalBlock}\nالمقاس L متوفر.`;
    const out = scrubAgainstInternalContext(reply, [internalBlock], []);
    expect(out).not.toMatch(/LIVE AVAILABILITY VERDICT/i);
    expect(out).toContain("المقاس L متوفر");
  });

  it("covers other markers of the same class, present and future", () => {
    for (const tag of [
      "[EXISTING ORDER ADDITION CAPACITY]",
      "[/EXISTING ORDER ADDITION CAPACITY]",
      "[ALREADY-DEDUCTED QUANTITY — computed]",
      "<ACTIVE ORDER STATE>",
      "[/SOME_FUTURE_SECTION]",
    ]) {
      expect(stripInternalMarkers(`أهلاً ${tag}`)).toBe("أهلاً");
    }
  });

  it("keeps legitimate customer-facing text with brackets", () => {
    const reply = "السعر (٢٥٠ جنيه) والمقاس [لارج] متاح.";
    expect(stripInternalMarkers(reply)).toBe(reply);
  });
});
