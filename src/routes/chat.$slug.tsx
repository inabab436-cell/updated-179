import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Send, ArrowRight, User2, Bot, UserCircle2, Paperclip, X, Loader2,
  MapPin, Radio, Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getStorefront } from "@/lib/storefront.functions";
import { getChatConfig } from "@/lib/chat-config.functions";
import { uploadChatImage } from "@/lib/chat-upload.functions";
import {
  LIVE_LOCATION_DURATION_MS,
  LIVE_LOCATION_UPDATE_MS,
  formatLocationSummary,
  isLiveLocationActive,
  mapsUrl,
  type LocationAttachment,
} from "@/lib/chat-location";
import {
  CustomerLoginPanel,
  useCustomerSession,
} from "@/components/customer/customer-login";


export const Route = createFileRoute("/chat/$slug")({
  validateSearch: (s: Record<string, unknown>) => ({
    mode: (s.mode === "new" ? "new" : "continue") as "new" | "continue",
  }),
  head: ({ params }) => ({
    meta: [
      { title: `محادثة — ${params.slug}` },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ChatPage,
});

type ChatAttachment = {
  kind?: string;
  url: string;
  mime?: string | null;
  name?: string | null;
  source?: string | null;
  lat?: number;
  lng?: number;
  accuracy?: number | null;
  label?: string | null;
  live?: boolean;
  updated_at?: string | null;
  expires_at?: string | null;
};

type ChatMessage = {
  id?: string;
  role: "user" | "assistant" | string;
  content: string;
  created_at?: string;
  attachments?: ChatAttachment[] | null;
};

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("المتصفح لا يدعم تحديد الموقع."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      reject(
        new Error(
          err.code === err.PERMISSION_DENIED
            ? "تم رفض إذن الوصول للموقع. فعّله من إعدادات المتصفح."
            : "تعذر تحديد موقعك الآن، حاول مرة أخرى.",
        ),
      );
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("تعذر قراءة الملف."));
    reader.readAsDataURL(file);
  });
}


const VISITOR_KEY = (slug: string) => `cupai_visitor_${slug}`;

function readVisitorId(slug: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(VISITOR_KEY(slug)); } catch { return null; }
}
function writeVisitorId(slug: string, id: string) {
  try { window.localStorage.setItem(VISITOR_KEY(slug), id); } catch {}
}

/** Fetch a persistent visitor id from the server (httpOnly cookie backed). */
async function fetchServerVisitorId(slug: string): Promise<string | null> {
  try {
    const local = readVisitorId(slug);
    const url = local ? `/api/visitor?fallback=${encodeURIComponent(local)}` : "/api/visitor";
    const res = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { visitor_id?: string };
    return j.visitor_id ?? null;
  } catch {
    return null;
  }
}

function useResolvedVisitorId(slug: string) {
  const [visitorId, setVisitorId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const localVid = readVisitorId(slug);
      let vid = await fetchServerVisitorId(slug);
      if (!vid) vid = localVid;
      if (cancelled) return;
      if (vid) writeVisitorId(slug, vid);
      setVisitorId(vid);
    })();
    return () => { cancelled = true; };
  }, [slug]);

  return visitorId;
}

