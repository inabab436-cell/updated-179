/**
 * Public storefront reads. Resolves a slug via merchants.brand_slug → merchant id,
 * then reads only published rows across products, policies, contact_info,
 * shipping_rates (all keyed by user_id). Uses the admin client server-side; nothing
 * is exposed to the browser except the returned DTOs.
 */
import { fuzzyPick } from "./fuzzy-match";
import { createServerFn } from "@tanstack/react-start";

export interface StorefrontProduct {
  id: string; name: string; description: string | null;
  category: string | null; price: number | null; currency: string | null;
  images: string[]; variants: any[];
}
export interface StorefrontPolicy {
  id: string; kind: string; title: string; content: string;
}
export interface StorefrontContact {
  id: string; kind: string; label: string | null; value: string;
}
export interface StorefrontShipping {
  id: string; country: string | null; region: string | null;
  price: number | null; currency: string | null; eta: string | null; notes: string | null;
}
export interface StorefrontPaymentMethod {
  id: string; name: string; behavior: "auto" | "manual";
}
export interface StorefrontData {
  found: boolean;
  slug: string;
  userId: string | null;
  merchantId: string | null;
  brandName: string | null;
  brandDescription: string | null;
  logoUrl: string | null;
  themeKey: string | null;
  sectionsConfig: any;
  products: StorefrontProduct[];
  policies: StorefrontPolicy[];
  contacts: StorefrontContact[];
  shipping: StorefrontShipping[];
  paymentMethods: StorefrontPaymentMethod[];
}


export const getStorefront = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => {
    if (!d?.slug) throw new Error("Missing slug.");
    return { slug: String(d.slug).toLowerCase() };
  })
  .handler(async ({ data }): Promise<StorefrontData> => {
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createSignedUrl } = await import("@/lib/storage.server");
    const admin = getSupabaseAdmin();

    // Single source of truth: merchants (includes sections_config since Phase 4).
    const { data: merchant } = await admin.from("merchants")
      .select("id, user_id, brand_slug, brand_name, description, logo_url, theme_key, site_status, sections_config")
      .eq("brand_slug", data.slug).maybeSingle();
    if (!merchant?.id || (merchant as any).site_status === "unpublished") {
      return {
        found: false, slug: data.slug, userId: null, merchantId: null, brandName: null,
        brandDescription: null, logoUrl: null, themeKey: null,
        sectionsConfig: null, products: [], policies: [], contacts: [], shipping: [],
        paymentMethods: [],

      };
    }
    // Content rows (products/policies/…) are keyed by the auth user id, NOT
    // by merchants.id. Use merchants.user_id everywhere below.
    const userId = String((merchant as any).user_id);
    const merchantId = String(merchant.id);


    const [pR, polR, cR, shR, imgR] = await Promise.all([
      admin.from("products")
        .select("id,name,description,category,price,currency,images,variants")
        .eq("user_id", userId).eq("is_published", true).order("category").order("name"),
      admin.from("policies")
        .select("id,kind,title,content")
        .eq("user_id", userId).eq("is_published", true).order("kind"),
      admin.from("contact_info")
        .select("id,kind,label,value")
        .eq("user_id", userId).eq("is_published", true).order("kind"),
      admin.from("shipping_rates")
        .select("id,country,region,price,currency,eta,notes")
        .eq("user_id", userId).eq("is_published", true).order("country", { nullsFirst: false }),
      admin.from("product_images").select("product_id, url, position")
        .eq("user_id", userId).order("position", { ascending: true }),
    ]);

    const productRows = pR.data ?? [];
    const pidToImgUrls = new Map<string, string[]>();
    for (const r of imgR.data ?? []) {
      const pid = String((r as any).product_id);
      const arr = pidToImgUrls.get(pid) ?? [];
      if ((r as any).url) arr.push(String((r as any).url));
      pidToImgUrls.set(pid, arr);
    }

    // Canonical variants come from product_variants; fall back to the legacy
    // products.variants jsonb only when no rows exist yet.
    const { fetchVariantsByProductIds } = await import("@/lib/product-variants.server");
    const variantsByPid = await fetchVariantsByProductIds(
      admin,
      productRows.map((p: any) => String(p.id)),
    );

    const products: StorefrontProduct[] = await Promise.all(productRows.map(async (p: any) => {
      const raw: string[] = [];
      if (Array.isArray(p.images)) for (const x of p.images) {
        const u = typeof x === "string" ? x : x?.url;
        if (typeof u === "string") raw.push(u);
      }
      // Note: products.image_urls does not exist in this schema; images come from
      // products.images (jsonb) and product_images (rows). See fix 2026-07-25.

      raw.push(...(pidToImgUrls.get(String(p.id)) ?? []));
      const resolved = await Promise.all(raw.map(async (u) => {
        if (/^https?:/i.test(u) || /^data:/i.test(u)) return u;
        try { return await createSignedUrl(u, 60 * 60); } catch { return null; }
      }));
      const images = Array.from(new Set(resolved.filter((u): u is string => !!u)));
      const canonical = variantsByPid.get(String(p.id)) ?? [];
      const variants = canonical.length > 0
        ? canonical
        : (Array.isArray(p.variants) ? p.variants : []);
      return {
        id: String(p.id), name: String(p.name ?? ""),
        description: p.description ?? null, category: p.category ?? null,
        price: p.price ?? null, currency: p.currency ?? null,
        images, variants,
      };
    }));

    // Enabled payment methods — same source the chat agent uses.
    const { loadEnabledPaymentMethods } = await import("@/lib/merchant-data.server");
    const pmRows = await loadEnabledPaymentMethods(admin as any, userId);

    return {
      found: true, slug: data.slug, userId, merchantId,
      brandName: merchant.brand_name ?? null,
      brandDescription: (merchant as any).description ?? null,
      logoUrl: (merchant as any).logo_url ?? null,
      themeKey: (merchant as any).theme_key ?? null,
      sectionsConfig: (merchant as any)?.sections_config ?? null,
      products,
      policies: (polR.data ?? []) as StorefrontPolicy[],
      contacts: (cR.data ?? []) as StorefrontContact[],
      shipping: (shR.data ?? []) as StorefrontShipping[],
      // Only safe fields: payment details/instructions stay server-side and are
      // returned with the confirmation message after the order is created.
      paymentMethods: pmRows.map((m) => ({ id: m.id, name: m.name, behavior: m.behavior })),
    };
  });


