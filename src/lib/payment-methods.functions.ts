/**
 * Merchant payment methods: list / create / update / delete.
 * `behavior` decides how the AI agent acts after an order:
 *   auto   → agent continues the conversation normally
 *   manual → agent stops and hands over to the merchant team
 * `detail_type` decides which payment detail field the merchant fills in,
 * and `instructions` holds extra guidance the agent must follow.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  DEFAULT_PAYMENT_POLICY,
  normalizePaymentPolicy,
  type PaymentPolicyFields,
} from "@/lib/payment-policy";

export type PaymentBehavior = "auto" | "manual";
export type PaymentDetailType = "none" | "phone" | "url" | "text";

export interface PaymentMethod extends PaymentPolicyFields {
  id: string;
  name: string;
  enabled: boolean;
  behavior: PaymentBehavior;
  detail_type: PaymentDetailType;
  detail_value: string;
  instructions: string;
  payment_template: string;
  sort_order: number;
}

const SELECT =
  "id, name, enabled, behavior, detail_type, detail_value, instructions, payment_template, sort_order, payment_kind, allow_full_payment, allow_partial_payment, partial_payment_type, partial_payment_value";

function toMethod(r: any): PaymentMethod {
  return { ...(r as PaymentMethod), ...normalizePaymentPolicy(r) };
}

const DEFAULT_METHODS = [
  {
    name: "الدفع عند الاستلام",
    enabled: true,
    behavior: "auto",
    detail_type: "none",
    detail_value: "",
    instructions: "",
    payment_template: "",
    sort_order: 0,
    ...DEFAULT_PAYMENT_POLICY,
    payment_kind: "on_delivery",
  },
  {
    name: "فودافون كاش",
    enabled: true,
    behavior: "manual",
    detail_type: "phone",
    detail_value: "",
    instructions: "",
    payment_template: "",
    sort_order: 1,
    ...DEFAULT_PAYMENT_POLICY,
  },
  {
    name: "اتصالات كاش",
    enabled: true,
    behavior: "manual",
    detail_type: "phone",
    detail_value: "",
    instructions: "",
    payment_template: "",
    sort_order: 2,
    ...DEFAULT_PAYMENT_POLICY,
  },
  {
    name: "إنستا باي",
    enabled: true,
    behavior: "manual",
    detail_type: "text",
    detail_value: "",
    instructions: "",
    payment_template: "",
    sort_order: 3,
    ...DEFAULT_PAYMENT_POLICY,
  },
];


const policySchema = z.object({
  payment_kind: z.enum(["online", "on_delivery"]).default("online"),
  allow_full_payment: z.boolean().default(true),
  allow_partial_payment: z.boolean().default(false),
  partial_payment_type: z.enum(["percent", "amount"]).default("percent"),
  partial_payment_value: z.number().min(0).max(1_000_000_000).default(0),
});

/** Makes the stored policy consistent (COD never carries partial settings, % ≤ 100). */
function sanitizePolicy(p: PaymentPolicyFields): PaymentPolicyFields {
  if (p.payment_kind === "on_delivery") {
    return { ...DEFAULT_PAYMENT_POLICY, payment_kind: "on_delivery" };
  }
  const partialOn = p.allow_partial_payment && p.partial_payment_value > 0;
  let value = partialOn ? p.partial_payment_value : 0;
  if (p.partial_payment_type === "percent" && value > 100) value = 100;
  return {
    payment_kind: "online",
    allow_full_payment: p.allow_full_payment || !partialOn,
    allow_partial_payment: partialOn,
    partial_payment_type: p.partial_payment_type,
    partial_payment_value: value,
  };
}

const detailSchema = z.object({
  detail_type: z.enum(["none", "phone", "url", "text"]).default("none"),
  detail_value: z.string().trim().max(500).default(""),
  instructions: z.string().trim().max(2000).default(""),
  payment_template: z.string().trim().max(2000).default(""),
}).merge(policySchema);

