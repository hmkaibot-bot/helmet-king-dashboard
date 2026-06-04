import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import { ChevronDown, ChevronRight, Megaphone, RefreshCw, AlertCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

// ── Types ────────────────────────────────────────────────────────────────────

interface InventoryRow {
  sku: string;
  product_id: string | null;
  product_title: string | null;
  variant_title: string | null;
  vendor: string | null;
  product_type: string | null;
  inventory_quantity: number | null;
  price: number | null;
  compare_at_price: number | null;
}

interface ReviewRow {
  sku: string;
  manual_status: string | null;
  promo_start_date: string | null;
  updated_at: string | null;
}

interface OrderLineRow {
  sku: string | null;
  quantity: number | null;
  price: number | null;
  total_discount: number | null;
  line_total: number | null;
  order_id: string | number | null;
}

interface OrderRow {
  id: string | number;
  created_at: string;
  cancelled_at: string | null;
}

interface SkuRow {
  sku: string;
  variant_title: string;
  inventory_quantity: number;
  price: number;
  promo_qty: number;
  promo_revenue: number;
  pre_promo_daily: number; // avg daily qty in 90 days before promo
  last_sold_at: string | null;
}

interface PromoGroup {
  product_id: string;
  product_title: string;
  vendor: string;
  product_type: string;
  promo_start_date: string;
  days_in_promo: number;
  total_inventory: number;
  num_skus: number;
  promo_qty: number;
  promo_revenue: number;
  pre_promo_qty_90d: number;
  promo_daily_avg: number;
  pre_promo_daily_avg: number;
  lift_ratio: number; // promo_daily / pre_promo_daily
  rating: 'effective' | 'ok' | 'ineffective';
  skus: SkuRow[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const dayMs = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / dayMs));
}

function ratingFromLift(lift: number): PromoGroup['rating'] {
  if (lift >= 2) return 'effective';
  if (lift >= 1.2) return 'ok';
  return 'ineffective';
}

const RATING_LABEL: Record<PromoGroup['rating'], string> = {
  effective: '有效',
  ok: '一般',
  ineffective: '無效',
};