export interface CartItemInput {
  productId: string; name: string; price: number | null;
  currency: string | null; quantity: number;
  color?: string | null; size?: string | null;
}
export interface OrderInput {
  slug: string;
  items: CartItemInput[];
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  notes: string;
  shipping_rate_id?: string | null;
  payment_method?: string | null;
  /** Persistent visitor id (same one the chat page uses) for the handover. */
  visitor_id?: string | null;
}
export interface StorefrontOrderShortage {
  product_name: string | null;
  color: string | null;
  size: string | null;
  requested: number | null;
  available: number | null;
}
/** One applied offer, as the customer-facing screens may show it. */
export interface StorefrontAppliedOffer {
  offer_id: string;
  title: string;
  discount_amount: number;
  ends_at: string | null;
  remaining: number | null;
  usage_limit_type: "once_per_customer" | "per_order";
  min_order_total: number | null;
  display_fields: string[];
}

/** Live quote of the cart, produced by the SAME engine the agent uses. */
export interface StorefrontQuote {
  /** Products total BEFORE any discount. */
  subtotal: number;
  discount: number;
  /** Products total AFTER the discount (shipping excluded). */
  subtotalAfterDiscount: number;
  shipping: number;
  total: number;
  currency: string | null;
  offers: StorefrontAppliedOffer[];
}

export type StorefrontOrderResult =
  | {
      ok: true;
      orderNumber: string;
      subtotal: number;
      discount: number;
      offers: StorefrontAppliedOffer[];
      shipping: number;
      total: number;
      currency: string | null;
      paymentMethod: string | null;
      confirmationMessage: string;
      /** true when the chosen method is manual → payment still pending. */
      requiresPayment: boolean;
      /** Conversation the customer is handed over to for manual payment. */
      conversationId: string | null;
    }
  | { ok: false; error: "insufficient_stock"; shortages: StorefrontOrderShortage[] }
  | { ok: false; error: "login_required"; shortages?: undefined };