function ChatPage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch() as { mode?: "new" | "continue" };
  const mode: "new" | "continue" = search.mode === "new" ? "new" : "continue";

  const storefront = useQuery({
    queryKey: ["storefront", slug],
    queryFn: () => getStorefront({ data: { slug } }),
  });
  const config = useQuery({
    queryKey: ["chat-config"],
    queryFn: () => getChatConfig(),
    staleTime: Infinity,
  });

  const merchantId = storefront.data?.merchantId ?? null;
  const brandName = storefront.data?.brandName || slug;

  const visitorId = useResolvedVisitorId(slug);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Tracked internally only — never surfaced to the customer in any way.
  const [, setNeedsHuman] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingFile, setPendingFile] = useState<{ file: File; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- Live location sharing -------------------------------------------
  const [locBusy, setLocBusy] = useState(false);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [liveSharing, setLiveSharing] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const liveStopRef = useRef<number | null>(null);
  const lastPushRef = useRef(0);

  const [initErr, setInitErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const chatAiUrl = config.data?.chatAiUrl ?? null;
  const anonKey = config.data?.supabaseAnonKey ?? null;

  const session = useCustomerSession();
  const loggedIn = !!session.data?.loggedIn;
  const customerEmail = session.data?.email ?? null;

  const callEdge = useMemo(() => {
    if (!chatAiUrl || !anonKey) return null;
    return async (body: Record<string, unknown>) => {
      const res = await fetch(chatAiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": anonKey,
          "Authorization": `Bearer ${anonKey}`,
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      return json as {
        conversation_id: string | null;
        needs_human?: boolean;
        messages?: ChatMessage[];
        reply?: string | null;
      };
    };
  }, [chatAiUrl, anonKey]);

  // Initialize conversation. `mode=new` opens a NEW conversation for the
  // SAME visitor — it never rotates the visitor id.
  useEffect(() => {
    if (!callEdge || !merchantId || !loggedIn) return;
    let cancelled = false;
    (async () => {
      try {
        // 1) Resolve a stable visitor id. Prefer the server-issued httpOnly
        //    cookie; fall back to localStorage; server will also stamp a
        //    cookie on the /api/chat-ai response so future calls keep it.
        const vid = visitorId;
        if (cancelled) return;

        const action = mode === "new" ? "start" : "fetch";
        const r = await callEdge({
          action,
          merchant_id: merchantId,
          visitor_id: vid ?? undefined,
        });
        if (cancelled) return;
        setConversationId(r.conversation_id);
        setMessages(r.messages ?? []);
        setNeedsHuman(!!r.needs_human);
      } catch (e: any) {
        if (!cancelled) setInitErr(e?.message || "تعذر بدء المحادثة.");
      }
    })();
    return () => { cancelled = true; };
  }, [callEdge, merchantId, mode, slug, loggedIn, visitorId]);

  // Poll every 4s for new messages (agent replies / handoff updates).
  useEffect(() => {
    if (!callEdge || !conversationId || !loggedIn) return;
    const t = setInterval(async () => {
      try {
        const r = await callEdge({ action: "fetch", conversation_id: conversationId });
        setMessages(r.messages ?? []);
        setNeedsHuman(!!r.needs_human);
      } catch { /* ignore transient errors */ }
    }, 4000);
    return () => clearInterval(t);
  }, [callEdge, conversationId, loggedIn]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function pickFile(file: File | null | undefined) {
    setUploadErr(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setUploadErr("الصور فقط مسموح بها.");
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploadErr("حجم الصورة يتجاوز 8 ميجابايت.");
      return;
    }
    setPendingFile({ file, preview: URL.createObjectURL(file) });
  }

  function clearPendingFile() {
    setPendingFile((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview);
      return null;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function send() {
    if (!callEdge || !visitorId || !merchantId) return;
    const text = input.trim();
    const attaching = pendingFile;
    if (!text && !attaching) return;

    setUploadErr(null);
    setInput("");
    setSending(true);

    let attachments: ChatAttachment[] | undefined;
    if (attaching) {
      setUploading(true);
      try {
        const dataUrl = await readFileAsDataUrl(attaching.file);
        const uploaded = await uploadChatImage({
          data: {
            merchantId,
            conversationId: conversationId ?? null,
            fileName: attaching.file.name,
            dataUrl,
          },
        });
        attachments = [uploaded];
      } catch (e: any) {
        setUploadErr(e?.message || "تعذر رفع الصورة.");
        setInput(text);
        setSending(false);
        setUploading(false);
        return;
      } finally {
        setUploading(false);
      }
      clearPendingFile();
    }

    // Optimistic user bubble
    setMessages((m) => [...m, {
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
      attachments: attachments ?? null,
    }]);
    try {
      const r = await callEdge({
        action: "send",
        conversation_id: conversationId ?? undefined,
        merchant_id: merchantId,
        visitor_id: visitorId,
        message: text,
        attachments,
      });
      if (r.conversation_id && r.conversation_id !== conversationId) {
        setConversationId(r.conversation_id);
      }
      if (r.messages) setMessages(r.messages);
      setNeedsHuman(!!r.needs_human);
    } catch {
      // Network/agent errors are silent to the customer — no error bubble.
    } finally {
      setSending(false);
    }
  }

  /** Sends one location message (one-shot or the opening point of a live share). */
  const shareLocation = useCallback(
    async (live: boolean) => {
      if (!callEdge || !visitorId || !merchantId) return null;
      setLocErr(null);
      setLocBusy(true);
      try {
        const pos = await getCurrentPosition();
        const now = new Date();
        const attachment: LocationAttachment = {
          kind: "location",
          url: mapsUrl(pos.coords.latitude, pos.coords.longitude),
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
          label: null,
          live,
          updated_at: now.toISOString(),
          expires_at: live ? new Date(now.getTime() + LIVE_LOCATION_DURATION_MS).toISOString() : null,
          source: "customer",
        };
        const text = live ? "بدأت مشاركة موقعي الحي معك." : "ده موقعي الحالي.";
        setMessages((m) => [...m, {
          role: "user",
          content: text,
          created_at: now.toISOString(),
          attachments: [attachment as ChatAttachment],
        }]);
        const r = await callEdge({
          action: "send",
          conversation_id: conversationId ?? undefined,
          merchant_id: merchantId,
          visitor_id: visitorId,
          message: text,
          attachments: [attachment],
        });
        if (r.conversation_id && r.conversation_id !== conversationId) {
          setConversationId(r.conversation_id);
        }
        if (r.messages) setMessages(r.messages);
        setNeedsHuman(!!r.needs_human);
        return r.conversation_id ?? conversationId;
      } catch (e: any) {
        setLocErr(e?.message || "تعذر مشاركة الموقع.");
        return null;
      } finally {
        setLocBusy(false);
      }
    },
    [callEdge, conversationId, merchantId, visitorId],
  );

  const stopLiveSharing = useCallback(
    async (convId?: string | null) => {
      if (watchIdRef.current != null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (liveStopRef.current != null) {
        window.clearTimeout(liveStopRef.current);
        liveStopRef.current = null;
      }
      setLiveSharing(false);
      const id = convId ?? conversationId;
      if (!callEdge || !id) return;
      try {
        const pos = await getCurrentPosition();
        await callEdge({
          action: "location_update",
          conversation_id: id,
          location: {
            kind: "location",
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            live: false,
            updated_at: new Date().toISOString(),
          },
        });
      } catch { /* stopping must never surface an error */ }
    },
    [callEdge, conversationId],
  );

  const startLiveSharing = useCallback(async () => {
    const convId = await shareLocation(true);
    if (!convId || typeof navigator === "undefined" || !navigator.geolocation) return;
    setLiveSharing(true);
    lastPushRef.current = Date.now();
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastPushRef.current < LIVE_LOCATION_UPDATE_MS) return;
        lastPushRef.current = now;
        callEdge?.({
          action: "location_update",
          conversation_id: convId,
          location: {
            kind: "location",
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            live: true,
            updated_at: new Date().toISOString(),
          },
        }).catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    liveStopRef.current = window.setTimeout(
      () => { void stopLiveSharing(convId); },
      LIVE_LOCATION_DURATION_MS,
    );
  }, [callEdge, shareLocation, stopLiveSharing]);

  // Always release the geolocation watch when the page unmounts.
  useEffect(() => () => {
    if (watchIdRef.current != null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    if (liveStopRef.current != null) window.clearTimeout(liveStopRef.current);
  }, []);


  const disabled = sending || !callEdge || !merchantId || !loggedIn;
  const notFound = storefront.data && !storefront.data.found;

  const products = storefront.data?.products ?? [];

  return (
    <div dir="rtl" className="flex min-h-screen flex-col bg-gradient-chat text-chat-foreground">
      <header className="sticky top-0 z-20 border-b border-chat-line bg-chat-ink/80 backdrop-blur-xl">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-3">
            {storefront.data?.logoUrl ? (
              <img
                src={storefront.data.logoUrl}
                alt={brandName}
                className="h-10 w-10 shrink-0 rounded-2xl object-cover ring-2 ring-chat-accent/40"
              />
            ) : (
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-chat-accent text-sm font-bold text-chat-accent-foreground">
                {String(brandName).slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-bold tracking-tight">{brandName}</div>
              <div className="flex items-center gap-1.5 text-[11px] text-chat-muted">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-chat-accent" />
                متصل الآن
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {loggedIn && (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="text-chat-muted hover:bg-white/10 hover:text-chat-foreground"
                title={customerEmail ?? "حسابي"}
              >
                <Link to="/c/$slug/account" params={{ slug }} aria-label="حسابي">
                  <UserCircle2 className="h-5 w-5" />
                </Link>
              </Button>
            )}
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="text-chat-muted hover:bg-white/10 hover:text-chat-foreground"
              title="العودة للمتجر"
            >
              <Link to="/c/$slug" params={{ slug }} aria-label="العودة للمتجر">
                <ArrowRight className="h-5 w-5" />
              </Link>
            </Button>
          </div>
        </div>

        {loggedIn && products.length > 0 && (
          <ProductRail
            products={products}
            onPick={(name) =>
              setInput((v) => (v.trim() ? `${v.trim()} ${name}` : `مهتم بـ ${name}`))
            }
          />
        )}
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-3 pb-3 pt-4 sm:px-4">
        {notFound && (
          <div className="rounded-3xl border border-chat-line bg-chat-panel/70 p-6 text-center text-sm text-chat-muted">
            المتجر غير موجود.
          </div>
        )}

        {!notFound && merchantId && !loggedIn && !session.isLoading && (
          <div className="mx-auto w-full max-w-md py-6">
            <div className="rounded-3xl bg-background p-1 text-foreground shadow-mint">
              <CustomerLoginPanel
                merchantId={merchantId}
                visitorId={visitorId}
                brandName={brandName}
                onSuccess={() => session.refetch()}
              />
            </div>
            <p className="mt-3 text-center text-xs text-chat-muted">
              يجب تسجيل الدخول لعرض المحادثات والوصول إلى الطلبات.
            </p>
          </div>
        )}

        {initErr && (
          <div className="rounded-2xl border border-destructive/50 bg-destructive/15 p-3 text-sm text-destructive-foreground">
            {initErr}
          </div>
        )}

        {loggedIn && (
          <div className="flex-1 space-y-3 overflow-y-auto py-2">
            {messages.length === 0 && !initErr && (
              <div className="grid place-items-center gap-3 py-14 text-center">
                <span className="grid h-14 w-14 place-items-center rounded-3xl bg-chat-accent/15 text-chat-accent">
                  <MessageCircle className="h-6 w-6" />
                </span>
                <p className="text-sm text-chat-muted">
                  ابدأ المحادثة بكتابة رسالتك في الأسفل
                  {products.length > 0 ? "، أو اختر منتجًا من الشريط بالأعلى." : "."}
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <MessageBubble
                key={m.id ?? i}
                role={m.role}
                content={m.content}
                attachments={m.attachments}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}

        {loggedIn && (
          <div className="sticky bottom-0 mt-2 rounded-3xl border border-chat-line bg-chat-ink/85 p-2.5 backdrop-blur-xl sm:p-3">
            {pendingFile && (
              <div className="mb-2 flex items-center gap-2 rounded-2xl border border-chat-line bg-chat-panel/70 p-2">
                <img
                  src={pendingFile.preview}
                  alt="معاينة الصورة المرفقة"
                  className="h-14 w-14 shrink-0 rounded-xl object-cover"
                />
                <div className="min-w-0 flex-1 truncate text-xs text-chat-muted">
                  {pendingFile.file.name}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-chat-muted hover:bg-white/10 hover:text-chat-foreground"
                  onClick={clearPendingFile}
                  disabled={uploading}
                  aria-label="إزالة الصورة"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
            {uploadErr && (
              <div className="mb-2 rounded-xl border border-destructive/50 bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground">
                {uploadErr}
              </div>
            )}
            {locErr && (
              <div className="mb-2 rounded-xl border border-destructive/50 bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground">
                {locErr}
              </div>
            )}

            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="اكتب رسالتك..."
                rows={1}
                className="min-h-[48px] resize-none rounded-2xl border-chat-line bg-chat-panel/70 text-chat-foreground placeholder:text-chat-muted focus-visible:ring-chat-accent/60"
                disabled={disabled}
              />
              <Button
                onClick={send}
                disabled={disabled || uploading || (!input.trim() && !pendingFile)}
                size="icon"
                className="h-12 w-12 shrink-0 rounded-2xl bg-chat-accent text-chat-accent-foreground hover:bg-chat-accent/90"
                aria-label="إرسال"
              >
                <Send className="h-5 w-5" />
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ChatChip
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || uploading}
                icon={uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                label="صورة"
              />
              <ChatChip
                onClick={() => void shareLocation(false)}
                disabled={disabled || locBusy || liveSharing}
                icon={locBusy && !liveSharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                label="موقعي"
              />
              {liveSharing ? (
                <ChatChip
                  onClick={() => void stopLiveSharing()}
                  icon={<Square className="h-3.5 w-3.5" />}
                  label="إيقاف الموقع الحي"
                  tone="danger"
                />
              ) : (
                <ChatChip
                  onClick={() => void startLiveSharing()}
                  disabled={disabled || locBusy}
                  icon={<Radio className="h-3.5 w-3.5" />}
                  label="موقع حي"
                />
              )}
              {liveSharing && (
                <span className="flex items-center gap-1 text-[11px] text-chat-muted">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-chat-accent" />
                  جاري تحديث موقعك
                </span>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ChatChip({
  onClick, disabled, icon, label, tone = "default",
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition disabled:opacity-40 ${
        tone === "danger"
          ? "border-destructive/50 bg-destructive/15 text-destructive-foreground"
          : "border-chat-line bg-white/5 text-chat-muted hover:bg-chat-accent/15 hover:text-chat-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Expandable in-chat product rail: horizontal strip → full grid. */
function ProductRail({
  products, onPick,
}: {
  products: { id: string; name: string; price: number | null; currency: string | null; images: string[] }[];
  onPick: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-chat-line bg-chat-ink/60">
      <div className="mx-auto w-full max-w-3xl px-3 py-2 sm:px-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-chat-muted">
            <ShoppingBag className="h-3.5 w-3.5 shrink-0 text-chat-accent" />
            <span className="truncate">منتجات المتجر ({products.length})</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-chat-line bg-white/5 px-2.5 py-1 text-[11px] text-chat-muted transition hover:bg-chat-accent/15 hover:text-chat-foreground"
          >
            {open ? "طي" : "توسيع"}
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>

        {open ? (
          <div className="mt-2 grid max-h-[45vh] grid-cols-2 gap-2 overflow-y-auto pb-1 sm:grid-cols-3">
            {products.map((p) => (
              <ProductTile key={p.id} product={p} onPick={onPick} expanded />
            ))}
          </div>
        ) : (
          <div className="mt-2 flex snap-x gap-2 overflow-x-auto pb-1">
            {products.map((p) => (
              <ProductTile key={p.id} product={p} onPick={onPick} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductTile({
  product, onPick, expanded = false,
}: {
  product: { name: string; price: number | null; currency: string | null; images: string[] };
  onPick: (name: string) => void;
  expanded?: boolean;
}) {
  const img = product.images?.[0];
  return (
    <button
      type="button"
      onClick={() => onPick(product.name)}
      className={`group flex snap-start items-center gap-2 rounded-2xl border border-chat-line bg-chat-panel/60 p-1.5 text-right transition hover:border-chat-accent/60 hover:bg-chat-accent/10 ${
        expanded ? "w-full" : "w-[168px] shrink-0"
      }`}
    >
      {img ? (
        <img src={img} alt={product.name} loading="lazy" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
      ) : (
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-chat-accent/15 text-chat-accent">
          <ShoppingBag className="h-4 w-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold text-chat-foreground">{product.name}</span>
        <span className="block truncate text-[11px] text-chat-accent">
          {product.price != null ? `${product.price} ${product.currency ?? ""}` : "اسأل عن السعر"}
        </span>
      </span>
    </button>
  );
}

const BUBBLE_THEME = {
  userBubble: "bg-chat-accent text-chat-accent-foreground rounded-br-md",
  userAvatar: "bg-chat-accent text-chat-accent-foreground",
  assistantBubble:
    "bg-chat-panel/80 border border-chat-line text-chat-foreground rounded-bl-md",
  assistantAvatar: "bg-white/10 text-chat-accent",
};

function MessageBubble({
  role, content, attachments,
}: {
  role: string;
  content: string;
  attachments?: ChatAttachment[] | null;
}) {
  const isUser = role === "user";
  const theme = BUBBLE_THEME;
  const all = (attachments ?? []).filter((a) => a && typeof a.url === "string");
  const locations = all.filter(
    (a) => a.kind === "location" && typeof a.lat === "number" && typeof a.lng === "number",
  ) as LocationAttachment[];
  const media = all.filter((a) => a.kind !== "location");
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[88%] items-end gap-2 sm:max-w-[80%] ${isUser ? "flex-row-reverse" : ""}`}>
        <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-2xl text-xs ${
          isUser ? theme.userAvatar : theme.assistantAvatar
        }`}>
          {isUser ? <User2 className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </div>
        <div className={`space-y-2 rounded-3xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-elegant ${
          isUser ? theme.userBubble : theme.assistantBubble
        }`}>
          {media.length > 0 && (
            <div className={`grid gap-2 ${media.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
              {media.map((a, i) => (
                <a key={a.url + i} href={a.url} target="_blank" rel="noreferrer">
                  <img
                    src={a.url}
                    alt={a.name || "صورة مرفقة"}
                    loading="lazy"
                    className="max-h-56 w-full rounded-2xl object-cover"
                  />
                </a>
              ))}
            </div>
          )}
          {locations.map((a, i) => {
            const live = isLiveLocationActive(a);
            return (
              <a
                key={`loc-${i}`}
                href={mapsUrl(a.lat, a.lng)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-2xl border border-chat-line bg-black/10 px-3 py-2 no-underline"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10">
                  {live ? (
                    <Radio className="h-4 w-4 animate-pulse text-chat-accent" />
                  ) : (
                    <MapPin className="h-4 w-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">{formatLocationSummary(a)}</span>
                  <span className="block text-[11px] opacity-70">
                    فتح في الخرائط
                    {a.accuracy != null ? ` · دقة ±${a.accuracy}م` : ""}
                  </span>
                </span>
              </a>
            );
          })}
          {content && <div>{content}</div>}
        </div>
      </div>
    </div>
  );
}


