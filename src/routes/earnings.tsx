import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Package, Clock } from "lucide-react";

import { PageShell, PageHero, SurfaceCard } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { getEarningsSummary, type EarningsSummary } from "@/lib/orders.functions";

export const Route = createFileRoute("/earnings")({
  head: () => ({
    meta: [
      { title: "الأرباح · cupai" },
      { name: "description", content: "نظرة مالية سريعة على أداء متجرك." },
      { property: "og:title", content: "الأرباح · cupai" },
      { property: "og:description", content: "نظرة مالية سريعة على أداء متجرك." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "الأرباح · cupai" },
      { name: "twitter:description", content: "نظرة مالية سريعة على أداء متجرك." },
    ],
  }),
  component: EarningsPage,
});

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("ar-EG", {
    maximumFractionDigits: 2,
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
  }).format(n);
}

function EarningsPage() {
  const q = useQuery({
    queryKey: ["earnings-summary"],
    queryFn: () => getEarningsSummary(),
    refetchInterval: 30_000,
  });

  const data: EarningsSummary | undefined = q.data;

  return (
    <PageShell>
      <PageHero
        eyebrow="نظرة مالية"
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        title="أرباح متجرك"
        highlight="في ثوانٍ"
        description="ثلاثة مؤشرات تُعطيك صورة كاملة عن أداء متجرك المالي."
      />

      {q.isLoading ? (
        <LoadingMetrics />
      ) : q.isError ? (
        <SurfaceCard className="flex flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-destructive/10 text-destructive">
            <TrendingUp className="h-7 w-7" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">تعذر تحميل البيانات</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {(q.error as Error)?.message || "حدث خطأ أثناء جلب نظرتك المالية."}
            </p>
          </div>
        </SurfaceCard>
      ) : !data || data.orderCount === 0 ? (
        <SurfaceCard className="flex flex-col items-center justify-center gap-4 p-12 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-brand text-primary-foreground shadow-glow">
            <TrendingUp className="h-7 w-7" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">لا توجد أرباح بعد</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              بمجرد استلام أول طلب، ستظهر هنا نظرتك المالية السريعة.
            </p>
          </div>
        </SurfaceCard>
      ) : (
        <div className="grid gap-5 sm:grid-cols-3">
          <MetricCard
            icon={<Package className="h-6 w-6" />}
            label="عدد الأوردرات"
            value={String(data.orderCount)}
            subtext="إجمالي الطلبات النشطة"
            variant="default"
          />
          <MetricCard
            icon={<TrendingUp className="h-6 w-6" />}
            label="إجمالي الأرباح"
            value={fmtMoney(data.totalProfit)}
            currency={data.currency}
            subtext="صافي الأرباح بعد خصم تكاليف الشحن"
            variant="gradient"
          />
          <MetricCard
            icon={<Clock className="h-6 w-6" />}
            label="أرباح تحت التحصيل"
            value={fmtMoney(data.pendingProfit)}
            currency={data.currency}
            subtext="أوردرات لم تُسلّم أو تُحصّل بعد"
            variant="pending"
          />
        </div>
      )}
    </PageShell>
  );
}

function MetricCard({
  icon,
  label,
  value,
  currency,
  subtext,
  variant,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  currency?: string;
  subtext: string;
  variant: "default" | "gradient" | "pending";
}) {
  const isGradient = variant === "gradient";
  const isPending = variant === "pending";

  return (
    <SurfaceCard
      className={`relative overflow-hidden p-6 transition-all hover:-translate-y-0.5 sm:p-8 ${
        isGradient
          ? "border-transparent bg-gradient-brand text-primary-foreground shadow-glow"
          : isPending
            ? "border-l-4 border-l-amber-500/70"
            : ""
      }`}
    >
      {isGradient && (
        <div className="pointer-events-none absolute -end-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-3xl" />
      )}
      <div className="relative">
        <div
          className={`mb-5 grid h-12 w-12 place-items-center rounded-2xl ${
            isGradient
              ? "bg-white/15 text-white"
              : isPending
                ? "bg-amber-500/10 text-amber-600"
                : "bg-primary/10 text-primary"
          }`}
        >
          {icon}
        </div>
        <div className={`text-sm font-medium ${isGradient ? "text-white/80" : "text-muted-foreground"}`}>
          {label}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-4xl font-bold tracking-tight sm:text-5xl">{value}</span>
          {currency && (
            <span className={`text-lg font-medium ${isGradient ? "text-white/80" : "text-muted-foreground"}`}>
              {currency}
            </span>
          )}
        </div>
        <p className={`mt-3 text-xs ${isGradient ? "text-white/70" : "text-muted-foreground"}`}>
          {subtext}
        </p>
      </div>
    </SurfaceCard>
  );
}

function LoadingMetrics() {
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <SurfaceCard key={i} className="p-6 sm:p-8">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <Skeleton className="mt-5 h-4 w-24" />
          <Skeleton className="mt-3 h-14 w-40" />
          <Skeleton className="mt-3 h-3 w-48" />
        </SurfaceCard>
      ))}
    </div>
  );
}
