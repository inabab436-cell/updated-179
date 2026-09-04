/**
 * ORDER REGISTRATION CLAIM GUARD.
 *
 * A customer who adds a piece to an order they already have must go through the
 * exact same registration path as the first order: `create_order` writes the
 * addition, the merchant's payment flow decides whether it is paid or waits for
 * a manual confirmation, the orders screen shows it, and a notification is
 * raised.
 *
 * The failure this guards against is purely conversational: the model answers
 * "تمام، ضفتها لحضرتك، المطلوب كذا" WITHOUT ever calling `create_order`. Nothing
 * is written, no "تأكيد الدفع" button appears, no notification arrives, and the
 * agent keeps chatting because no manual-payment handover was triggered.
 *
 * So whenever a turn ends with no successful order tool call, a cheap local
 * candidate check first decides whether the reply could be claiming success.
 * Only those candidates are judged by meaning. This covers BOTH a first order
 * and an addition to an existing order.
 *
 * Pure helpers — no I/O, fully testable.
 */

export interface AdditionClaimCheckInput {
  /** The conversation already carries at least one registered order. */
  hasExistingOrder: boolean;
  /** `create_order` succeeded during THIS turn. */
  orderRegisteredThisTurn: boolean;
  /** How many corrections were already issued in this turn. */
  correctionsIssued: number;
  /** The reply the model wants to send. */
  reply: string;
}

/**
 * Local candidate filter. It deliberately excludes explicit failure/negation,
 * then catches the common Arabic and English ways a representative presents an
 * order as already registered, confirmed, prepared or completed.
 */
export function hasPotentialOrderSuccessClaim(reply: string): boolean {
  const text = String(reply ?? "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (
    /(?:ما|مش|لم|لن)\s+(?:ات?سجل|تسجل|اتأكد|تأكد|تم)|(?:لم|لن)\s+يتم\s+(?:تسجيل|تأكيد)|(?:not|wasn'?t|isn'?t|couldn'?t|failed)\s+(?:saved|registered|confirmed|created)/iu.test(
      text,
    )
  ) {
    return false;
  }
  return /(?:الأوردر|الاوردر|الطلب|order).{0,80}(?:ات?سجل|تسجل|سجلنا|اتأكد|تأكد|مؤكد|متأكد|تم|جاهز|خلص|saved|registered|confirmed|created|placed|ready|complete)|(?:ات?سجل|سجلنا|اتأكد|مؤكد|متأكد|جهزنا|خلصنا|saved|registered|confirmed|created|placed).{0,80}(?:الأوردر|الاوردر|الطلب|order)|(?:ضفت|اضفت|أضفت|زودت|زدت|added|updated).{0,80}(?:قطعه|قطعة|منتج|كميه|كمية|piece|product|quantity)/iu.test(
    text,
  );
}

/** Only spend a judgement call when an unregistered success claim is possible. */
export function shouldJudgeAdditionClaim(input: AdditionClaimCheckInput): boolean {
  if (input.orderRegisteredThisTurn) return false;
  if (input.correctionsIssued >= 2) return false;
  return hasPotentialOrderSuccessClaim(input.reply);
}

/** Judgement prompt: meaning only, one word out. */
export function buildAdditionClaimJudgeMessages(
  reply: string,
  customerText: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You judge whether a store representative falsely presents an order operation as already completed. " +
        "Answer YES when the reply tells the customer, in any wording, that their first order was registered, created, " +
        "confirmed, prepared or completed, OR that an extra product/quantity was added to an existing order, OR asks " +
        "them to pay for an addition as though it exists. Answer NO when the reply only discusses an order, summarizes " +
        "it before approval, asks for a missing detail/payment method/approval, explicitly says registration failed or " +
        "has not happened, or reports the status of an order that was already registered before this turn. Answer with " +
        "exactly YES or NO.",
    },
    {
      role: "user",
      content: `Customer said: ${customerText}\n\nRepresentative reply: ${reply}`,
    },
  ];
}

/** Reads the judge's answer; anything unclear is treated as "no claim". */
export function parseAdditionClaimVerdict(raw: string | null | undefined): boolean {
  return /^\s*yes\b/i.test(String(raw ?? ""));
}

/**
 * Correction pushed back into the model context. It does not write the reply —
 * it forces the registration path so the real payment flow runs.
 */
export const ADDITION_CLAIM_CORRECTION =
  "SYSTEM CORRECTION — NOTHING WAS SAVED THIS TURN. Your draft presents an order or an addition as registered, " +
  "confirmed, completed or payable, but create_order did not succeed in this turn. A customer sentence NEVER creates " +
  "an order. If this is a first order and all required data plus one approval are already present, call create_order NOW. " +
  "If this is an addition, call create_order for the SAME existing order and send the NEW TOTAL quantity of every " +
  "affected line (already recorded 1 + one extra = 2). Use only the payment method the customer chose. If a required " +
  "detail is missing, ask only for that detail and claim no success. After the tool succeeds, reply only from its real " +
  "result and real order number. If the tool fails, state plainly that registration did not complete; never claim that " +
  "it succeeded, is confirmed, is being processed or will be reviewed as though it exists.";