/**
 * Availability pre-check for the storefront cart.
 *
 * Called BEFORE the customer starts filling in name / address / payment, so we
 * can tell them right away that a requested quantity is larger than the real
 * stock instead of failing at the very end. It only reads (no locks, no
 * writes); the authoritative check still happens inside the atomic order RPC.
 */
export const checkStorefrontStock = createServerFn({ method: "POST" })
  .inputValidator((d: { slug: string; items: CartItemInput[] }) => {
    if (!d?.slug) throw new Error("Missing slug.");
    return d;
  })
  .handler(
    async ({
      data,
    }): Promise<{ ok: true } | { ok: false; shortages: StorefrontOrderShortage[] }> => {
      const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = getSupabaseAdmin();
      const { data: merchant } = await admin
        .from("merchants")
        .select("id")
        .eq("brand_slug", data.slug.toLowerCase())
        .maybeSingle();
      if (!merchant?.id) throw new Error("Store not found.");
      const items = (data.items ?? []).map((it) => ({
        product_name: it.name,
        color: it.color ?? null,
        size: it.size ?? null,
        quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
      }));
      if (items.length === 0) return { ok: true };
      const { data: res, error } = await admin.rpc("check_order_stock", {
        p_items: items,
        p_merchant_id: String(merchant.id),
      });
      if (error) throw new Error(error.message);
      const r = (res ?? {}) as any;
      if (r.ok === false) {
        return { ok: false, shortages: Array.isArray(r.shortages) ? r.shortages : [] };
      }
      return { ok: true };
    },
  );




/**
 * Live quote of the storefront cart — the ONLY discount logic in the manual
 * order is the agent's own offer engine (`quoteManualOrder`). Nothing here
 * decides eligibility on its own; this is a read-only preview and the exact
 * same computation is re-run at order creation time, so an offer that ends in
 * between is never applied.
 */
export const quoteStorefrontCart = createServerFn({ method: "POST" })
  .inputValidator((d: { slug: string; items: CartItemInput[]; shipping_rate_id?: string | null }) => {
    if (!d?.slug) throw new Error("Missing slug.");
    return d;
  })
  .handler(async ({ data }): Promise<StorefrontQuote> => {
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { quoteManualOrder } = await import("@/lib/manual-order-offers.server");
    const admin = getSupabaseAdmin();

    const { data: merchant } = await admin
      .from("merchants")
      .select("id, user_id")
      .eq("brand_slug", data.slug.toLowerCase())
      .maybeSingle();
    if (!merchant?.id) throw new Error("Store not found.");
    const merchantId = String(merchant.id);
    const userId = (merchant as any).user_id ? String((merchant as any).user_id) : null;

    let shipping = 0;
    let shippingCurrency: string | null = null;
    if (data.shipping_rate_id && userId) {
      const { data: sh } = await admin
        .from("shipping_rates")
        .select("price, currency")
        .eq("id", data.shipping_rate_id)
        .eq("user_id", userId)
        .eq("is_published", true)
        .maybeSingle();
      const p = Number((sh as any)?.price ?? 0);
      shipping = Number.isFinite(p) && p > 0 ? p : 0;
      shippingCurrency = (sh as any)?.currency ?? null;
    }

    const customerKeys = await storefrontCustomerKeys(merchantId, null);
    const items = (data.items ?? []).map((it) => ({
      product_name: it.name,
      color: it.color ?? null,
      size: it.size ?? null,
      quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
    }));
    const quote = userId
      ? await quoteManualOrder(admin as any, { userId, customerKeys, items })
      : null;

    const subtotal = quote?.subtotal ?? 0;
    const discount = quote?.discount_total ?? 0;
    const afterDiscount = Math.round((subtotal - discount) * 100) / 100;
    return {
      subtotal,
      discount,
      subtotalAfterDiscount: afterDiscount,
      shipping,
      total: Math.round((afterDiscount + shipping) * 100) / 100,
      currency: quote?.currency ?? shippingCurrency,
      offers: (quote?.applied_offers ?? []) as StorefrontAppliedOffer[],
    };
  });

