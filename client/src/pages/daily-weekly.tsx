import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAll, queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  DollarSign, ShoppingCart, TrendingUp, Calendar, Trophy, Package,
  ChevronDown, ChevronRight, AlertTriangle, Tag, Zap,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ── Types ─────────────────────────────────────────────────────
type ViewMode = 'yesterday' | 'this_week' | 'last_week';
type StockRisk = 'critical' | 'warning' | 'ok' | 'unknown';

interface EnrichedProduct {
  key: string;
  title: string;
  sku: string;
  vendor: string;
  productType: string;
  qty: number;
  revenue: number;
  stock: number | null;
  velocity: number;        // units per day (60-day avg)
  daysToStockout: number | null;
  risk: StockRisk;
}

interface CategorySummary {
  type: string;
  qty: number;
  revenue: number;
  brands: string[];
  products: EnrichedProduct[];
  criticalCount: number;
  warningCount: number;
}

// ── Date Helpers ──────────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function getYesterday(): string {
  const hkt = getHKNow(); hkt.setDate(hkt.getDate() - 1); return toDateStr(hkt);
}
function getSameDayLastWeek(): string {
  const hkt = getHKNow(); hkt.setDate(hkt.getDate() - 8); return toDateStr(hkt);
}
function getThisWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const diff = hkt.getDay() === 0 ? 6 : hkt.getDay() - 1;
  const monday = new Date(hkt); monday.setDate(hkt.getDate() - diff);
  return { from: toDateStr(monday), to: toDateStr(getHKNow()) };
}
function getLastWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const diff = hkt.getDay() === 0 ? 6 : hkt.getDay() - 1;
  const thisMonday = new Date(hkt); thisMonday.setDate(hkt.getDate() - diff);
  const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1);
  const lastMonday = new Date(lastSunday); lastMonday.setDate(lastSunday.getDate() - 6);
  return { from: toDateStr(lastMonday), to: toDateStr(lastSunday) };
}
function toHKTimeString(isoStr: string): string {
  const d = new Date(isoStr);
  const hkt = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${String(hkt.getHours()).padStart(2, '0')}:${String(hkt.getMinutes()).padStart(2, '0')}`;
}
function toHKDateStr(isoStr: string): string {
  const d = new Date(isoStr);
  return new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000).toISOString().slice(0, 10);
}

// ── Stock Risk ────────────────────────────────────────────────
function computeRisk(stock: number | null, velocity: number): { risk: StockRisk; days: number | null } {
  if (stock === null) return { risk: 'unknown', days: null };
  if (stock === 0) return { risk: 'critical', days: 0 };
  if (velocity < 0.005) return { risk: 'unknown', days: null };
  const days = Math.floor(stock / velocity);
  if (days <= 7) return { risk: 'critical', days };
  if (days <= 21) return { risk: 'warning', days };
  return { risk: 'ok', days };
}

function RiskBadge({ risk, days }: { risk: StockRisk; days: number | null }) {
  if (risk === 'critical')
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 whitespace-nowrap">
        🔴 {days === 0 ? '缺貨' : `${days}天`}
      </span>
    );
  if (risk === 'warning')
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-500/20 text-yellow-400 whitespace-nowrap">
        🟡 {days}天
      </span>
    );
  if (risk === 'ok')
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400 whitespace-nowrap">
        🟢 充足
      </span>
    );
  return <span className="text-[10px] text-muted-foreground/40">—</span>;
}

// ── Category Style ────────────────────────────────────────────
const CAT_GROUPS: Array<[string, { color: string; border: string; bg: string }]> = [
  ['HELMET',          { color: 'text-amber-400',   border: 'border-amber-500/30',   bg: 'bg-amber-500/5'   }],
  ['RIDER GEARS',     { color: 'text-blue-400',    border: 'border-blue-500/30',    bg: 'bg-blue-500/5'    }],
  ['ACCESSORIES',     { color: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' }],
  ['MOTORCYCLE PARTS',{ color: 'text-purple-400',  border: 'border-purple-500/30',  bg: 'bg-purple-500/5'  }],
];
function getCatStyle(type: string) {
  for (const [prefix, cfg] of CAT_GROUPS) {
    if (type.startsWith(prefix)) return cfg;
  }
  return { color: 'text-gray-400', border: 'border-gray-500/30', bg: 'bg-gray-500/5' };
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Main Component ────────────────────────────────────────────
export default function DailyWeeklyPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('yesterday');
  const [loading, setLoading] = useState(true);
  const [allOrders, setAllOrders] = useState<any[]>([]);
  const [allOrderLines, setAllOrderLines] = useState<any[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Record<string, number>>({});
  const [productTypeMap, setProductTypeMap] = useState<Record<string, string>>({});
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

  // ── Data Loading ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 16);
        const fromDate = twoWeeksAgo.toISOString().slice(0, 10);

        // Phase 1: parallel
        const [ordersRaw, orderLines, productsData] = await Promise.all([
          (async () => {
            const { data } = await supabase
              .from('shopify_orders')
              .select('id,order_number,created_at,total_price,financial_status,cancelled_at,customer_name,customer_id,discount_codes,source_name')
              .gte('created_at', fromDate)
              .limit(5000);
            return (data || []) as any[];
          })(),
          queryAllPages(
            'shopify_order_lines',
            'order_id,product_id,title,sku,vendor,quantity,price,product_type,created_at'
          ) as Promise<any[]>,
          queryAllPages('shopify_products', 'id,product_type') as Promise<any[]>,
        ]);

        if (cancelled) return;

        setAllOrders(ordersRaw.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at));
        setAllOrderLines(orderLines);

        // Build product_id → product_type lookup
        const ptMap: Record<string, string> = {};
        productsData.forEach((p: any) => {
          if (p.id && p.product_type) ptMap[String(p.id)] = p.product_type;
        });
        setProductTypeMap(ptMap);

        // Phase 2: batch inventory for sold SKUs
        const skuList = [...new Set(orderLines.map((l: any) => l.sku).filter(Boolean))] as string[];
        const invMap: Record<string, number> = {};
        const BATCH = 100;
        for (let i = 0; i < skuList.length; i += BATCH) {
          if (cancelled) break;
          const { data: invData } = await supabase
            .from('shopify_inventory')
            .select('sku,inventory_quantity')
            .in('sku', skuList.slice(i, i + BATCH));
          (invData || []).forEach((r: any) => {
            if (r.sku) invMap[r.sku] = Math.max(0, r.inventory_quantity || 0);
          });
        }
        if (!cancelled) setInventoryMap(invMap);
      } catch (e) {
        console.error('Daily/Weekly load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Static date values ────────────────────────────────────
  const yesterday     = useMemo(() => getYesterday(), []);
  const sameDayLW     = useMemo(() => getSameDayLastWeek(), []);
  const thisWeek      = useMemo(() => getThisWeekBounds(), []);
  const lastWeek      = useMemo(() => getLastWeekBounds(), []);

  const filterOrders = useCallback(
    (orders: any[], from: string, to: string) =>
      orders.filter((o: any) => { const d = toHKDateStr(o.created_at); return d >= from && d <= to; }),
    []
  );

  // ── Velocity: units per day over last 60 days ─────────────
  const velocityMap = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString();
    const qMap: Record<string, number> = {};
    allOrderLines.forEach((l: any) => {
      if (l.created_at >= cutoffStr && l.sku)
        qMap[l.sku] = (qMap[l.sku] || 0) + (l.quantity || 0);
    });
    const vMap: Record<string, number> = {};
    Object.entries(qMap).forEach(([k, v]) => { vMap[k] = v / 60; });
    return vMap;
  }, [allOrderLines]);

  // ── Yesterday orders ──────────────────────────────────────
  const yOrders  = useMemo(() => filterOrders(allOrders, yesterday, yesterday),  [allOrders, yesterday, filterOrders]);
  const lwOrders = useMemo(() => filterOrders(allOrders, sameDayLW, sameDayLW),  [allOrders, sameDayLW,  filterOrders]);
  const yRevenue  = useMemo(() => yOrders.reduce( (s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [yOrders]);
  const lwRevenue = useMemo(() => lwOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [lwOrders]);
  const yAov  = yOrders.length  > 0 ? yRevenue  / yOrders.length  : 0;
  const lwAov = lwOrders.length > 0 ? lwRevenue / lwOrders.length : 0;
  const calcDelta = (curr: number, prev: number) => prev === 0 ? null : ((curr - prev) / prev) * 100;

  // ── Enrich product entry ──────────────────────────────────
  const enrichProduct = useCallback(
    (key: string, base: { title: string; sku: string; vendor: string; productType: string; qty: number; revenue: number }): EnrichedProduct => {
      const stock    = base.sku && base.sku in inventoryMap ? inventoryMap[base.sku] : null;
      const velocity = base.sku ? (velocityMap[base.sku] || 0) : 0;
      const { risk, days } = computeRisk(stock, velocity);
      return { key, ...base, stock, velocity, daysToStockout: days, risk };
    },
    [inventoryMap, velocityMap]
  );

  // ── Yesterday products (enriched) ────────────────────────
  const yProducts = useMemo((): EnrichedProduct[] => {
    const orderIds = new Set(yOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => orderIds.has(l.order_id));
    const map: Record<string, { title: string; sku: string; vendor: string; productType: string; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => {
      const k = l.product_id ? String(l.product_id) : (l.title || 'unknown');
      const pt = l.product_type || productTypeMap[String(l.product_id)] || 'Other';
      if (!map[k]) {
        map[k] = { title: l.title || '', sku: l.sku || '', vendor: l.vendor || '', productType: pt, qty: 0, revenue: 0 };
      }
      map[k].qty     += l.quantity || 0;
      map[k].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
      if (!map[k].sku && l.sku) map[k].sku = l.sku;
      if ((!map[k].productType || map[k].productType === 'Other') && pt !== 'Other') map[k].productType = pt;
    });
    return Object.entries(map)
      .map(([k, v]) => enrichProduct(k, v))
      .sort((a, b) => b.qty - a.qty);
  }, [yOrders, allOrderLines, productTypeMap, enrichProduct]);

  // ── Category breakdown for yesterday ─────────────────────
  const catBreakdown = useMemo((): CategorySummary[] => {
    const catMap: Record<string, CategorySummary> = {};
    yProducts.forEach(p => {
      const type = p.productType || 'Other';
      if (!catMap[type]) catMap[type] = { type, qty: 0, revenue: 0, brands: [], products: [], criticalCount: 0, warningCount: 0 };
      catMap[type].qty     += p.qty;
      catMap[type].revenue += p.revenue;
      catMap[type].products.push(p);
      if (p.vendor && !catMap[type].brands.includes(p.vendor)) catMap[type].brands.push(p.vendor);
      if (p.risk === 'critical') catMap[type].criticalCount++;
      else if (p.risk === 'warning') catMap[type].warningCount++;
    });
    return Object.values(catMap).sort((a, b) => b.revenue - a.revenue);
  }, [yProducts]);

  // ── Yesterday order list ──────────────────────────────────
  const yOrderList = useMemo(() =>
    [...yOrders]
      .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20)
      .map((o: any) => {
        const lines = allOrderLines.filter((l: any) => l.order_id === o.id);
        return { ...o, itemCount: lines.reduce((s: number, l: any) => s + (l.quantity || 0), 0), time: toHKTimeString(o.created_at) };
      }),
    [yOrders, allOrderLines]
  );

  // ── Week data ─────────────────────────────────────────────
  const isWeekView = viewMode !== 'yesterday';
  const wkBounds = useMemo(() => viewMode === 'last_week' ? lastWeek : thisWeek, [viewMode, lastWeek, thisWeek]);
  const prevWkBounds = useMemo(() => {
    if (viewMode === 'last_week') {
      const d1 = new Date(lastWeek.from); d1.setDate(d1.getDate() - 7);
      const d2 = new Date(lastWeek.to);   d2.setDate(d2.getDate() - 7);
      return { from: toDateStr(d1), to: toDateStr(d2) };
    }
    return lastWeek;
  }, [viewMode, lastWeek]);

  const weekOrders    = useMemo(() => filterOrders(allOrders, wkBounds.from, wkBounds.to),       [allOrders, wkBounds,    filterOrders]);
  const prevWkOrders  = useMemo(() => filterOrders(allOrders, prevWkBounds.from, prevWkBounds.to),[allOrders, prevWkBounds, filterOrders]);
  const wRevenue  = useMemo(() => weekOrders.reduce(   (s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [weekOrders]);
  const pwRevenue = useMemo(() => prevWkOrders.reduce( (s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [prevWkOrders]);

  const bestDay = useMemo(() => {
    const dm: Record<string, number> = {};
    weekOrders.forEach((o: any) => {
      const d = toHKDateStr(o.created_at);
      dm[d] = (dm[d] || 0) + (parseFloat(o.total_price) || 0);
    });
    const entries = Object.entries(dm).sort((a, b) => b[1] - a[1]);
    return entries[0] ? { date: entries[0][0], revenue: entries[0][1] } : { date: '', revenue: 0 };
  }, [weekOrders]);

  const bestProduct = useMemo(() => {
    const ids = new Set(weekOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => ids.has(l.order_id));
    const pm: Record<string, { title: string; qty: number }> = {};
    lines.forEach((l: any) => {
      const k = l.title || String(l.product_id);
      if (!pm[k]) pm[k] = { title: l.title || k, qty: 0 };
      pm[k].qty += l.quantity || 0;
    });
    return Object.values(pm).sort((a, b) => b.qty - a.qty)[0] || { title: '—', qty: 0 };
  }, [weekOrders, allOrderLines]);

  const weeklyBarData = useMemo(() => {
    const start = new Date(wkBounds.from + 'T00:00:00');
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const rev = filterOrders(allOrders, ds, ds).reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
      return { day: DAY_NAMES[i], revenue: rev };
    });
  }, [allOrders, wkBounds, filterOrders]);

  const weekTopProducts = useMemo(() => {
    const ids = new Set(weekOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => ids.has(l.order_id));
    const pm: Record<string, { title: string; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => {
      const k = l.title || String(l.product_id);
      if (!pm[k]) pm[k] = { title: l.title || k, qty: 0, revenue: 0 };
      pm[k].qty     += l.quantity || 0;
      pm[k].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.values(pm).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [weekOrders, allOrderLines]);

  // Week category breakdown (for table)
  const weekCatBreakdown = useMemo(() => {
    const ids = new Set(weekOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => ids.has(l.order_id));
    const cm: Record<string, { type: string; qty: number; revenue: number; brands: Set<string>; skus: number }> = {};
    lines.forEach((l: any) => {
      const type = l.product_type || productTypeMap[String(l.product_id)] || 'Other';
      if (!cm[type]) cm[type] = { type, qty: 0, revenue: 0, brands: new Set(), skus: 0 };
      cm[type].qty     += l.quantity || 0;
      cm[type].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
      if (l.vendor) cm[type].brands.add(l.vendor);
      cm[type].skus++;
    });
    return Object.values(cm)
      .map(c => ({ ...c, brands: [...c.brands] }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [weekOrders, allOrderLines, productTypeMap]);

  const toggleCat = useCallback((type: string) => {
    setExpandedCats(prev => {
      const n = new Set(prev);
      n.has(type) ? n.delete(type) : n.add(type);
      return n;
    });
  }, []);

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* View Toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['yesterday', 'this_week', 'last_week'] as ViewMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            data-testid={`btn-view-${mode}`}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              viewMode === mode
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent/50 text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            {mode === 'yesterday' ? '昨日 Yesterday' : mode === 'this_week' ? '本週 This Week' : '上週 Last Week'}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">
          {viewMode === 'yesterday' ? yesterday : `${wkBounds.from} → ${wkBounds.to}`}
        </span>
      </div>

      {/* ═══════════════════════════ YESTERDAY VIEW ════════════════════════════ */}
      {viewMode === 'yesterday' && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="昨日營收" subtitle="Revenue"       value={formatCurrency(yRevenue)}       icon={DollarSign}  loading={loading} delta={calcDelta(yRevenue,      lwRevenue)}      testId="kpi-y-rev" />
            <KpiCard title="昨日訂單" subtitle="Orders"        value={formatNumber(yOrders.length)}   icon={ShoppingCart} loading={loading} delta={calcDelta(yOrders.length, lwOrders.length)} testId="kpi-y-orders" />
            <KpiCard title="昨日均價" subtitle="AOV"           value={formatCurrency(yAov)}           icon={TrendingUp}  loading={loading} delta={calcDelta(yAov,          lwAov)}           testId="kpi-y-aov" />
            <KpiCard title="上週同日" subtitle="Same Day LW"   value={formatCurrency(lwRevenue)}      icon={Calendar}    loading={loading}                                                    testId="kpi-y-lw" />
          </div>

          {/* ── Category Breakdown ───────────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
                <Tag className="h-3.5 w-3.5 text-primary shrink-0" />
                按類別分析
                <span className="text-xs font-normal text-muted-foreground">Category Breakdown — {yesterday}</span>
                {catBreakdown.some(c => c.criticalCount > 0) && (
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-red-400 shrink-0">
                    <AlertTriangle className="h-3 w-3" /> 有庫存緊張貨品
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
                </div>
              ) : catBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">昨日無銷售數據</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {catBreakdown.map(cat => {
                    const style    = getCatStyle(cat.type);
                    const expanded = expandedCats.has(cat.type);
                    return (
                      <div key={cat.type} className={`rounded-lg border ${style.border} overflow-hidden`}>
                        {/* Card Header (always visible, clickable) */}
                        <button
                          className={`w-full px-3 py-2.5 text-left ${style.bg} hover:brightness-110 transition-all`}
                          onClick={() => toggleCat(cat.type)}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className={`text-[11px] font-semibold ${style.color} truncate flex-1 text-left`}>
                              {cat.type}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {cat.criticalCount > 0 && (
                                <span className="text-[10px] bg-red-500/20 text-red-400 px-1 py-0.5 rounded">🔴{cat.criticalCount}</span>
                              )}
                              {cat.warningCount > 0 && (
                                <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1 py-0.5 rounded">🟡{cat.warningCount}</span>
                              )}
                              {expanded
                                ? <ChevronDown  className="h-3.5 w-3.5 text-muted-foreground" />
                                : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              }
                            </div>
                          </div>
                          {/* Revenue + Qty */}
                          <div className="flex items-baseline gap-2 mt-1">
                            <span className="text-sm font-bold tabular-nums">{formatCurrency(cat.revenue)}</span>
                            <span className="text-xs text-muted-foreground">{cat.qty}件</span>
                          </div>
                          {/* Brand tags */}
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {cat.brands.slice(0, 5).map(b => (
                              <span key={b} className="text-[10px] bg-background/60 border border-border/30 text-muted-foreground px-1.5 py-0.5 rounded">
                                {b}
                              </span>
                            ))}
                            {cat.brands.length > 5 && (
                              <span className="text-[10px] text-muted-foreground/50">+{cat.brands.length - 5}品牌</span>
                            )}
                          </div>
                        </button>

                        {/* Expanded: Product breakdown with stock + velocity */}
                        {expanded && (
                          <div className="border-t border-border/30 bg-background/40">
                            {/* Column headers */}
                            <div className="px-3 py-1.5 grid grid-cols-[1fr_28px_36px_48px_60px] gap-x-2 text-[10px] text-muted-foreground/60 border-b border-border/20">
                              <span>產品</span>
                              <span className="text-right">售</span>
                              <span className="text-right">庫存</span>
                              <span className="text-right">速率/日</span>
                              <span className="text-right">預測</span>
                            </div>
                            {cat.products.map((p, idx) => (
                              <div
                                key={idx}
                                className={`px-3 py-1.5 grid grid-cols-[1fr_28px_36px_48px_60px] gap-x-2 items-center text-[11px] border-b border-border/10 last:border-0 ${
                                  p.risk === 'critical' ? 'bg-red-500/5' :
                                  p.risk === 'warning'  ? 'bg-yellow-500/5' : ''
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-medium leading-tight">{p.title}</div>
                                  <div className="text-[10px] text-muted-foreground/50 truncate">{p.vendor}</div>
                                </div>
                                <span className="text-right tabular-nums font-semibold">{p.qty}</span>
                                <span className={`text-right tabular-nums font-semibold ${
                                  p.stock === 0          ? 'text-red-400' :
                                  p.stock !== null && p.stock <= 5 ? 'text-yellow-400' : ''
                                }`}>
                                  {p.stock !== null ? p.stock : '—'}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {p.velocity >= 0.01 ? p.velocity.toFixed(2) : p.velocity > 0 ? '<0.01' : '—'}
                                </span>
                                <span className="text-right">
                                  <RiskBadge risk={p.risk} days={p.daysToStockout} />
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Products Table (enhanced with stock + velocity) ── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-medium">
                  昨日產品明細
                  <span className="text-xs font-normal text-muted-foreground ml-1">Yesterday's Products</span>
                </CardTitle>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> 缺貨/≤7天</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" /> 注意 ≤21天</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> 充足</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-[300px] w-full" />
              ) : yProducts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">昨日無銷售數據</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-yesterday-products">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium w-6">#</th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium hidden md:table-cell">類別 Category</th>
                        <th className="py-2 text-left font-medium">品牌</th>
                        <th className="py-2 text-right font-medium">售出</th>
                        <th className="py-2 text-right font-medium">營收</th>
                        <th className="py-2 text-right font-medium">剩餘庫存</th>
                        <th className="py-2 text-right font-medium hidden lg:table-cell">銷售速率</th>
                        <th className="py-2 text-right font-medium">預計缺貨</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yProducts.map((p, i) => (
                        <tr
                          key={p.key}
                          className={`border-b border-border/20 transition-colors ${
                            p.risk === 'critical' ? 'bg-red-500/5 hover:bg-red-500/10' :
                            p.risk === 'warning'  ? 'bg-yellow-500/5 hover:bg-yellow-500/10' :
                            'hover:bg-accent/30'
                          }`}
                        >
                          <td className="py-2 text-muted-foreground tabular-nums">{i + 1}</td>
                          <td className="py-2 max-w-[160px]">
                            <div className="truncate font-medium">{p.title}</div>
                            {p.sku && <div className="text-[10px] font-mono text-muted-foreground/50">{p.sku}</div>}
                          </td>
                          <td className="py-2 hidden md:table-cell">
                            <span className={`text-[10px] ${getCatStyle(p.productType).color}`}>{p.productType}</span>
                          </td>
                          <td className="py-2 text-muted-foreground text-[11px]">{p.vendor || '—'}</td>
                          <td className="py-2 text-right tabular-nums font-bold">{p.qty}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                          <td className={`py-2 text-right tabular-nums font-semibold ${
                            p.stock === null         ? 'text-muted-foreground/40' :
                            p.stock === 0            ? 'text-red-400 font-bold'  :
                            p.stock <= 3             ? 'text-yellow-400'          :
                            p.stock <= 10            ? 'text-amber-400'           : ''
                          }`}>
                            {p.stock !== null ? p.stock : '—'}
                          </td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground hidden lg:table-cell">
                            {p.velocity >= 0.01
                              ? `${p.velocity.toFixed(2)}/日`
                              : p.velocity > 0 ? '<0.01/日'
                              : '—'
                            }
                          </td>
                          <td className="py-2 text-right">
                            <RiskBadge risk={p.risk} days={p.daysToStockout} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Yesterday Orders ─────────────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                昨日訂單 <span className="text-xs font-normal text-muted-foreground">Yesterday's Orders (last 20)</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-[300px] w-full" />
              ) : yOrderList.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">昨日無訂單</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-yesterday-orders">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">訂單 Order#</th>
                        <th className="py-2 text-left font-medium">時間 Time</th>
                        <th className="py-2 text-left font-medium">客戶 Customer</th>
                        <th className="py-2 text-right font-medium">件數</th>
                        <th className="py-2 text-right font-medium">金額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yOrderList.map((o: any) => (
                        <tr key={o.id} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2 tabular-nums">#{o.order_number}</td>
                          <td className="py-2 text-muted-foreground">{o.time}</td>
                          <td className="py-2">{o.customer_name || '—'}</td>
                          <td className="py-2 text-right tabular-nums">{o.itemCount}</td>
                          <td className="py-2 text-right tabular-nums font-medium">{formatCurrency(parseFloat(o.total_price))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ═══════════════════════════ WEEK VIEW ═════════════════════════════════ */}
      {isWeekView && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="週營收"   subtitle="Week Revenue"  value={formatCurrency(wRevenue)}       icon={DollarSign}   loading={loading} delta={calcDelta(wRevenue, pwRevenue)}                          testId="kpi-w-rev" />
            <KpiCard title="週訂單"   subtitle="Week Orders"   value={formatNumber(weekOrders.length)} icon={ShoppingCart} loading={loading} delta={calcDelta(weekOrders.length, prevWkOrders.length)}       testId="kpi-w-orders" />
            <KpiCard title="最佳日"   subtitle="Best Day"      value={bestDay.date ? `${bestDay.date.slice(5)} ${formatCurrency(bestDay.revenue)}` : '—'} icon={Trophy} loading={loading}                  testId="kpi-w-bestday" />
            <KpiCard title="最暢銷"   subtitle="Best Product"  value={bestProduct.title.length > 20 ? bestProduct.title.slice(0, 20) + '…' : bestProduct.title} icon={Package} loading={loading}           testId="kpi-w-bestprod" />
          </div>

          {/* Daily Revenue Chart */}
          <ChartCard title="每日營收" subtitle={`Weekly Revenue (${viewMode === 'last_week' ? 'Last Week' : 'This Week'})`} loading={loading}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={weeklyBarData}>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="day" tick={AXIS_STYLE} />
                <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ── Week Category Breakdown ──────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Tag className="h-3.5 w-3.5 text-primary" />
                本週類別表現
                <span className="text-xs font-normal text-muted-foreground">Weekly Category Breakdown</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-48 w-full" />
              ) : weekCatBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">本週無數據</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">類別 Category</th>
                        <th className="py-2 text-right font-medium">件數</th>
                        <th className="py-2 text-right font-medium">週營收</th>
                        <th className="py-2 text-right font-medium">均單價</th>
                        <th className="py-2 text-left font-medium pl-3">品牌組成</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weekCatBreakdown.map((cat, i) => {
                        const style = getCatStyle(cat.type);
                        return (
                          <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                            <td className={`py-2 font-medium ${style.color}`}>{cat.type}</td>
                            <td className="py-2 text-right tabular-nums">{cat.qty}</td>
                            <td className="py-2 text-right tabular-nums font-semibold">{formatCurrency(cat.revenue)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">
                              {formatCurrency(cat.qty > 0 ? cat.revenue / cat.qty : 0)}
                            </td>
                            <td className="py-2 pl-3">
                              <div className="flex flex-wrap gap-1">
                                {cat.brands.slice(0, 5).map(b => (
                                  <span key={b} className="text-[10px] bg-accent/60 text-muted-foreground px-1.5 py-0.5 rounded">{b}</span>
                                ))}
                                {cat.brands.length > 5 && (
                                  <span className="text-[10px] text-muted-foreground/50">+{cat.brands.length - 5}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top 10 Products */}
          <ChartCard title="本週暢銷 Top 10" subtitle="Top Products This Week" loading={loading}>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={weekTopProducts} layout="vertical">
                <CartesianGrid {...GRID_STYLE} />
                <XAxis type="number" tick={AXIS_STYLE} />
                <YAxis type="category" dataKey="title" tick={AXIS_STYLE} width={160}
                  tickFormatter={(v: string) => v.length > 22 ? v.slice(0, 22) + '…' : v} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => name === 'qty' ? v : formatCurrency(v)} />
                <Bar dataKey="qty" name="數量 Qty" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}
    </div>
  );
}
