import { useEffect, useState, useMemo, useCallback } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  DollarSign, ShoppingCart, TrendingUp, TrendingDown, Tag, Package,
  Users, BarChart2, CheckCircle, AlertCircle, XCircle, Zap, Info,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

// ── Types ──────────────────────────────────────────────────────────────
type WeekMode = 'this' | 'last' | 'two';
type TabKey   = 'overview' | 'deepdive' | 'actions';

// ── Date Helpers ───────────────────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function getWeekBounds(offset: number): { from: string; to: string } {
  const hkt = getHKNow();
  const diff = hkt.getDay() === 0 ? 6 : hkt.getDay() - 1;
  const thisMonday = new Date(hkt);
  thisMonday.setDate(hkt.getDate() - diff - offset * 7);
  const thisSunday = new Date(thisMonday);
  thisSunday.setDate(thisMonday.getDate() + 6);
  return {
    from: toDateStr(thisMonday),
    to: toDateStr(thisSunday),
  };
}
function getMtdBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const from = new Date(hkt.getFullYear(), hkt.getMonth(), 1);
  return { from: toDateStr(from), to: toDateStr(hkt) };
}

// ── Utility ────────────────────────────────────────────────────────────
function pct(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}
function fmtPct(v: number | null): string {
  if (v === null) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}
function pctColor(v: number | null): string {
  if (v === null) return 'text-muted-foreground';
  return v >= 0 ? 'text-emerald-400' : 'text-red-400';
}

// ── Data Processor ─────────────────────────────────────────────────────
interface WeekData {
  revenue: number;
  orders: number;
  aov: number;
  refunds: number;
  refundAmount: number;
  brandMap: Record<string, { qty: number; revenue: number }>;
  catMap: Record<string, { qty: number; revenue: number }>;
  promoCodes: Record<string, { uses: number; discountAmt: number; revenue: number }>;
  topSkus: { title: string; sku: string; vendor: string; qty: number; revenue: number }[];
}

function processOrders(
  ordersRaw: any[],
  linesRaw: any[],
  from: string,
  to: string
): WeekData {
  const toStr = to + '\xff';
  const validOrders = ordersRaw.filter((o: any) => {
    const d = (o.created_at || '').slice(0, 10);
    return d >= from && d <= toStr && o.financial_status !== 'refunded' && !o.cancelled_at;
  });
  const refundedOrders = ordersRaw.filter((o: any) => {
    const d = (o.created_at || '').slice(0, 10);
    return d >= from && d <= toStr && (o.financial_status === 'refunded' || o.cancelled_at);
  });

  const orderIds = new Set(validOrders.map((o: any) => o.id));
  const lines = linesRaw.filter((l: any) => orderIds.has(l.order_id));

  const revenue = validOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
  const orders  = validOrders.length;
  const aov     = orders > 0 ? revenue / orders : 0;

  const refunds      = refundedOrders.length;
  const refundAmount = refundedOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);

  // Brand map
  const brandMap: Record<string, { qty: number; revenue: number }> = {};
  const catMap:   Record<string, { qty: number; revenue: number }> = {};
  const skuMap:   Record<string, { title: string; sku: string; vendor: string; qty: number; revenue: number }> = {};

  for (const l of lines) {
    const brand = l.vendor || 'Unknown';
    const cat   = l.product_type || 'Other';
    const sku   = l.sku || l.title || '';
    const qty   = l.quantity || 0;
    const rev   = (parseFloat(l.price) || 0) * qty;

    if (!brandMap[brand]) brandMap[brand] = { qty: 0, revenue: 0 };
    brandMap[brand].qty     += qty;
    brandMap[brand].revenue += rev;

    if (!catMap[cat]) catMap[cat] = { qty: 0, revenue: 0 };
    catMap[cat].qty     += qty;
    catMap[cat].revenue += rev;

    if (!skuMap[sku]) skuMap[sku] = { title: l.title || sku, sku, vendor: l.vendor || '', qty: 0, revenue: 0 };
    skuMap[sku].qty     += qty;
    skuMap[sku].revenue += rev;
  }

  // Promo codes from orders
  const promoCodes: Record<string, { uses: number; discountAmt: number; revenue: number }> = {};
  for (const o of validOrders) {
    let codes: string[] = [];
    try {
      const dc = o.discount_codes;
      if (typeof dc === 'string' && dc.startsWith('[')) {
        const parsed = JSON.parse(dc);
        codes = parsed.map((c: any) => String(c.code || '')).filter(Boolean);
      } else if (Array.isArray(dc)) {
        codes = dc.map((c: any) => String(c.code || '')).filter(Boolean);
      }
    } catch { /* ignore parse errors */ }
    for (const code of codes) {
      if (!promoCodes[code]) promoCodes[code] = { uses: 0, discountAmt: 0, revenue: 0 };
      promoCodes[code].uses++;
      promoCodes[code].discountAmt += parseFloat(o.total_discounts) || 0;
      promoCodes[code].revenue     += parseFloat(o.total_price) || 0;
    }
  }

  const topSkus = Object.values(skuMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return { revenue, orders, aov, refunds, refundAmount, brandMap, catMap, promoCodes, topSkus };
}

