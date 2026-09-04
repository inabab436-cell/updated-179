import { describe, expect, it } from "vitest";

import { buildPaymentConfirmationMessage } from "@/lib/merchant-data.server";

describe("buildPaymentConfirmationMessage", () => {
  it("registers a manual-payment order immediately without asking for later proof", () => {
    const message = buildPaymentConfirmationMessage(
      {
        id: "pm-1",
        name: "فودافون كاش",
        behavior: "manual",
        detail_type: "phone",
        detail_value: "01000000000",
        instructions: "ديبوزت 20% والباقي عند الاستلام",
        payment_template: "",
      },
      { orderNumber: "ORD-1" },
    );

    expect(message).toContain("تم تسجيل طلبك");
    expect(message).toContain("01000000000");
    expect(message).toContain("ديبوزت 20%");
    expect(message).not.toContain("لقطة شاشة");
    expect(message).not.toContain("لما التحويل");
    expect(message).not.toContain("نستكمل الطلب");
  });
});