export const listPaymentMethods = createServerFn({ method: "GET" }).handler(
  async (): Promise<PaymentMethod[]> => {
    const { requireUserId } = await import("@/lib/session-guard.server");
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = await requireUserId();
    const admin = getSupabaseAdmin();

    const { data, error } = await admin
      .from("payment_methods")
      .select(SELECT)
      .eq("user_id", userId)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);

    if (!data || data.length === 0) {
      const { data: seeded, error: seedErr } = await admin
        .from("payment_methods")
        .insert(DEFAULT_METHODS.map((m) => ({ ...m, user_id: userId })))
        .select(SELECT);
      if (seedErr) throw new Error(seedErr.message);
      return (seeded ?? []).map(toMethod);
    }
    return (data ?? []).map(toMethod);
  },
);

export const createPaymentMethod = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    detailSchema
      .extend({
        name: z.string().trim().min(2).max(60),
        behavior: z.enum(["auto", "manual"]),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<PaymentMethod> => {
    const { requireUserId } = await import("@/lib/session-guard.server");
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = await requireUserId();
    const admin = getSupabaseAdmin();

    const { count } = await admin
      .from("payment_methods")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);

    const hasDetail = data.detail_type !== "none" && data.detail_value.length > 0;
    const policy = sanitizePolicy(normalizePaymentPolicy(data));

    const { data: row, error } = await admin
      .from("payment_methods")
      .insert({
        user_id: userId,
        name: data.name,
        behavior: data.behavior,
        detail_type: hasDetail ? data.detail_type : "none",
        detail_value: hasDetail ? data.detail_value : "",
        instructions: data.instructions,
        payment_template: data.payment_template,
        ...policy,
        enabled: true,
        sort_order: count ?? 0,
      })
      .select(SELECT)
      .single();
    if (error) throw new Error(error.message);
    return toMethod(row);
  });

export const updatePaymentMethod = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        enabled: z.boolean().optional(),
        behavior: z.enum(["auto", "manual"]).optional(),
        name: z.string().trim().min(2).max(60).optional(),
        detail_type: z.enum(["none", "phone", "url", "text"]).optional(),
        detail_value: z.string().trim().max(500).optional(),
        instructions: z.string().trim().max(2000).optional(),
        payment_template: z.string().trim().max(2000).optional(),
      })
      .merge(policySchema.partial())
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireUserId } = await import("@/lib/session-guard.server");
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = await requireUserId();
    const admin = getSupabaseAdmin();

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.behavior !== undefined) patch.behavior = data.behavior;
    if (data.name !== undefined) patch.name = data.name;
    if (data.instructions !== undefined) patch.instructions = data.instructions;
    if (data.payment_template !== undefined) patch.payment_template = data.payment_template;
    const policyTouched =
      data.payment_kind !== undefined ||
      data.allow_full_payment !== undefined ||
      data.allow_partial_payment !== undefined ||
      data.partial_payment_type !== undefined ||
      data.partial_payment_value !== undefined;
    if (policyTouched) {
      // Merge with the stored policy so a partial patch never resets fields.
      const { data: current } = await admin
        .from("payment_methods")
        .select("payment_kind, allow_full_payment, allow_partial_payment, partial_payment_type, partial_payment_value")
        .eq("id", data.id)
        .eq("user_id", userId)
        .maybeSingle();
      const merged = normalizePaymentPolicy({ ...(current ?? {}), ...stripUndefined(data) });
      Object.assign(patch, sanitizePolicy(merged));
    }
    if (data.detail_type !== undefined) {
      const value = data.detail_value ?? "";
      const hasDetail = data.detail_type !== "none" && value.length > 0;
      patch.detail_type = hasDetail ? data.detail_type : "none";
      patch.detail_value = hasDetail ? value : "";
    } else if (data.detail_value !== undefined) {
      patch.detail_value = data.detail_value;
    }

    const { error } = await admin
      .from("payment_methods")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as any)[k] = v;
  return out;
}

export const deletePaymentMethod = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { requireUserId } = await import("@/lib/session-guard.server");
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = await requireUserId();
    const admin = getSupabaseAdmin();
    const { error } = await admin
      .from("payment_methods")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