const RATING_COLOR: Record<PromoGroup['rating'], string> = {
  effective: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
  ok: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
  ineffective: 'text-rose-400 border-rose-500/40 bg-rose-500/10',
};

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [orderLines, setOrderLines] = useState<OrderLineRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchAllRows = async <T,>(table: string, columns = '*'): Promise<T[]> => {
    const PAGE = 1000;
    let all: T[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as T[];
      all = all.concat(rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
    return all;
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invRows, reviewRows, lineRows, orderRows] = await Promise.all([
        queryAllPages(
          'shopify_inventory',
          'sku,product_id,product_title,variant_title,vendor,product_type,inventory_quantity,price,compare_at_price',
        ),
        fetchAllRows<ReviewRow>('dead_stock_reviews', 'sku,manual_status,promo_start_date,updated_at'),
        queryAllPages('shopify_order_lines', 'sku,quantity,price,total_discount,line_total,order_id'),
        queryAllPages('shopify_orders', 'id,created_at,cancelled_at'),
      ]);
      setInventory(invRows as InventoryRow[]);
      setReviews(reviewRows);
      setOrderLines(lineRows as OrderLineRow[]);
      setOrders(orderRows as OrderRow[]);
    } catch (e: any) {
      setError(e?.message ?? 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Compute promo groups ───────────────────────────────────────────────────

  const groups = useMemo<PromoGroup[]>(() => {
    if (loading) return [];
    const reviewBySku = new Map<string, ReviewRow>();
    for (const r of reviews) reviewBySku.set(r.sku, r);

    // Promoting SKUs only
    const promoSkus: Array<InventoryRow & { promo_start_date: string }> = [];
    for (const inv of inventory) {
      const r = reviewBySku.get(inv.sku);
      if (!r || r.manual_status !== 'promoting') continue;
      if (!r.promo_start_date) continue;
      promoSkus.push({ ...inv, promo_start_date: r.promo_start_date });
    }

    if (promoSkus.length === 0) return [];

    // Order date map
    const orderDate = new Map<string, Date>();
    for (const o of orders) {
      if (o.cancelled_at) continue;
      orderDate.set(String(o.id), new Date(o.created_at));
    }

    // Index order_lines by sku
    const linesBySku = new Map<string, Array<{ date: Date; qty: number; revenue: number }>>();
    for (const l of orderLines) {
      if (!l.sku || !l.order_id) continue;
      const d = orderDate.get(String(l.order_id));
      if (!d) continue;
      const qty = Number(l.quantity ?? 0);
      const rev = Number(l.line_total ?? (Number(l.price ?? 0) * qty - Number(l.total_discount ?? 0)));
      const arr = linesBySku.get(l.sku) ?? [];
      arr.push({ date: d, qty, revenue: rev });
      linesBySku.set(l.sku, arr);
    }

    // Group by product_id
    const byProduct = new Map<string, typeof promoSkus>();
    for (const s of promoSkus) {
      const pid = s.product_id ?? `__no_pid__${s.sku}`;
      const arr = byProduct.get(pid) ?? [];
      arr.push(s);
      byProduct.set(pid, arr);
    }

    const now = new Date();
    const result: PromoGroup[] = [];

    for (const [pid, skus] of byProduct.entries()) {
      // Earliest promo_start_date among variants (group level)
      const earliestPromo = skus.reduce<string>((acc, s) =>
        !acc || s.promo_start_date < acc ? s.promo_start_date : acc, '');
      const promoStart = new Date(earliestPromo + 'T00:00:00');
      const daysInPromo = Math.max(1, daysBetween(promoStart, now));
      const prePromoStart = new Date(promoStart.getTime() - 90 * dayMs);

      let totalPromoQty = 0;
      let totalPromoRev = 0;
      let totalPrePromoQty = 0;
      let totalInv = 0;
      const skuRows: SkuRow[] = [];

      for (const s of skus) {
        const lines = linesBySku.get(s.sku) ?? [];
        let pq = 0, pr = 0, prq = 0;
        let lastSold: Date | null = null;
        for (const l of lines) {
          if (l.date >= promoStart) {
            pq += l.qty;
            pr += l.revenue;
            if (!lastSold || l.date > lastSold) lastSold = l.date;
          } else if (l.date >= prePromoStart && l.date < promoStart) {
            prq += l.qty;
          }
        }
        totalPromoQty += pq;
        totalPromoRev += pr;
        totalPrePromoQty += prq;
        totalInv += Number(s.inventory_quantity ?? 0);
        skuRows.push({
          sku: s.sku,
          variant_title: s.variant_title ?? '',
          inventory_quantity: Number(s.inventory_quantity ?? 0),
          price: Number(s.price ?? 0),
          promo_qty: pq,
          promo_revenue: pr,
          pre_promo_daily: prq / 90,
          last_sold_at: lastSold ? lastSold.toISOString().slice(0, 10) : null,
        });
      }

      const promoDailyAvg = totalPromoQty / daysInPromo;
      const prePromoDailyAvg = totalPrePromoQty / 90;
      const lift = prePromoDailyAvg > 0 ? promoDailyAvg / prePromoDailyAvg : (promoDailyAvg > 0 ? 999 : 0);

      result.push({
        product_id: pid,
        product_title: skus[0].product_title ?? '(unknown)',
        vendor: skus[0].vendor ?? '',
        product_type: skus[0].product_type ?? '',
        promo_start_date: earliestPromo,
        days_in_promo: daysInPromo,
        total_inventory: totalInv,
        num_skus: skus.length,
        promo_qty: totalPromoQty,
        promo_revenue: totalPromoRev,
        pre_promo_qty_90d: totalPrePromoQty,
        promo_daily_avg: promoDailyAvg,
        pre_promo_daily_avg: prePromoDailyAvg,
        lift_ratio: lift,
        rating: ratingFromLift(lift),
        skus: skuRows.sort((a, b) => b.promo_qty - a.promo_qty),
      });
    }

    // Sort: 推廣中、近開始嘅排前；可改
    return result.sort((a, b) => (b.promo_start_date > a.promo_start_date ? 1 : -1));
  }, [inventory, reviews, orderLines, orders, loading]);

  // ── KPIs ───────────────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const totalProducts = groups.length;
    const totalSkus = groups.reduce((s, g) => s + g.num_skus, 0);
    const totalRev = groups.reduce((s, g) => s + g.promo_revenue, 0);
    const totalQty = groups.reduce((s, g) => s + g.promo_qty, 0);
    const effective = groups.filter(g => g.rating === 'effective').length;
    const ok = groups.filter(g => g.rating === 'ok').length;
    const ineffective = groups.filter(g => g.rating === 'ineffective').length;
    return { totalProducts, totalSkus, totalRev, totalQty, effective, ok, ineffective };
  }, [groups]);

  const toggleExpand = (pid: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-rose-400 flex items-center gap-2">
        <AlertCircle className="h-4 w-4" /> {error}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Megaphone className="h-5 w-5" /> 推廣中商品成效
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            列出狀態核實標記為「推廣中」嘅母 ITEM，並計算推廣期銷售與成效評級
          </p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-border/60 hover:bg-accent/50"
        >
          <RefreshCw className="h-3 w-3" /> 重新整理
        </button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <KpiBlock label="推廣產品" value={formatNumber(kpis.totalProducts)} unit="個" />
        <KpiBlock label="SKU 總數" value={formatNumber(kpis.totalSkus)} unit="個" />
        <KpiBlock label="推廣期銷量" value={formatNumber(kpis.totalQty)} unit="件" />
        <KpiBlock label="推廣期營收" value={formatCurrency(kpis.totalRev)} />
        <KpiBlock label="有效" value={formatNumber(kpis.effective)} tone="effective" />
        <KpiBlock label="一般" value={formatNumber(kpis.ok)} tone="ok" />
        <KpiBlock label="無效" value={formatNumber(kpis.ineffective)} tone="ineffective" />
      </div>

      {/* Table */}
      {groups.length === 0 ? (
        <div className="rounded-md border border-border/60 p-8 text-center text-sm text-muted-foreground">
          目前沒有狀態為「推廣中」嘅母 ITEM。
          <br />
          喺死貨報表將母 ITEM 嘅狀態核實改為「推廣中」並輸入開始日期後，就會喺度顯示。
        </div>
      ) : (
        <div className="rounded-md border border-border/60 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-2 py-2 text-left w-6"></th>
                <th className="px-2 py-2 text-left">產品名稱</th>
                <th className="px-2 py-2 text-left">品牌</th>
                <th className="px-2 py-2 text-left">分類</th>
                <th className="px-2 py-2 text-right">SKU 數</th>
                <th className="px-2 py-2 text-right">現庫存</th>
                <th className="px-2 py-2 text-left">推廣開始</th>
                <th className="px-2 py-2 text-right">推廣日數</th>
                <th className="px-2 py-2 text-right">推廣期銷量</th>
                <th className="px-2 py-2 text-right">推廣期營收</th>
                <th className="px-2 py-2 text-right">推廣前 90 日銷量</th>
                <th className="px-2 py-2 text-right">日均比較 (推/前)</th>
                <th className="px-2 py-2 text-center">成效評級</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const isOpen = expanded.has(g.product_id);
                return (
                  <>
                    <tr
                      key={g.product_id}
                      className="border-b border-border/40 hover:bg-accent/20 cursor-pointer"
                      onClick={() => toggleExpand(g.product_id)}
                    >
                      <td className="px-2 py-1.5">
                        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </td>
                      <td className="px-2 py-1.5 font-medium" title={g.product_title}>
                        {g.product_title.length > 45 ? g.product_title.slice(0, 45) + '…' : g.product_title}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{g.vendor}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{g.product_type}</td>
                      <td className="px-2 py-1.5 text-right">{g.num_skus}</td>
                      <td className="px-2 py-1.5 text-right">{formatNumber(g.total_inventory)}</td>
                      <td className="px-2 py-1.5 font-mono">{g.promo_start_date}</td>
                      <td className="px-2 py-1.5 text-right">{g.days_in_promo}</td>
                      <td className="px-2 py-1.5 text-right font-medium">{formatNumber(g.promo_qty)}</td>
                      <td className="px-2 py-1.5 text-right">{formatCurrency(g.promo_revenue)}</td>
                      <td className="px-2 py-1.5 text-right text-muted-foreground">{formatNumber(g.pre_promo_qty_90d)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <span className="font-mono">
                          {g.promo_daily_avg.toFixed(2)} / {g.pre_promo_daily_avg.toFixed(2)}
                        </span>
                        {g.pre_promo_daily_avg > 0 && (
                          <span className="ml-1 text-muted-foreground">({g.lift_ratio.toFixed(1)}×)</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${RATING_COLOR[g.rating]}`}>
                          {RATING_LABEL[g.rating]}
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${g.product_id}-detail`} className="bg-muted/10">
                        <td colSpan={13} className="px-4 py-3">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                            SKU 銷售明細
                          </div>
                          <table className="w-full text-[11px]">
                            <thead className="text-muted-foreground">
                              <tr>
                                <th className="px-2 py-1 text-left">SKU</th>
                                <th className="px-2 py-1 text-left">Variant</th>
                                <th className="px-2 py-1 text-right">現庫存</th>
                                <th className="px-2 py-1 text-right">售價</th>
                                <th className="px-2 py-1 text-right">推廣期銷量</th>
                                <th className="px-2 py-1 text-right">推廣期營收</th>
                                <th className="px-2 py-1 text-right">推廣前日均</th>
                                <th className="px-2 py-1 text-left">最後銷售日</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.skus.map(s => (
                                <tr key={s.sku} className="border-t border-border/30">
                                  <td className="px-2 py-1 font-mono">{s.sku}</td>
                                  <td className="px-2 py-1 text-muted-foreground">{s.variant_title}</td>
                                  <td className="px-2 py-1 text-right">{formatNumber(s.inventory_quantity)}</td>
                                  <td className="px-2 py-1 text-right">{formatCurrency(s.price)}</td>
                                  <td className="px-2 py-1 text-right">{formatNumber(s.promo_qty)}</td>
                                  <td className="px-2 py-1 text-right">{formatCurrency(s.promo_revenue)}</td>
                                  <td className="px-2 py-1 text-right font-mono">{s.pre_promo_daily.toFixed(2)}</td>
                                  <td className="px-2 py-1 font-mono text-muted-foreground">
                                    {s.last_sold_at ?? '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Methodology note */}
      <div className="text-[10px] text-muted-foreground border-t border-border/40 pt-2">
        推廣期 = 由 promo_start_date 至今日。推廣前 90 日 = promo_start_date 之前 90 日。
        成效評級基於 (推廣期日均銷量 ÷ 推廣前日均銷量)：≥2× 有效、1.2-2× 一般、&lt;1.2× 無效。
        如推廣前無銷量但推廣期有，計為「有效」。
      </div>
    </div>
  );
}

// ── KPI block ────────────────────────────────────────────────────────────────

function KpiBlock({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: PromoGroup['rating'];
}) {
  const toneCls = tone ? RATING_COLOR[tone] : 'border-border/60 text-foreground';
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-semibold mt-0.5">
        {value}
        {unit && <span className="text-[10px] text-muted-foreground ml-0.5">{unit}</span>}
      </div>
    </div>
  );
}
