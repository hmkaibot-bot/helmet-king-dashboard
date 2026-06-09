import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRoute, Link } from 'wouter';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import {
  Megaphone,
  RefreshCw,
  AlertCircle,
  ArrowLeft,
  Calendar,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Promotion,
  PromotionItem,
  Rating,
  RATING_LABEL,
  RATING_COLOR,
  STATUS_LABEL,
  STATUS_COLOR,
  ratingFromLift,
  fetchAllRows,
  daysBetween,
} from '@/lib/promotions-shared';

interface InventoryRow {
  sku: string;
  product_id: number | string | null;
  product_title: string | null;
  variant_title: string | null;
  vendor: string | null;
  product_type: string | null;
  inventory_quantity: number | null;
  price: number | null;
}

interface OrderLineRow {
  sku: string | null;
  quantity: number | null;
  price: number | null;
  order_id: string | number | null;
}

interface OrderRow {
  id: string | number;
  created_at: string;
  cancelled_at: string | null;
}

interface SkuStat {
  sku: string;
  variant_title: string;
  inventory: number;
  price: number;
  promo_qty: number;
  promo_revenue: number;
  pre_promo_qty: number;
  pre_promo_daily: number;
  last_sold_at: string | null;
}

interface ProductStat {
  product_id: string;
  product_title: string;
  vendor: string;
  product_type: string;
  total_inventory: number;
  num_skus: number;
  promo_qty: number;
  promo_revenue: number;
  pre_promo_qty: number;
  promo_daily_avg: number;
  pre_promo_daily_avg: number;
  lift_ratio: number;
  rating: Rating;
  skus: SkuStat[];
}

