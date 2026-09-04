import { describe, expect, it } from "vitest";

import {
  ADDITION_CLAIM_CORRECTION,
  buildAdditionClaimJudgeMessages,
  hasPotentialOrderSuccessClaim,
  parseAdditionClaimVerdict,
  shouldJudgeAdditionClaim,
} from "@/lib/order-addition-claim-guard";

const base = {
  hasExistingOrder: true,
  orderRegisteredThisTurn: false,
  correctionsIssued: 0,
  reply: "تمام، ضفتلك قطعة تانية، المطلوب 300 جنيه.",
};

describe("addition claim guard", () => {
  it("judges both first-order and addition claims without a successful write", () => {
    expect(shouldJudgeAdditionClaim(base)).toBe(true);
    expect(shouldJudgeAdditionClaim({ ...base, hasExistingOrder: false })).toBe(true);
    expect(shouldJudgeAdditionClaim({ ...base, orderRegisteredThisTurn: true })).toBe(false);
    expect(shouldJudgeAdditionClaim({ ...base, correctionsIssued: 1 })).toBe(true);
    expect(shouldJudgeAdditionClaim({ ...base, correctionsIssued: 2 })).toBe(false);
    expect(shouldJudgeAdditionClaim({ ...base, reply: "  " })).toBe(false);
  });

  it("prefilters success language but excludes explicit registration failure", () => {
    expect(hasPotentialOrderSuccessClaim("تمام، الأوردر اتسجل خلاص")).toBe(true);
    expect(hasPotentialOrderSuccessClaim("الطلب مؤكد يا فندم")).toBe(true);
    expect(hasPotentialOrderSuccessClaim("معلش، الطلب ما اتسجلش دلوقتي")).toBe(false);
    expect(hasPotentialOrderSuccessClaim("ممكن تختار طريقة الدفع؟")).toBe(false);
  });

  it("reads the verdict strictly", () => {
    expect(parseAdditionClaimVerdict("YES")).toBe(true);
    expect(parseAdditionClaimVerdict(" yes\n")).toBe(true);
    expect(parseAdditionClaimVerdict("NO")).toBe(false);
    expect(parseAdditionClaimVerdict("")).toBe(false);
    expect(parseAdditionClaimVerdict(null)).toBe(false);
    expect(parseAdditionClaimVerdict("maybe")).toBe(false);
  });

  it("passes both sides of the exchange to the judge", () => {
    const msgs = buildAdditionClaimJudgeMessages("ضفتها", "ضيف قطعة");
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toContain("ضيف قطعة");
    expect(msgs[1]!.content).toContain("ضفتها");
  });

  it("forces first orders and additions through the registration path", () => {
    expect(ADDITION_CLAIM_CORRECTION).toContain("create_order");
    expect(ADDITION_CLAIM_CORRECTION).toContain("NEW TOTAL");
    expect(ADDITION_CLAIM_CORRECTION).toContain("first order");
  });
});
