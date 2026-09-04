/**
 * Payment policy + payment kind — shared by the merchant settings UI, the
 * agent prompt and the order views.
 *
 *  payment_kind:
 *    'on_delivery' → cash on delivery. Choosing it NEVER means the customer
 *                    paid; the money is collected when the order is handed
 *                    over. Such an order must never be shown or described as
 *                    "paid".
 *    'online'      → InstaPay / wallets / transfers. The merchant-configured
 *                    policy below says whether full and/or partial payment is
 *                    accepted and exactly how much a partial payment is.
 */

export type PaymentKind = "online" | "on_delivery";
export type PartialPaymentType = "percent" | "amount";

export interface PaymentPolicyFields {
  payment_kind: PaymentKind;
  allow_full_payment: boolean;
  allow_partial_payment: boolean;
  partial_payment_type: PartialPaymentType;
  partial_payment_value: number;
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicyFields = {
  payment_kind: "online",
  allow_full_payment: true,
  allow_partial_payment: false,
  partial_payment_type: "percent",
  partial_payment_value: 0,
};

export function normalizePaymentPolicy(r: Partial<Record<keyof PaymentPolicyFields, unknown>> | null | undefined): PaymentPolicyFields {
  const kind: PaymentKind = r?.payment_kind === "on_delivery" ? "on_delivery" : "online";
  const value = Number(r?.partial_payment_value ?? 0);
  return {
    payment_kind: kind,
    allow_full_payment: r?.allow_full_payment === undefined ? true : Boolean(r.allow_full_payment),
    allow_partial_payment: Boolean(r?.allow_partial_payment),
    partial_payment_type: r?.partial_payment_type === "amount" ? "amount" : "percent",
    partial_payment_value: Number.isFinite(value) && value > 0 ? value : 0,
  };
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

/** Arabic, human wording of the partial amount, e.g. "50% من قيمة الطلب" / "200 جنيه". */
export function partialAmountLabel(p: PaymentPolicyFields, currency = "جنيه"): string {
  if (p.partial_payment_type === "percent") return `${fmtNum(p.partial_payment_value)}% من إجمالي الطلب`;
  return `${fmtNum(p.partial_payment_value)} ${currency}`;
}

/** Short Arabic summary for the settings list. */
export function paymentPolicySummary(p: PaymentPolicyFields): string {
  if (p.payment_kind === "on_delivery") return "الدفع عند الاستلام — العميل يدفع عند تسلّم الطلب، ولا يُعتبر الطلب مدفوعاً قبل ذلك.";
  const parts: string[] = [];
  if (p.allow_full_payment) parts.push("دفع كلي");
  if (p.allow_partial_payment && p.partial_payment_value > 0) parts.push(`دفع جزئي (${partialAmountLabel(p)})`);
  if (!parts.length) return "لم تُحدَّد سياسة دفع بعد.";
  return `المسموح: ${parts.join(" أو ")}.`;
}

/**
 * The strict policy text the AGENT receives for one method. It states only
 * what the merchant configured; nothing else may be assumed.
 */
export function paymentPolicyForAgent(p: PaymentPolicyFields, currency = "جنيه"): string[] {
  if (p.payment_kind === "on_delivery") {
    return [
      "نوع الدفع: عند الاستلام — العميل لا يدفع شيئاً الآن؛ المبلغ كاملاً يُحصَّل عند تسليم الطلب.",
      "اختيار هذه الطريقة لا يعني أن الدفع تم. لا تقل أبداً إن الطلب مدفوع أو إن الدفع تم أو وصل، ولا تطلب تحويلاً أو إثبات دفع.",
    ];
  }
  const lines: string[] = ["نوع الدفع: أونلاين (تحويل/محفظة/إنستا باي)."];
  const full = p.allow_full_payment;
  const partial = p.allow_partial_payment && p.partial_payment_value > 0;
  if (full && partial) {
    lines.push(
      `سياسة الدفع: مسموح الدفع الكلي، ومسموح الدفع الجزئي بقيمة ${partialAmountLabel(p, currency)} بالضبط، ويُدفع الباقي حسب تعليمات المتجر.`,
    );
  } else if (full) {
    lines.push("سياسة الدفع: الدفع الكلي فقط — المبلغ كاملاً مقدماً. الدفع الجزئي أو العربون غير مسموح ولا تعرضه ولا توافق عليه.");
  } else if (partial) {
    lines.push(
      `سياسة الدفع: الدفع الجزئي فقط بقيمة ${partialAmountLabel(p, currency)} بالضبط. لا تطلب المبلغ كاملاً ولا تغيّر هذه القيمة.`,
    );
  } else {
    lines.push("سياسة الدفع: لم يحدد المتجر سياسة (كلي/جزئي). لا تفترض أي شرط؛ التزم بالتعليمات المسجلة فقط.");
  }
  lines.push(
    "التزم بهذه السياسة حرفياً: لا تخترع شروطاً، لا تغيّر المبلغ أو النسبة، ولا تعطِ العميل معلومة تخالف ما هو مسجّل هنا.",
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Order-side helpers: what an order's payment state really is.
// ---------------------------------------------------------------------------

export interface OrderPaymentLike {
  payment_status?: string | null;
  payment_kind?: string | null;
  payment_method?: string | null;
}

const COD_NAME = /عند\s*ال[اإ]ستلام|cash\s*on\s*delivery|\bcod\b/i;

/** True when the order is settled at the door (never "paid" up-front). */
export function isCashOnDeliveryOrder(order: OrderPaymentLike | null | undefined): boolean {
  if (!order) return false;
  if (order.payment_kind === "on_delivery") return true;
  if (order.payment_kind === "online") return false;
  return COD_NAME.test(String(order.payment_method ?? ""));
}

export type OrderPaymentState = "pending" | "on_delivery" | "paid";

/**
 * Real payment state of an order:
 *  - pending      → online method, merchant has not confirmed the payment
 *  - on_delivery  → cash on delivery: nothing paid yet, collected at handover
 *  - paid         → online payment confirmed by the merchant
 */
export function orderPaymentState(order: OrderPaymentLike | null | undefined): OrderPaymentState {
  if (String(order?.payment_status ?? "confirmed") === "pending") return "pending";
  if (isCashOnDeliveryOrder(order)) return "on_delivery";
  return "paid";
}

export const ORDER_PAYMENT_STATE_LABEL_AR: Record<OrderPaymentState, string> = {
  pending: "بانتظار الدفع",
  on_delivery: "الدفع عند الاستلام",
  paid: "مدفوع",
};