/**
 * Every identity this customer may have redeemed an offer under, so a
 * "once per customer" offer can never come back for the same person.
 */
async function storefrontCustomerKeys(
  merchantId: string,
  phone: string | null,
): Promise<string[]> {
  const keys: string[] = [];
  try {
    const { getCurrentCustomerSession } = await import("@/lib/customer-auth.server");
    const s = await getCurrentCustomerSession();
    if (s && s.merchantId === merchantId) keys.push(`c:${s.customerId}`);
  } catch {
    /* signed out — phone only */
  }
  const p = (phone ?? "").trim();
  if (p) keys.push(`p:${p}`);
  return keys;
}

/**
 * Creates a storefront order through the SAME atomic path the chat agent uses:
 * `create_order_with_stock` locks the matching product_variants rows, verifies
 * the LATEST committed stock, deducts it and inserts the order in one
 * transaction — so a stale stock number in the browser can never oversell.
 */
export const createStorefrontOrder = createServerFn({ method: "POST" })
  .inputValidator((d: OrderInput) => {
    if (!d?.slug) throw new Error("Missing slug.");
    if (!Array.isArray(d.items) || d.items.length === 0) throw new Error("Cart is empty.");
    if (!d.customer_name?.trim() || !d.customer_phone?.trim())
      throw new Error("Customer name and phone are required.");
    if (!d.customer_address?.trim()) throw new Error("Address is required.");
    return d;
  })
  .handler(async ({ data }): Promise<StorefrontOrderResult> => {
    const { getSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      newOrderNumber,
      computeOrderTotals,
      buildOrderNotes,
      paymentDeductionPlan,
    } = await import("@/lib/storefront-order.server");
    const { loadEnabledPaymentMethods, buildPaymentConfirmationMessage } = await import(
      "@/lib/merchant-data.server"
    );
    const admin = getSupabaseAdmin();

    const { data: merchant } = await admin.from("merchants")
      .select("id, user_id").eq("brand_slug", data.slug.toLowerCase()).maybeSingle();
    if (!merchant?.id) throw new Error("Store not found.");
    const merchantId = String(merchant.id);
    const userId = (merchant as any).user_id ? String((merchant as any).user_id) : null;

    // Payment method must be one of the merchant's ENABLED methods (same rule
    // as the chat agent). If the merchant has none configured, it stays null.
    const methods = await loadEnabledPaymentMethods(admin as any, userId);
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("ar");
    const rawPayment = (data.payment_method ?? "").trim();
    const chosenMethod =
      methods.find((m) => norm(m.name) === norm(rawPayment)) ??
      fuzzyPick(methods, (m) => m.name, rawPayment, { threshold: 0.6 }).match ??
      null;
    if (methods.length > 0 && !chosenMethod) throw new Error("طريقة الدفع غير صحيحة.");

    // Shipping zone: resolved server-side from published shipping_rates so the
    // price can never be spoofed by the browser.
    let shippingRow: any = null;
    if (data.shipping_rate_id && userId) {
      const { data: sh } = await admin.from("shipping_rates")
        .select("id, country, region, price, currency, eta")
        .eq("id", data.shipping_rate_id)
        .eq("user_id", userId)
        .eq("is_published", true)
        .maybeSingle();
      shippingRow = sh ?? null;
      if (!shippingRow) throw new Error("منطقة الشحن غير صحيحة.");
    }
    const shippingLabel = shippingRow
      ? [shippingRow.country, shippingRow.region].filter(Boolean).join(" / ") || "الشحن"
      : null;

    // Items in the shape every consumer (dashboard, RPC, chat) expects.
    const items = data.items.map((it) => ({
      productId: it.productId,
      // The stock RPCs (cupai_resolve_product) read snake_case `product_id`.
      product_id: it.productId,
      product_name: it.name,
      name: it.name,
      price: it.price,
      currency: it.currency,
      quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
      color: it.color ?? null,
      size: it.size ?? null,
    }));

    // No order can ever be created for an unregistered customer: the order is
    // always linked to the signed-in (email + OTP) customer of THIS merchant.
    let customerId: string | null = null;
    try {
      const { getCurrentCustomerSession } = await import("@/lib/customer-auth.server");
      const s = await getCurrentCustomerSession();
      if (s && s.merchantId === merchantId) customerId = s.customerId;
    } catch { /* handled below */ }
    if (!customerId) return { ok: false, error: "login_required" };

    // ---- DISCOUNTS -------------------------------------------------------
    // Re-evaluated HERE, at creation time, by the agent's own offer engine:
    // offer state, time window, usage limits, customer eligibility, products
    // and quantities. Whatever the browser was showing is irrelevant — if the
    // offer ended or the customer is no longer eligible, no discount applies.
    const { quoteManualOrder, claimOfferSeats } = await import(
      "@/lib/manual-order-offers.server"
    );
    const customerKey = `c:${customerId}`;
    const customerKeys = [customerKey, `p:${data.customer_phone.trim()}`];
    const quoteItems = items.map((it) => ({
      product_name: it.product_name,
      color: it.color,
      size: it.size,
      quantity: it.quantity,
    }));
    let quote = userId
      ? await quoteManualOrder(admin as any, { userId, customerKeys, items: quoteItems })
      : null;

    // The seats of every applied offer are reserved atomically (the database
    // locks the offer rows), so simultaneous orders can never push a limited
    // offer past its maximum. An offer that lost the race is dropped and the
    // cart is re-priced without it.
    if (quote && quote.applied_offers.length) {
      const granted = await claimOfferSeats(admin as any, {
        offerIds: quote.applied_offers.map((o) => o.offer_id),
        customerKey,
      });
      if (granted.length !== quote.applied_offers.length && userId) {
        quote = await quoteManualOrder(admin as any, {
          userId,
          customerKeys,
          items: quoteItems,
          restrictToOfferIds: granted,
        });
      }
    }

    // Catalogue prices win over anything the browser sent.
    if (quote) {
      for (let i = 0; i < items.length; i++) {
        const priced = quote.pricing.items[i];
        if (!priced) continue;
        items[i].price = priced.unit_price;
        (items[i] as any).unit_price = priced.unit_price;
        (items[i] as any).line_total = priced.line_total;
      }
    }

    const discount = quote?.discount_total ?? 0;
    const baseTotals = computeOrderTotals(
      items,
      shippingRow?.price ?? null,
      shippingRow?.currency ?? null,
    );
    const subtotalBefore = quote?.subtotal ?? baseTotals.subtotal;
    const totals = {
      ...baseTotals,
      subtotal: subtotalBefore,
      currency: quote?.currency ?? baseTotals.currency,
      total: Math.round((subtotalBefore - discount + baseTotals.shipping) * 100) / 100,
    };
    const appliedOffers = (quote?.applied_offers ?? []) as StorefrontAppliedOffer[];
    const appliedOfferIds = appliedOffers.map((o) => o.offer_id);

    const notes = [
      buildOrderNotes({
        customerNotes: data.notes,
        shippingLabel,
        paymentMethod: chosenMethod?.name ?? null,
        totals: { ...totals, subtotal: subtotalBefore },
      }),
      discount > 0
        ? `الخصم: ${discount} ${totals.currency ?? ""}`.trim() +
          (appliedOffers.length
            ? `\nالعروض المطبّقة: ${appliedOffers.map((o) => o.title).join("، ")}`
            : "")
        : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);

    // Manual payment method → NOTHING is deducted now. The order is stored as
    // payment_status = 'pending' and stock is only taken when the merchant
    // confirms the payment. Automatic methods deduct atomically right here.
    const { deductStock, paymentStatus, requiresPayment: isManual } = paymentDeductionPlan(chosenMethod?.behavior);

    let orderNumber = newOrderNumber();
    let attempts = 0;
    const MAX_ATTEMPTS = 25;
    while (true) {
      attempts++;
      const { data: rpcData, error } = await admin.rpc("create_order_with_stock", {
        p_order_number: orderNumber,
        p_customer_name: data.customer_name.trim().slice(0, 200),
        p_customer_phone: data.customer_phone.trim().slice(0, 50),
        p_customer_address: data.customer_address.trim().slice(0, 500),
        p_items: items,
        p_notes: notes,
        p_conversation_id: null,
        p_merchant_id: merchantId,
        p_customer_id: customerId,
        p_payment_method: chosenMethod?.name ?? null,
        p_deduct_stock: deductStock,
        p_payment_status: paymentStatus,


      });
      if (!error) {
        const res = (rpcData ?? {}) as any;
        if (res.ok === false && res.error === "insufficient_stock") {
          // Nothing was written and nothing was deducted.
          return {
            ok: false,
            error: "insufficient_stock",
            shortages: Array.isArray(res.shortages) ? res.shortages : [],
          };
        }
        break;
      }
      const code = (error as any)?.code;
      const msg = String((error as any)?.message ?? "");
      if (code === "23505" && /order_number/i.test(msg) && attempts < MAX_ATTEMPTS) {
        orderNumber = newOrderNumber();
        continue;
      }
      throw new Error(msg || "Order create failed.");
    }

    // Merchant notifications — same channels as a chat order.
    try {
      await admin.from("notifications").insert({
        type: "new_order",
        message: `طلب جديد ${orderNumber}`,
        is_read: false,
      });
    } catch { /* non-fatal */ }

    // The order carries its REAL numbers and the offers that priced it, so the
    // discount can never be recomputed differently later and the beneficiary
    // is recorded even if the offer ends before the payment is confirmed.
    try {
      await admin
        .from("orders")
        .update({ total_price: totals.total })
        .eq("order_number", orderNumber);
      await admin
        .from("orders")
        .update({
          subtotal_price: subtotalBefore,
          discount_amount: discount,
          shipping_cost: totals.shipping,
          applied_offer_ids: appliedOfferIds,
        })
        .eq("order_number", orderNumber);
    } catch {
      /* breakdown columns not present yet */
    }

    // Auto payment method → order stored as paid at creation, so it never goes
    // through the merchant's payment confirmation. Count the offer here.
    if (!isManual) {
      try {
        const { recordOfferRedemptionsForOrderNumbers } = await import(
          "@/lib/offer-redemptions.server"
        );
        await recordOfferRedemptionsForOrderNumbers(admin as any, {
          merchantId,
          orderNumbers: [orderNumber],
        });
      } catch { /* non-fatal */ }
    }

    // Remember the KIND of the chosen method on the order: a cash-on-delivery
    // order is registered, but NOT paid, and must never be shown as paid.
    try {
      await admin
        .from("orders")
        .update({ payment_kind: chosenMethod?.payment_kind ?? null })
        .eq("order_number", orderNumber);
    } catch {
      /* payment_kind column not present yet */
    }

    const confirmationMessage = buildPaymentConfirmationMessage(chosenMethod, {
      deliveryEta: shippingRow?.eta ?? null,
      orderNumber,
    });

    // Manual payment method (Vodafone Cash / InstaPay / any method the merchant
    // marked "يدوي") → the order is NOT paid yet. Hand the customer over to the
    // existing agent conversation, parked with the project's current payment
    // confirmation mechanism. Auto methods finish normally.
    const requiresPayment = isManual;
    let conversationId: string | null = null;
    if (requiresPayment) {
      const { handoverForManualPayment } = await import("@/lib/storefront-handover.server");
      conversationId = await handoverForManualPayment(admin as any, {
        merchantId,
        customerId,
        visitorId: (data.visitor_id ?? "").trim() || null,
        orderNumber,
        paymentMethodName: chosenMethod?.name ?? null,
        confirmationMessage,
      });
    }

    return {
      ok: true,
      orderNumber,
      subtotal: subtotalBefore,
      discount,
      offers: appliedOffers,
      shipping: totals.shipping,
      total: totals.total,
      currency: totals.currency,
      paymentMethod: chosenMethod?.name ?? null,
      confirmationMessage,
      requiresPayment,
      conversationId,
    };
  });