export default function PromotionDetailPage() {
  const [, params] = useRoute('/retail/promotions/:id');
  const promoId = params?.id;

  const [promo, setPromo] = useState<Promotion | null>(null);
  const [items, setItems] = useState<PromotionItem[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [orderLines, setOrderLines] = useState<OrderLineRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'promo_qty' | 'promo_revenue'>('promo_qty');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedVendors, setSelectedVendors] = useState<Set<string>>(new Set());

  const toggleType = (t: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };
  const toggleVendor = (v: string) => {
    setSelectedVendors(prev => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const toggleSort = (col: 'promo_qty' | 'promo_revenue') => {
    if (sortBy === col) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const load = useCallback(async () => {
    if (!promoId) return;
    setLoading(true);
    setError(null);
    try {
      // 1. Promo + items
      const { data: promoData, error: pErr } = await supabase
        .from('promotions')
        .select('*')
        .eq('id', promoId)
        .single();
      if (pErr) throw pErr;
      setPromo(promoData as Promotion);

      const pItems = await fetchAllRows<PromotionItem>('promotion_items');
      const myItems = pItems.filter(i => i.promotion_id === promoId);
      setItems(myItems);

      // 統一用 string 作為比對 key、避免 number/string 兩邊不一致
      const productIds = new Set(myItems.map(i => String(i.product_id)));

      // 2. Inventory (all SKUs belonging to these products)
      const inv = await fetchAllRows<InventoryRow>(
        'shopify_inventory',
        'sku,product_id,product_title,variant_title,vendor,product_type,inventory_quantity,price'
      );
      const filteredInv = inv.filter(
        i => i.product_id != null && productIds.has(String(i.product_id))
      );
      setInventory(filteredInv);

      const skuSet = new Set(filteredInv.map(i => i.sku));

      // 3. Orders / order_lines (full set — we filter client-side by date)
      const [ol, os] = await Promise.all([
        queryAllPages('shopify_order_lines', 'sku,quantity,price,order_id'),
        queryAllPages('shopify_orders', 'id,created_at,cancelled_at'),
      ]);
      setOrderLines((ol as OrderLineRow[]).filter(l => l.sku && skuSet.has(l.sku)));
      setOrders(os as OrderRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [promoId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Compute metrics ──────────────────────────────────────────────────────
  const stats = useMemo<ProductStat[]>(() => {
    if (!promo || items.length === 0 || inventory.length === 0) return [];

    const startDate = new Date(promo.start_date + 'T00:00:00');
    const endDate = new Date(promo.end_date + 'T23:59:59');
    const preStart = new Date(startDate.getTime() - 90 * 86_400_000);
    const preEnd = new Date(startDate.getTime() - 1);

    const orderById = new Map<string, OrderRow>();
    for (const o of orders) {
      if (o.cancelled_at) continue;
      orderById.set(String(o.id), o);
    }

    // For each SKU, scan order_lines and bucket into promo vs pre-promo
    const skuPromoQty = new Map<string, number>();
    const skuPromoRev = new Map<string, number>();
    const skuPreQty = new Map<string, number>();
    const skuLastSold = new Map<string, string>();

    for (const line of orderLines) {
      const sku = line.sku;
      if (!sku) continue;
      const order = orderById.get(String(line.order_id));
      if (!order) continue;
      const createdAt = new Date(order.created_at);
      const qty = line.quantity ?? 0;
      const price = line.price ?? 0;

      if (createdAt >= startDate && createdAt <= endDate) {
        skuPromoQty.set(sku, (skuPromoQty.get(sku) ?? 0) + qty);
        skuPromoRev.set(sku, (skuPromoRev.get(sku) ?? 0) + qty * price);
      } else if (createdAt >= preStart && createdAt <= preEnd) {
        skuPreQty.set(sku, (skuPreQty.get(sku) ?? 0) + qty);
      }
      // Track last sold (any time)
      const lastStr = skuLastSold.get(sku);
      if (!lastStr || order.created_at > lastStr) {
        skuLastSold.set(sku, order.created_at);
      }
    }

    // Group by product_id (同一用 String key)
    const byProduct = new Map<string, InventoryRow[]>();
    for (const inv of inventory) {
      if (inv.product_id == null) continue;
      const key = String(inv.product_id);
      const arr = byProduct.get(key) ?? [];
      arr.push(inv);
      byProduct.set(key, arr);
    }

    const today = new Date();
    const promoDays = Math.max(1, daysBetween(startDate, today < endDate ? today : endDate) + 1);
    const preDays = 90;

    const results: ProductStat[] = [];
    for (const [productId, skuRows] of byProduct.entries()) {
      const skuStats: SkuStat[] = skuRows.map(s => {
        const promoQty = skuPromoQty.get(s.sku) ?? 0;
        const promoRev = skuPromoRev.get(s.sku) ?? 0;
        const preQty = skuPreQty.get(s.sku) ?? 0;
        return {
          sku: s.sku,
          variant_title: s.variant_title ?? '',
          inventory: s.inventory_quantity ?? 0,
          price: s.price ?? 0,
          promo_qty: promoQty,
          promo_revenue: promoRev,
          pre_promo_qty: preQty,
          pre_promo_daily: preQty / preDays,
          last_sold_at: skuLastSold.get(s.sku) ?? null,
        };
      });

      const promoQty = skuStats.reduce((s, x) => s + x.promo_qty, 0);
      const promoRev = skuStats.reduce((s, x) => s + x.promo_revenue, 0);
      const preQty = skuStats.reduce((s, x) => s + x.pre_promo_qty, 0);
      const promoDaily = promoQty / promoDays;
      const preDaily = preQty / preDays;
      const lift = preDaily === 0 ? (promoDaily > 0 ? 999 : 0) : promoDaily / preDaily;
      const rating: Rating = lift === 999 ? 'effective' : ratingFromLift(lift);

      results.push({
        product_id: productId,
        product_title: skuRows[0].product_title ?? '—',
        vendor: skuRows[0].vendor ?? '—',
        product_type: skuRows[0].product_type ?? '—',
        total_inventory: skuStats.reduce((s, x) => s + x.inventory, 0),
        num_skus: skuStats.length,
        promo_qty: promoQty,
        promo_revenue: promoRev,
        pre_promo_qty: preQty,
        promo_daily_avg: promoDaily,
        pre_promo_daily_avg: preDaily,
        lift_ratio: lift,
        rating,
        skus: skuStats,
      });
    }

    return results;
  }, [promo, items, inventory, orderLines, orders]);

  // Filter options (聚合 distinct types/vendors,按推廣期銷量降序)
  const typeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stats) {
      const k = s.product_type || '(未分類)';
      m.set(k, (m.get(k) ?? 0) + s.promo_qty);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [stats]);

  const vendorOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stats) {
      const k = s.vendor || '(未分類)';
      m.set(k, (m.get(k) ?? 0) + s.promo_qty);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label);
  }, [stats]);

  // Filtered + sorted view (default: promo_qty desc)
  const sortedStats = useMemo(() => {
    const arr = stats.filter(s => {
      const t = s.product_type || '(未分類)';
      const v = s.vendor || '(未分類)';
      if (selectedTypes.size > 0 && !selectedTypes.has(t)) return false;
      if (selectedVendors.size > 0 && !selectedVendors.has(v)) return false;
      return true;
    });
    arr.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return arr;
  }, [stats, sortBy, sortDir, selectedTypes, selectedVendors]);

  // ── KPI roll-up (用 filtered view) ──────────────────────────────────────
  const kpi = useMemo(() => {
    if (!promo || sortedStats.length === 0) {
      return null;
    }
    const totalQty = sortedStats.reduce((s, p) => s + p.promo_qty, 0);
    const totalRev = sortedStats.reduce((s, p) => s + p.promo_revenue, 0);
    const totalPreQty = sortedStats.reduce((s, p) => s + p.pre_promo_qty, 0);

    const startDate = new Date(promo.start_date + 'T00:00:00');
    const endDate = new Date(promo.end_date + 'T23:59:59');
    const today = new Date();
    const promoDays = Math.max(1, daysBetween(startDate, today < endDate ? today : endDate) + 1);

    const promoDaily = totalQty / promoDays;
    const preDaily = totalPreQty / 90;
    const lift = preDaily === 0 ? (promoDaily > 0 ? 999 : 0) : promoDaily / preDaily;
    const aggRating: Rating = lift === 999 ? 'effective' : ratingFromLift(lift);

    const effectiveCount = sortedStats.filter(s => s.rating === 'effective').length;
    const okCount = sortedStats.filter(s => s.rating === 'ok').length;
    const ineffectiveCount = sortedStats.filter(s => s.rating === 'ineffective').length;

    return {
      totalProducts: sortedStats.length,
      totalSkus: sortedStats.reduce((s, p) => s + p.num_skus, 0),
      totalQty,
      totalRev,
      promoDays,
      lift,
      aggRating,
      effectiveCount,
      okCount,
      ineffectiveCount,
    };
  }, [promo, sortedStats]);

  // ── Use snapshot for ended promos ────────────────────────────────────────
  const isEnded = promo?.status === 'ended';

  if (!promoId) return null;

  return (
    <div className="space-y-4">
      {/* Back link */}
      <div className="flex items-center gap-2 text-xs">
        <Link
          to="/retail/promotions"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          推廣活動
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link
          to="/retail/promotions/history"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          推廣歷史
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Megaphone className="h-5 w-5 text-primary shrink-0" />
            <h1 className="text-lg font-semibold truncate">{promo?.name ?? '...'}</h1>
            {promo && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_COLOR[promo.status]}`}
              >
                {STATUS_LABEL[promo.status]}
              </span>
            )}
            {isEnded && promo?.snapshotted_at && (
              <span className="text-[10px] text-muted-foreground">
                · 已 freeze 於 {new Date(promo.snapshotted_at).toLocaleString('zh-HK')}
              </span>
            )}
          </div>
          {promo && (
            <div className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {promo.start_date} → {promo.end_date}
              {promo.discount_type && <span className="ml-2">· {promo.discount_type}</span>}
            </div>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent/60 transition-colors inline-flex items-center gap-1"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          重新整理
        </button>
      </div>

      {promo?.notes && (
        <div className="rounded-md border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {promo.notes}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* KPI strip */}
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : kpi ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          <KpiCard label="推廣商品" value={formatNumber(kpi.totalProducts)} />
          <KpiCard label="SKU 數" value={formatNumber(kpi.totalSkus)} />
          <KpiCard label="推廣日數" value={`${kpi.promoDays} 天`} />
          <KpiCard label="推廣期銷量" value={formatNumber(kpi.totalQty)} />
          <KpiCard label="推廣期營收" value={formatCurrency(kpi.totalRev)} />
          <KpiCard
            label="整體日均比較"
            value={
              kpi.lift === 999
                ? '∞'
                : kpi.lift === 0
                  ? '—'
                  : `${kpi.lift.toFixed(2)}×`
            }
            color={RATING_COLOR[kpi.aggRating]}
          />
          <div className="rounded-md border border-border/60 bg-card p-2 flex flex-col">
            <span className="text-[10px] text-muted-foreground">商品成效分布</span>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-500/10 border-emerald-500/40 text-emerald-300">
                有效 {kpi.effectiveCount}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-500/10 border-amber-500/40 text-amber-300">
                一般 {kpi.okCount}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-rose-500/10 border-rose-500/40 text-rose-300">
                無效 {kpi.ineffectiveCount}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Filter chips: 分類 + 品牌 */}
      {!loading && stats.length > 0 && (
        <div className="rounded-md border border-border/60 bg-card p-2 space-y-1.5">
          <FilterRow
            label="分類"
            options={typeOptions}
            selected={selectedTypes}
            onToggle={toggleType}
            onClear={() => setSelectedTypes(new Set())}
          />
          <FilterRow
            label="品牌"
            options={vendorOptions}
            selected={selectedVendors}
            onToggle={toggleVendor}
            onClear={() => setSelectedVendors(new Set())}
          />
        </div>
      )}

      {/* Snapshot indicator for ended */}
      {isEnded && promo?.final_qty_sold != null && (
        <div className="rounded-md border border-border/40 bg-muted/20 p-3 text-xs">
          <span className="text-muted-foreground">⚡ 結束 Snapshot：</span>{' '}
          銷量 <span className="font-medium tabular-nums">{formatNumber(promo.final_qty_sold)}</span> ·
          營收 <span className="font-medium tabular-nums">{formatCurrency(promo.final_revenue ?? 0)}</span> ·
          整體 Lift <span className="font-medium tabular-nums">
            {promo.final_lift_ratio === 999 ? '∞' : `${(promo.final_lift_ratio ?? 0).toFixed(2)}×`}
          </span> ·
          評級{' '}
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] border ${
              promo.final_rating ? RATING_COLOR[promo.final_rating] : ''
            }`}
          >
            {promo.final_rating ? RATING_LABEL[promo.final_rating] : '—'}
          </span>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : stats.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 p-12 text-center text-sm text-muted-foreground">
          此推廣尚未分派任何商品。去
          <Link to="/retail/promotions/items" className="text-primary hover:underline mx-1">
            推廣商品池
          </Link>
          分派。
        </div>
      ) : (
        <div className="rounded-md border border-border/60 bg-card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b border-border/40">
              <tr>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground w-6"></th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">產品名稱</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">品牌</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">SKU</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">現庫存</th>
                <th
                  className="text-right px-2 py-2 font-normal text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => toggleSort('promo_qty')}
                >
                  <span className="inline-flex items-center gap-0.5">
                    推廣期銷量
                    {sortBy === 'promo_qty' &&
                      (sortDir === 'desc' ? (
                        <ArrowDown className="h-3 w-3" />
                      ) : (
                        <ArrowUp className="h-3 w-3" />
                      ))}
                  </span>
                </th>
                <th
                  className="text-right px-2 py-2 font-normal text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => toggleSort('promo_revenue')}
                >
                  <span className="inline-flex items-center gap-0.5">
                    推廣期營收
                    {sortBy === 'promo_revenue' &&
                      (sortDir === 'desc' ? (
                        <ArrowDown className="h-3 w-3" />
                      ) : (
                        <ArrowUp className="h-3 w-3" />
                      ))}
                  </span>
                </th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">推廣前 90d 銷量</th>
                <th className="text-right px-2 py-2 font-normal text-muted-foreground">日均比較</th>
                <th className="text-left px-2 py-2 font-normal text-muted-foreground">評級</th>
              </tr>
            </thead>
            <tbody>
              {sortedStats.map(g => {
                const isExpanded = expandedProduct === g.product_id;
                return (
                  <>
                    <tr
                      key={g.product_id}
                      className="border-b border-border/40 hover:bg-accent/30 cursor-pointer"
                      onClick={() =>
                        setExpandedProduct(isExpanded ? null : g.product_id)
                      }
                    >
                      <td className="px-2 py-1.5">
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        )}
                      </td>
                      <td className="px-2 py-1.5 font-medium" title={g.product_title}>
                        {g.product_title}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{g.vendor}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{g.num_skus}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(g.total_inventory)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                        {formatNumber(g.promo_qty)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                        {formatCurrency(g.promo_revenue)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                        {formatNumber(g.pre_promo_qty)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {g.lift_ratio === 999
                          ? '∞'
                          : g.lift_ratio === 0
                            ? '—'
                            : `${g.lift_ratio.toFixed(2)}×`}
                      </td>
                      <td className="px-2 py-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${RATING_COLOR[g.rating]}`}
                        >
                          {RATING_LABEL[g.rating]}
                        </span>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${g.product_id}-detail`} className="bg-muted/20 border-b border-border/40">
                        <td colSpan={10} className="px-3 py-2">
                          <div className="text-[10px] text-muted-foreground mb-1.5">
                            身下 SKU 明細：
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-[10px]">
                              <thead className="text-muted-foreground">
                                <tr>
                                  <th className="text-left py-1 font-normal">SKU</th>
                                  <th className="text-left py-1 font-normal">Variant</th>
                                  <th className="text-right py-1 font-normal">庫存</th>
                                  <th className="text-right py-1 font-normal">售價</th>
                                  <th className="text-right py-1 font-normal">推廣銷量</th>
                                  <th className="text-right py-1 font-normal">推廣營收</th>
                                  <th className="text-right py-1 font-normal">推廣前 90d 日均</th>
                                  <th className="text-left py-1 font-normal">最後銷售</th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.skus.map(s => (
                                  <tr key={s.sku} className="border-t border-border/20">
                                    <td className="py-1 font-mono">{s.sku}</td>
                                    <td className="py-1">{s.variant_title || '—'}</td>
                                    <td className="py-1 text-right tabular-nums">{formatNumber(s.inventory)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatCurrency(s.price)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatNumber(s.promo_qty)}</td>
                                    <td className="py-1 text-right tabular-nums">{formatCurrency(s.promo_revenue)}</td>
                                    <td className="py-1 text-right tabular-nums">{s.pre_promo_daily.toFixed(2)}</td>
                                    <td className="py-1 text-muted-foreground">
                                      {s.last_sold_at ? new Date(s.last_sold_at).toLocaleDateString('zh-HK') : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
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
    </div>
  );
}

function KpiCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className={`rounded-md border bg-card p-2 ${color ?? 'border-border/60'}`}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function FilterRow({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const allActive = selected.size === 0;
  return (
    <div className="flex items-start gap-2">
      <div className="text-[11px] text-muted-foreground shrink-0 w-10 pt-1">{label}</div>
      <div className="flex flex-wrap gap-1 flex-1">
        <button
          onClick={onClear}
          className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
            allActive
              ? 'bg-amber-500/20 border-amber-500/60 text-amber-200'
              : 'border-border/60 text-muted-foreground hover:bg-accent/40'
          }`}
        >
          全部
        </button>
        {options.map(opt => {
          const active = selected.has(opt);
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors inline-flex items-center gap-1 ${
                active
                  ? 'bg-amber-500/20 border-amber-500/60 text-amber-200'
                  : 'border-border/60 text-muted-foreground hover:bg-accent/40'
              }`}
              title={opt}
            >
              <span className="max-w-[180px] truncate">{opt}</span>
              {active && <span className="text-amber-300">×</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