// ── Main Component ─────────────────────────────────────────────────────
export default function WeeklyReviewPage() {
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<TabKey>('overview');
  const [weekMode, setWeekMode] = useState<WeekMode>('this');

  // Raw data
  const [ordersRaw, setOrdersRaw]   = useState<any[]>([]);
  const [linesRaw, setLinesRaw]     = useState<any[]>([]);
  const [inventoryRaw, setInventoryRaw] = useState<any[]>([]);
  const [productsRaw, setProductsRaw]   = useState<any[]>([]);
  const [membersRaw, setMembersRaw]     = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [orders, lines, inventory, products, members] = await Promise.all([
          queryAllPages('shopify_orders', 'id,order_number,created_at,total_price,total_discounts,financial_status,cancelled_at,discount_codes'),
          queryAllPages('shopify_order_lines', 'order_id,product_id,sku,title,vendor,product_type,quantity,price,created_at'),
          queryAllPages('shopify_inventory', 'product_id,sku,product_title,price,inventory_quantity,vendor,product_type,snapshot_date'),
          queryAllPages('shopify_products', 'id,title,product_type,vendor,status,created_at'),
          queryAllPages('marsello_customers', 'id,created_at,total_spend,total_orders'),
        ]);
        if (cancelled) return;
        setOrdersRaw(orders);
        setLinesRaw(lines);
        setInventoryRaw(inventory);
        setProductsRaw(products);
        setMembersRaw(members);
      } catch (e) {
        console.error('WeeklyReview error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Week bounds based on mode
  const weekOffset = weekMode === 'this' ? 0 : weekMode === 'last' ? 1 : 2;
  const currBounds = useMemo(() => getWeekBounds(weekOffset), [weekOffset]);
  const prevBounds = useMemo(() => getWeekBounds(weekOffset + 1), [weekOffset]);
  const mtdBounds  = useMemo(() => getMtdBounds(), []);

  // Process current + previous week
  const curr = useMemo(
    () => processOrders(ordersRaw, linesRaw, currBounds.from, currBounds.to),
    [ordersRaw, linesRaw, currBounds]
  );
  const prev = useMemo(
    () => processOrders(ordersRaw, linesRaw, prevBounds.from, prevBounds.to),
    [ordersRaw, linesRaw, prevBounds]
  );

  // MTD
  const mtd = useMemo(
    () => processOrders(ordersRaw, linesRaw, mtdBounds.from, mtdBounds.to),
    [ordersRaw, linesRaw, mtdBounds]
  );

  // MTD members
  const mtdMembers = useMemo(() => {
    return membersRaw.filter((m: any) => {
      const d = (m.created_at || '').slice(0, 10);
      return d >= mtdBounds.from && d <= mtdBounds.to + '\xff';
    }).length;
  }, [membersRaw, mtdBounds]);

  // Brand performance table
  const brandPerf = useMemo(() => {
    const brands = new Set([...Object.keys(curr.brandMap), ...Object.keys(prev.brandMap)]);
    return Array.from(brands)
      .map((b) => {
        const cRev = curr.brandMap[b]?.revenue || 0;
        const pRev = prev.brandMap[b]?.revenue || 0;
        const cQty = curr.brandMap[b]?.qty || 0;
        const chg  = pct(cRev, pRev);
        return { brand: b, currRev: cRev, prevRev: pRev, currQty: cQty, chg };
      })
      .filter((b) => b.currRev > 0 || b.prevRev > 0)
      .sort((a, b) => b.currRev - a.currRev);
  }, [curr, prev]);

  // Category performance
  const totalCatRev = useMemo(
    () => Object.values(curr.catMap).reduce((s, c) => s + c.revenue, 0),
    [curr]
  );
  const catPerf = useMemo(() => {
    return Object.entries(curr.catMap)
      .map(([cat, d]) => ({
        cat,
        qty: d.qty,
        revenue: d.revenue,
        pctTotal: totalCatRev > 0 ? (d.revenue / totalCatRev) * 100 : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [curr, totalCatRev]);

  // Promo codes
  const promoArr = useMemo(() => {
    return Object.entries(curr.promoCodes)
      .map(([code, d]) => ({ code, ...d }))
      .sort((a, b) => b.uses - a.uses);
  }, [curr]);

  // Inventory map (latest snapshot per SKU)
  const invMap = useMemo(() => {
    const m: Record<string, { stock: number; price: number; title: string; vendor: string; productType: string; snap: string }> = {};
    for (const inv of inventoryRaw) {
      const sku = inv.sku || '';
      if (!sku) continue;
      if (!m[sku] || (inv.snapshot_date || '') > m[sku].snap) {
        m[sku] = {
          stock: inv.inventory_quantity ?? 0,
          price: parseFloat(inv.price) || 0,
          title: inv.product_title || '',
          vendor: inv.vendor || '',
          productType: inv.product_type || '',
          snap: inv.snapshot_date || '',
        };
      }
    }
    return m;
  }, [inventoryRaw]);

  // Sales in 60d per SKU
  const sold60Map = useMemo(() => {
    const sixtyAgo = new Date(getHKNow().getTime() - 60 * 86400000).toISOString().slice(0, 10);
    const m: Record<string, number> = {};
    for (const l of linesRaw) {
      if ((l.created_at || '') >= sixtyAgo && l.sku) {
        m[l.sku] = (m[l.sku] || 0) + (l.quantity || 0);
      }
    }
    return m;
  }, [linesRaw]);

  // Dead stock: inventory > 0, no sales in 60d
  const deadStock = useMemo(() => {
    return Object.entries(invMap)
      .filter(([sku, inv]) => inv.stock > 0 && !sold60Map[sku])
      .map(([sku, inv]) => ({
        sku,
        title: inv.title,
        vendor: inv.vendor,
        productType: inv.productType,
        stock: inv.stock,
        price: inv.price,
        stockValue: inv.stock * inv.price,
      }))
      .sort((a, b) => b.stockValue - a.stockValue)
      .slice(0, 20);
  }, [invMap, sold60Map]);

  // Brand GMROI
  const brandGmroi = useMemo(() => {
    const mtdLinesByBrand: Record<string, { revenue: number; skus: Set<string> }> = {};
    const mtdFrom = mtdBounds.from;
    const mtdTo   = mtdBounds.to + '\xff';
    const mtdOrderIds = new Set(
      ordersRaw
        .filter((o: any) => {
          const d = (o.created_at || '').slice(0, 10);
          return d >= mtdFrom && d <= mtdTo && o.financial_status !== 'refunded' && !o.cancelled_at;
        })
        .map((o: any) => o.id)
    );

    for (const l of linesRaw) {
      if (!mtdOrderIds.has(l.order_id)) continue;
      const brand = l.vendor || 'Unknown';
      if (!mtdLinesByBrand[brand]) mtdLinesByBrand[brand] = { revenue: 0, skus: new Set() };
      mtdLinesByBrand[brand].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
      if (l.sku) mtdLinesByBrand[brand].skus.add(l.sku);
    }

    // Stock value per brand from inventory
    const brandStockVal: Record<string, number> = {};
    for (const [_sku, inv] of Object.entries(invMap)) {
      const brand = inv.vendor;
      brandStockVal[brand] = (brandStockVal[brand] || 0) + inv.stock * inv.price;
    }

    return Object.entries(mtdLinesByBrand)
      .map(([brand, d]) => {
        const stockVal = brandStockVal[brand] || 0;
        const gmroi    = stockVal > 0 ? d.revenue / stockVal : 0;
        return { brand, revenue: d.revenue, skus: d.skus.size, stockValue: stockVal, gmroi };
      })
      .sort((a, b) => b.gmroi - a.gmroi)
      .slice(0, 15);
  }, [linesRaw, ordersRaw, invMap, mtdBounds]);

  // Sell-through by category
  const sellThrough = useMemo(() => {
    const invByType: Record<string, { units: number }> = {};
    for (const [_sku, inv] of Object.entries(invMap)) {
      const t = inv.productType || 'Other';
      if (!invByType[t]) invByType[t] = { units: 0 };
      invByType[t].units += inv.stock;
    }
    return Object.entries(curr.catMap)
      .map(([cat, d]) => {
        const invUnits  = invByType[cat]?.units || 0;
        const total     = invUnits + d.qty;
        const stPct     = total > 0 ? (d.qty / total) * 100 : 0;
        return { cat, invUnits, soldQty: d.qty, stPct };
      })
      .sort((a, b) => b.stPct - a.stPct);
  }, [curr, invMap]);

  // New products 30/60d performance
  const newProdPerf = useMemo(() => {
    const sixtyAgo  = new Date(getHKNow().getTime() - 60  * 86400000).toISOString().slice(0, 10);
    const thirtyAgo = new Date(getHKNow().getTime() - 30  * 86400000).toISOString().slice(0, 10);
    const ninetyAgo = new Date(getHKNow().getTime() - 90  * 86400000).toISOString().slice(0, 10);

    const newProds = productsRaw.filter((p: any) => {
      const d = (p.created_at || '').slice(0, 10);
      return d >= ninetyAgo && p.status === 'active';
    });

    const sales60: Record<string, number> = {};
    const sales30: Record<string, number> = {};
    const rev60:   Record<string, number> = {};

    for (const l of linesRaw) {
      const pid = String(l.product_id || '');
      const d   = (l.created_at || '').slice(0, 10);
      if (d >= sixtyAgo) {
        sales60[pid] = (sales60[pid] || 0) + (l.quantity || 0);
        rev60[pid]   = (rev60[pid]   || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0);
      }
      if (d >= thirtyAgo) {
        sales30[pid] = (sales30[pid] || 0) + (l.quantity || 0);
      }
    }

    return newProds
      .map((p: any) => ({
        id:    String(p.id),
        title: p.title || '',
        vendor: p.vendor || '',
        createdAt: (p.created_at || '').slice(0, 10),
        qty30: sales30[String(p.id)] || 0,
        qty60: sales60[String(p.id)] || 0,
        rev60: rev60[String(p.id)]   || 0,
      }))
      .sort((a: any, b: any) => b.rev60 - a.rev60)
      .slice(0, 15);
  }, [productsRaw, linesRaw]);

  // Action items
  const actions = useMemo(() => {
    // Continue: top 3 brands by revenue growth vs last week
    const continueList = brandPerf
      .filter((b) => (b.chg ?? 0) > 0)
      .sort((a, b) => (b.chg ?? 0) - (a.chg ?? 0))
      .slice(0, 3);

    // Adjust: brands with revenue drop > 20%
    const adjustList = brandPerf
      .filter((b) => (b.chg ?? 0) < -20)
      .sort((a, b) => (a.chg ?? 0) - (b.chg ?? 0));

    // Stop: products with zero 60d sales and high stock value (top 5 dead stock)
    const stopList = deadStock.slice(0, 5);

    // Urgent: SKUs with stock ≤ 3 and velocity > 0.1/day
    const urgentList = Object.entries(invMap)
      .filter(([sku, inv]) => {
        const v60 = (sold60Map[sku] || 0) / 60;
        return inv.stock <= 3 && v60 > 0.1;
      })
      .map(([sku, inv]) => ({
        sku,
        title: inv.title,
        vendor: inv.vendor,
        stock: inv.stock,
        vel60: (sold60Map[sku] || 0) / 60,
      }))
      .sort((a, b) => b.vel60 - a.vel60)
      .slice(0, 10);

    return { continueList, adjustList, stopList, urgentList };
  }, [brandPerf, deadStock, invMap, sold60Map]);

  // Bar chart for brand performance
  const brandChartData = brandPerf.slice(0, 10).map((b) => ({
    name: b.brand.length > 14 ? b.brand.slice(0, 14) + '…' : b.brand,
    本週: b.currRev,
    上週: b.prevRev,
  }));

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* ── Week Selector + Tab Bar ── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Week toggle */}
        <div className="flex gap-1">
          {([
            { key: 'this' as WeekMode, label: '本週' },
            { key: 'last' as WeekMode, label: '上週' },
            { key: 'two'  as WeekMode, label: '兩週前' },
          ] as const).map((w) => (
            <button
              key={w.key}
              onClick={() => setWeekMode(w.key)}
              className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                weekMode === w.key
                  ? 'bg-amber-500/20 text-amber-400 font-medium border border-amber-500/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {currBounds.from} — {currBounds.to}
        </span>
      </div>

      {/* ── Tab Bar ── */}
      <div className="flex gap-1 border-b border-border/40 pb-0">
        {([
          { key: 'overview' as TabKey, label: '零售概覽 Retail Overview' },
          { key: 'deepdive' as TabKey, label: '深度分析 Deep Dive' },
          { key: 'actions'  as TabKey, label: '行動建議 Action Items' },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'text-amber-400 border-amber-400'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ══════════════ TAB 1 — RETAIL OVERVIEW ══════════════ */}
      {tab === 'overview' && (
        <div className="space-y-4">
          {/* Row 1: 4 KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              title="本週營收"
              subtitle="Week Revenue"
              value={formatCurrency(curr.revenue)}
              icon={DollarSign}
              loading={loading}
              delta={pct(curr.revenue, prev.revenue) ?? undefined}
              testId="kpi-week-revenue"
            />
            <KpiCard
              title="本週訂單"
              subtitle="Week Orders"
              value={formatNumber(curr.orders)}
              icon={ShoppingCart}
              loading={loading}
              delta={pct(curr.orders, prev.orders) ?? undefined}
              testId="kpi-week-orders"
            />
            <KpiCard
              title="平均單價 AOV"
              subtitle="Avg Order Value"
              value={formatCurrency(curr.aov)}
              icon={TrendingUp}
              loading={loading}
              delta={pct(curr.aov, prev.aov) ?? undefined}
              testId="kpi-week-aov"
            />
            <KpiCard
              title="折扣碼數量"
              subtitle="Active Promo Codes"
              value={formatNumber(Object.keys(curr.promoCodes).length)}
              icon={Tag}
              loading={loading}
              testId="kpi-week-promos"
            />
          </div>

          {/* Row 2: Top Brand, Top Category, Promo Count */}
          {loading ? (
            <div className="grid grid-cols-3 gap-3">
              <Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card className="border-border/40 border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">最佳品牌 Top Brand</p>
                  {brandPerf[0] ? (
                    <>
                      <p className="text-base font-semibold">{brandPerf[0].brand}</p>
                      <p className="text-xs text-muted-foreground">{formatCurrency(brandPerf[0].currRev)}</p>
                    </>
                  ) : <p className="text-sm text-muted-foreground">—</p>}
                </CardContent>
              </Card>
              <Card className="border-border/40 border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">最佳類別 Top Category</p>
                  {catPerf[0] ? (
                    <>
                      <p className="text-base font-semibold">{catPerf[0].cat}</p>
                      <p className="text-xs text-muted-foreground">{formatCurrency(catPerf[0].revenue)}</p>
                    </>
                  ) : <p className="text-sm text-muted-foreground">—</p>}
                </CardContent>
              </Card>
              <Card className="border-border/40">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">退款 Refunds this week</p>
                  <p className="text-base font-semibold">{formatNumber(curr.refunds)} 筆</p>
                  <p className="text-xs text-muted-foreground">{formatCurrency(curr.refundAmount)}</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Brand Performance */}
          <ChartCard title="品牌表現" subtitle="Brand Revenue — This Week vs Last Week" loading={loading}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={brandChartData}>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="name" tick={AXIS_STYLE} />
                <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="本週" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
                <Bar dataKey="上週" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} opacity={0.6} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Brand Table */}
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium">
                  品牌表現 <span className="text-xs font-normal text-muted-foreground">Brand Performance</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loading ? <Skeleton className="h-[200px] w-full" /> : (
                  <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b border-border/50 text-muted-foreground">
                          <th className="py-2 text-left font-medium">品牌 Brand</th>
                          <th className="py-2 text-right font-medium">本週售出</th>
                          <th className="py-2 text-right font-medium">本週營收</th>
                          <th className="py-2 text-right font-medium">vs上週</th>
                        </tr>
                      </thead>
                      <tbody>
                        {brandPerf.map((b, i) => (
                          <tr key={b.brand} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                            <td className="py-2 font-medium flex items-center gap-1">
                              <span className="text-muted-foreground/60 w-4">{i + 1}</span>
                              {b.brand}
                            </td>
                            <td className="py-2 text-right tabular-nums">{formatNumber(b.currQty)}</td>
                            <td className="py-2 text-right tabular-nums">{formatCurrency(b.currRev)}</td>
                            <td className={`py-2 text-right tabular-nums ${pctColor(b.chg)}`}>
                              {fmtPct(b.chg)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Category Table */}
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium">
                  品類表現 <span className="text-xs font-normal text-muted-foreground">Category Performance</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loading ? <Skeleton className="h-[200px] w-full" /> : (
                  <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card">
                        <tr className="border-b border-border/50 text-muted-foreground">
                          <th className="py-2 text-left font-medium">品類 Category</th>
                          <th className="py-2 text-right font-medium">件數</th>
                          <th className="py-2 text-right font-medium">本週營收</th>
                          <th className="py-2 text-right font-medium">% of Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catPerf.map((c) => (
                          <tr key={c.cat} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                            <td className="py-2 font-medium">{c.cat}</td>
                            <td className="py-2 text-right tabular-nums">{formatNumber(c.qty)}</td>
                            <td className="py-2 text-right tabular-nums">{formatCurrency(c.revenue)}</td>
                            <td className="py-2 text-right tabular-nums">{formatPercent(c.pctTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Promo Codes */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                Promo Codes <span className="text-xs font-normal text-muted-foreground">折扣碼使用情況 Usage this week</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[120px] w-full" /> : promoArr.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">本週無折扣碼使用</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">Code</th>
                        <th className="py-2 text-right font-medium">使用次數 Uses</th>
                        <th className="py-2 text-right font-medium">折扣金額 Discount</th>
                        <th className="py-2 text-right font-medium">帶來營收 Revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {promoArr.map((p) => (
                        <tr key={p.code} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2 font-mono font-semibold">{p.code}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(p.uses)}</td>
                          <td className="py-2 text-right tabular-nums text-red-400">-{formatCurrency(p.discountAmt)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top 5 SKU */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                Top 5 SKU <span className="text-xs font-normal text-muted-foreground">本週最佳產品 Best Sellers this week</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[100px] w-full" /> : curr.topSkus.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">無資料</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  {curr.topSkus.map((s, i) => (
                    <Card key={s.sku || i} className="border-border/40 bg-accent/20">
                      <CardContent className="p-3">
                        <div className="flex items-center gap-1.5 mb-2">
                          <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">#{i + 1}</span>
                          <span className="text-[10px] text-muted-foreground">{s.vendor}</span>
                        </div>
                        <p className="text-xs font-medium leading-tight line-clamp-2 mb-2">{s.title}</p>
                        <p className="text-xs text-muted-foreground">售出 {formatNumber(s.qty)} 件</p>
                        <p className="text-sm font-semibold">{formatCurrency(s.revenue)}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* YoY note */}
          <Card className="border-border/40 border-dashed">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                去年同週數據需要歷史資料，暫不支援 (YoY requires historical data not currently available)
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ══════════════ TAB 2 — DEEP DIVE ══════════════ */}
      {tab === 'deepdive' && (
        <div className="space-y-4">
          {/* MTD KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              title="MTD 營收"
              subtitle="vs HK$1.4M Target"
              value={formatCurrency(mtd.revenue)}
              icon={DollarSign}
              loading={loading}
              testId="kpi-mtd-revenue"
            />
            <KpiCard
              title="MTD 訂單"
              subtitle="Month-to-Date Orders"
              value={formatNumber(mtd.orders)}
              icon={ShoppingCart}
              loading={loading}
              testId="kpi-mtd-orders"
            />
            <KpiCard
              title="MTD AOV"
              subtitle="Avg Order Value"
              value={formatCurrency(mtd.aov)}
              icon={TrendingUp}
              loading={loading}
              testId="kpi-mtd-aov"
            />
            <KpiCard
              title="本月新會員"
              subtitle="New Members MTD"
              value={formatNumber(mtdMembers)}
              icon={Users}
              loading={loading}
              testId="kpi-mtd-members"
            />
          </div>

          {/* MTD target progress */}
          {!loading && (
            <Card className="border-border/40 border-amber-500/20 bg-gradient-to-r from-amber-500/5 to-transparent">
              <CardContent className="p-4">
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-lg font-bold tabular-nums">{formatCurrency(mtd.revenue)}</span>
                  <span className="text-muted-foreground text-sm">/ HK$1,400,000 月目標</span>
                  <span className={`text-sm font-semibold ${mtd.revenue >= 1400000 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {formatPercent((mtd.revenue / 1400000) * 100)} 達成
                  </span>
                </div>
                <div className="bg-muted/40 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all ${mtd.revenue >= 1400000 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    style={{ width: `${Math.min(100, (mtd.revenue / 1400000) * 100)}%` }}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Brand GMROI */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                品牌 GMROI 排名 <span className="text-xs font-normal text-muted-foreground">Brand Gross Margin Return on Inventory (MTD)</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[200px] w-full" /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">排名</th>
                        <th className="py-2 text-left font-medium">品牌 Brand</th>
                        <th className="py-2 text-right font-medium">MTD 營收</th>
                        <th className="py-2 text-right font-medium">SKUs</th>
                        <th className="py-2 text-right font-medium">庫存值 Stock Value</th>
                        <th className="py-2 text-right font-medium">GMROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brandGmroi.map((b, i) => (
                        <tr key={b.brand} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2 tabular-nums text-muted-foreground">#{i + 1}</td>
                          <td className="py-2 font-medium">{b.brand}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(b.revenue)}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(b.skus)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(b.stockValue)}</td>
                          <td className="py-2 text-right tabular-nums">
                            <span className={b.gmroi >= 1 ? 'text-emerald-400 font-semibold' : b.gmroi >= 0.5 ? 'text-amber-400' : 'text-red-400'}>
                              {b.gmroi.toFixed(2)}x
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Sell-Through by Category */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                Sell-through by Category <span className="text-xs font-normal text-muted-foreground">本週售出率 This Week</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[150px] w-full" /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">品類 Category</th>
                        <th className="py-2 text-right font-medium">庫存量</th>
                        <th className="py-2 text-right font-medium">本週售出</th>
                        <th className="py-2 text-right font-medium">Sell-through %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellThrough.slice(0, 15).map((c) => (
                        <tr key={c.cat} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2 font-medium">{c.cat}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(c.invUnits)}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(c.soldQty)}</td>
                          <td className="py-2 text-right tabular-nums">
                            <span className={c.stPct >= 20 ? 'text-emerald-400' : c.stPct >= 10 ? 'text-amber-400' : 'text-muted-foreground'}>
                              {formatPercent(c.stPct)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Dead Stock */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                死貨預警 <span className="text-xs font-normal text-muted-foreground">Dead Stock — 60d no sales, sorted by stock value at risk</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[200px] w-full" /> : deadStock.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">無死貨</p>
              ) : (
                <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">產品</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-left font-medium">品牌</th>
                        <th className="py-2 text-right font-medium">庫存量</th>
                        <th className="py-2 text-right font-medium">庫存值 Stock Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deadStock.map((d) => (
                        <tr key={d.sku} className="border-b border-border/20 hover:bg-accent/30 transition-colors bg-red-500/5">
                          <td className="py-2 max-w-[200px] truncate">{d.title}</td>
                          <td className="py-2 font-mono text-[11px]">{d.sku}</td>
                          <td className="py-2 text-muted-foreground">{d.vendor}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(d.stock)}</td>
                          <td className="py-2 text-right tabular-nums text-red-400 font-medium">{formatCurrency(d.stockValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* New Products 30/60d */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                新品30/60日成績 <span className="text-xs font-normal text-muted-foreground">New Product 30/60d Performance (listed in last 90d)</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[200px] w-full" /> : newProdPerf.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">無新品資料</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">產品</th>
                        <th className="py-2 text-left font-medium">品牌</th>
                        <th className="py-2 text-left font-medium">上架日期</th>
                        <th className="py-2 text-right font-medium">30d 售出</th>
                        <th className="py-2 text-right font-medium">60d 售出</th>
                        <th className="py-2 text-right font-medium">60d 營收</th>
                      </tr>
                    </thead>
                    <tbody>
                      {newProdPerf.map((p: any) => (
                        <tr key={p.id} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2 max-w-[200px] truncate font-medium">{p.title}</td>
                          <td className="py-2 text-muted-foreground">{p.vendor || '—'}</td>
                          <td className="py-2 text-muted-foreground">{p.createdAt}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(p.qty30)}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(p.qty60)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.rev60)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ══════════════ TAB 3 — ACTION ITEMS ══════════════ */}
      {tab === 'actions' && (
        <div className="space-y-4">
          {/* Continue */}
          <Card className="border-border/40 border-emerald-500/20 bg-gradient-to-r from-emerald-500/5 to-transparent">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-emerald-400" />
                ✅ 繼續 Continue
                <span className="text-xs font-normal text-muted-foreground">Top brands by revenue growth vs last week</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[80px] w-full" /> : actions.continueList.length === 0 ? (
                <p className="text-xs text-muted-foreground">本週無品牌成長</p>
              ) : (
                <div className="space-y-2">
                  {actions.continueList.map((b) => (
                    <div key={b.brand} className="flex items-center justify-between p-2.5 rounded-lg bg-emerald-500/10">
                      <div>
                        <p className="text-sm font-semibold">{b.brand}</p>
                        <p className="text-xs text-muted-foreground">
                          本週 {formatCurrency(b.currRev)} vs 上週 {formatCurrency(b.prevRev)}
                        </p>
                      </div>
                      <span className="text-emerald-400 font-bold text-base">{fmtPct(b.chg)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Adjust */}
          <Card className="border-border/40 border-amber-500/20 bg-gradient-to-r from-amber-500/5 to-transparent">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-400" />
                🔄 調整 Adjust
                <span className="text-xs font-normal text-muted-foreground">Brands with revenue drop &gt;20% vs last week</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[80px] w-full" /> : actions.adjustList.length === 0 ? (
                <p className="text-xs text-muted-foreground">本週無品牌明顯下滑</p>
              ) : (
                <div className="space-y-2">
                  {actions.adjustList.map((b) => (
                    <div key={b.brand} className="flex items-center justify-between p-2.5 rounded-lg bg-amber-500/10">
                      <div>
                        <p className="text-sm font-semibold">{b.brand}</p>
                        <p className="text-xs text-muted-foreground">
                          本週 {formatCurrency(b.currRev)} vs 上週 {formatCurrency(b.prevRev)}
                        </p>
                      </div>
                      <span className="text-red-400 font-bold text-base">{fmtPct(b.chg)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stop */}
          <Card className="border-border/40 border-red-500/20 bg-gradient-to-r from-red-500/5 to-transparent">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <XCircle className="h-4 w-4 text-red-400" />
                ⛔ 停止 Stop
                <span className="text-xs font-normal text-muted-foreground">Products with zero 60d sales &amp; high stock value</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[80px] w-full" /> : actions.stopList.length === 0 ? (
                <p className="text-xs text-muted-foreground">無死貨預警</p>
              ) : (
                <div className="space-y-2">
                  {actions.stopList.map((d) => (
                    <div key={d.sku} className="flex items-center justify-between p-2.5 rounded-lg bg-red-500/10">
                      <div>
                        <p className="text-sm font-semibold line-clamp-1">{d.title}</p>
                        <p className="text-xs text-muted-foreground">{d.vendor} · SKU: {d.sku} · 庫存 {formatNumber(d.stock)} 件</p>
                      </div>
                      <div className="text-right">
                        <p className="text-red-400 font-bold text-sm">{formatCurrency(d.stockValue)}</p>
                        <p className="text-[10px] text-muted-foreground">庫存值</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Urgent */}
          <Card className="border-border/40 border-red-600/30 bg-gradient-to-r from-red-600/8 to-transparent">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-red-500" />
                🚨 緊急 Urgent Restock
                <span className="text-xs font-normal text-muted-foreground">Stock ≤3 &amp; velocity &gt;0.1/day</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[80px] w-full" /> : actions.urgentList.length === 0 ? (
                <p className="text-xs text-muted-foreground">無緊急補貨需求</p>
              ) : (
                <div className="space-y-2">
                  {actions.urgentList.map((u) => (
                    <div key={u.sku} className="flex items-center justify-between p-2.5 rounded-lg bg-red-600/10">
                      <div>
                        <p className="text-sm font-semibold line-clamp-1">{u.title}</p>
                        <p className="text-xs text-muted-foreground">{u.vendor} · SKU: {u.sku}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-red-500 font-bold text-sm">剩 {formatNumber(u.stock)} 件</p>
                        <p className="text-[10px] text-muted-foreground">速率 {u.vel60.toFixed(2)}/day</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Meta ROAS note */}
          <Card className="border-border/40 border-dashed">
            <CardContent className="p-3 space-y-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <BarChart2 className="h-3.5 w-3.5" />
                Meta ROAS: 需要 meta_ad_insights 表格數據，本週如有廣告數據將自動顯示
              </p>
              <p className="text-xs text-amber-400/80 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                以上為系統自動建議，請在週會中確認 (Auto-generated — verify in weekly meeting)
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
