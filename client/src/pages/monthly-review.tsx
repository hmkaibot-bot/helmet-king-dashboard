import { useEffect, useMemo, useState } from 'react';
import {
  DollarSign, ShoppingCart, TrendingUp, Tag, Coins, Users,
  ChevronLeft, ChevronRight, Target, Sparkles,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

import { queryAllPages, queryAll, getProductMeta } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { DataFreshnessBadge } from '@/components/data-freshness';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { calcDelta, processOrders, mapChannel, type Order, type Line as OrderLine } from '@/lib/weekly-review-utils';
import { Modal, ChannelIcon, DeltaInline, DeltaCell, YoyLine, TopList, PerformanceTable, DrillTable } from '@/components/review-shared';
import { ProductItemList, type ProductListItem } from '@/components/product-item-list';
import { KPI_TARGETS, kpiStatus } from '@/lib/kpi-targets';

// ── HK date helpers ─────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function ds(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

export default function MonthlyReview() {
  const hkNow = useMemo(() => getHKNow(), []);
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: hkNow.getFullYear(), m: hkNow.getMonth() + 1 });
  const [loading, setLoading] = useState(true);
  const [ordersRaw, setOrdersRaw] = useState<Order[]>([]);
  const [linesRaw, setLinesRaw] = useState<OrderLine[]>([]);
  const [productMeta, setProductMeta] = useState<Record<string, { product_type: string; vendor: string }>>({});
  const [costMap, setCostMap] = useState<Record<string, number>>({});
  const [productInfo, setProductInfo] = useState<Record<string, { handle: string | null; image_url: string | null; created_at: string | null }>>({});
  const [newProductStock, setNewProductStock] = useState<Record<string, number>>({});
  const [brandDrill, setBrandDrill] = useState<string | null>(null);
  const [catDrill, setCatDrill] = useState<string | null>(null);

  // ── 月份定義(自然月;本月 = MTD,過咗嘅月 = 完整月)──────
  const isCurrentMonth = ym.y === hkNow.getFullYear() && ym.m === hkNow.getMonth() + 1;
  const dim = daysInMonth(ym.y, ym.m);
  const todayDay = hkNow.getDate();
  // MTD 對比昨日為止(今日未完唔計),完整月照計到月尾
  const effectiveDay = isCurrentMonth ? Math.max(todayDay - 1, 1) : dim;

  const curRange = useMemo(() => ({
    from: ds(ym.y, ym.m, 1),
    to: ds(ym.y, ym.m, effectiveDay),
  }), [ym, effectiveDay]);

  // 上月:MTD 模式對比「上月同日數」(公平);完整月對比上月全月
  const prevRange = useMemo(() => {
    const py = ym.m === 1 ? ym.y - 1 : ym.y;
    const pm = ym.m === 1 ? 12 : ym.m - 1;
    const pdim = daysInMonth(py, pm);
    const pTo = isCurrentMonth ? Math.min(effectiveDay, pdim) : pdim;
    return { from: ds(py, pm, 1), to: ds(py, pm, pTo) };
  }, [ym, isCurrentMonth, effectiveDay]);

  // 去年同月(同一對比原則)
  const yoyRange = useMemo(() => {
    const yy = ym.y - 1;
    const ydim = daysInMonth(yy, ym.m);
    const yTo = isCurrentMonth ? Math.min(effectiveDay, ydim) : ydim;
    return { from: ds(yy, ym.m, 1), to: ds(yy, ym.m, yTo) };
  }, [ym, isCurrentMonth, effectiveDay]);

  // ── Fetch ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const from = [curRange.from, prevRange.from, yoyRange.from].reduce((a, b) => (a < b ? a : b));
        const to = [curRange.to, prevRange.to, yoyRange.to].reduce((a, b) => (a > b ? a : b));

        const orders = await queryAllPages(
          'shopify_orders',
          'id,order_number,created_at,total_price,total_discounts,financial_status,cancelled_at,discount_codes,source_name,user_id',
          [
            { column: 'created_at', op: 'gte', value: from },
            { column: 'created_at', op: 'lte', value: to + 'T23:59:59.999Z' },
          ]
        );
        if (cancelled) return;

        const [lines, pmeta] = await Promise.all([
          queryAllPages(
            'shopify_order_lines',
            'order_id,product_id,sku,title,vendor,product_type,quantity,price',
            [
              { column: 'created_at', op: 'gte', value: from },
              { column: 'created_at', op: 'lte', value: to + 'T23:59:59.999Z' },
            ]
          ),
          getProductMeta(),
        ]);
        if (cancelled) return;
        setOrdersRaw(orders as any);
        setLinesRaw(lines as any);
        setProductMeta(pmeta);

        // 產品 info(新品判斷 + 縮圖;image_url 欄未加就 fallback)
        queryAll('shopify_products', 'id,handle,image_url,created_at').then(async (rows: any[]) => {
          if (rows.length === 0) rows = await queryAll('shopify_products', 'id,handle,created_at');
          if (cancelled) return;
          const info: typeof productInfo = {};
          rows.forEach((r: any) => {
            if (r.id) info[String(r.id)] = { handle: r.handle || null, image_url: r.image_url || null, created_at: r.created_at || null };
          });
          setProductInfo(info);
        });

        // 成本價(毛利)
        const skuList = [...new Set((lines as any[]).map(l => l.sku).filter(Boolean))] as string[];
        const BATCH = 100;
        const batches: string[][] = [];
        for (let i = 0; i < skuList.length; i += BATCH) batches.push(skuList.slice(i, i + BATCH));
        const costResults = await Promise.all(
          batches.map(b => supabase.from('shopify_inventory').select('sku,cost').in('sku', b))
        );
        if (cancelled) return;
        const cMap: Record<string, number> = {};
        for (const { data: rows } of costResults) {
          (rows || []).forEach((r: any) => {
            const c = parseFloat(r.cost);
            if (r.sku && c > 0) cMap[r.sku] = c;
          });
        }
        setCostMap(cMap);
      } catch (err) {
        console.error('monthly-review fetch failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [curRange, prevRange, yoyRange]);

  const cur = useMemo(() => processOrders(ordersRaw, linesRaw, curRange.from, curRange.to, productMeta, costMap), [ordersRaw, linesRaw, curRange, productMeta, costMap]);
  const prev = useMemo(() => processOrders(ordersRaw, linesRaw, prevRange.from, prevRange.to, productMeta, costMap), [ordersRaw, linesRaw, prevRange, productMeta, costMap]);
  const yoy = useMemo(() => processOrders(ordersRaw, linesRaw, yoyRange.from, yoyRange.to, productMeta, costMap), [ordersRaw, linesRaw, yoyRange, productMeta, costMap]);

  // ── 每日營收走勢(本月 vs 上月同日)───────────────────────
  const dailyTrend = useMemo(() => {
    const revByDate: Record<string, number> = {};
    ordersRaw.forEach((o: any) => {
      if (o.financial_status === 'refunded' || o.cancelled_at) return;
      const d = new Date(new Date(o.created_at).getTime() + (new Date(o.created_at).getTimezoneOffset() + 480) * 60000);
      const key = ds(d.getFullYear(), d.getMonth() + 1, d.getDate());
      revByDate[key] = (revByDate[key] || 0) + parseFloat(String(o.total_price || 0));
    });
    const py = ym.m === 1 ? ym.y - 1 : ym.y;
    const pm = ym.m === 1 ? 12 : ym.m - 1;
    const pdim = daysInMonth(py, pm);
    return Array.from({ length: dim }, (_, i) => {
      const day = i + 1;
      return {
        day: `${day}`,
        本月: (isCurrentMonth && day > effectiveDay) ? null : (revByDate[ds(ym.y, ym.m, day)] || 0),
        上月: day <= pdim ? (revByDate[ds(py, pm, day)] || 0) : null,
      };
    });
  }, [ordersRaw, ym, dim, isCurrentMonth, effectiveDay]);

  // ── 員工月度排名 ─────────────────────────────────────────
  const staffNames = useMemo<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('hk_staff_names') || '{}'); } catch { return {}; }
  }, []);
  const staffRows = useMemo(() => {
    const m: Record<string, { rev: number; cnt: number }> = {};
    ordersRaw.forEach((o: any) => {
      if (o.financial_status === 'refunded' || o.cancelled_at) return;
      const ca = String(o.created_at || '');
      if (ca < curRange.from || ca > curRange.to + '\xff') return;
      if (!o.user_id) return;
      const uid = String(o.user_id);
      if (!m[uid]) m[uid] = { rev: 0, cnt: 0 };
      m[uid].rev += parseFloat(String(o.total_price || 0));
      m[uid].cnt += 1;
    });
    const total = Object.values(m).reduce((s, v) => s + v.rev, 0);
    return {
      total,
      rows: Object.entries(m)
        .map(([uid, v]) => ({ uid, name: staffNames[uid] || `Staff …${uid.slice(-4)}`, ...v }))
        .sort((a, b) => b.rev - a.rev),
    };
  }, [ordersRaw, curRange, staffNames]);

  // ── 新品首月表現(本月上架嘅貨)───────────────────────────
  const newProducts = useMemo(() => {
    const monthStart = curRange.from;
    const monthEnd = ds(ym.y, ym.m, dim) + '\xff';
    const newIds = new Set(
      Object.entries(productInfo)
        .filter(([, v]) => v.created_at && v.created_at >= monthStart && v.created_at <= monthEnd)
        .map(([id]) => id)
    );
    if (newIds.size === 0) return { count: 0, items: [] as ProductListItem[], velocityMap: {} as Record<string, number> };

    const curOrderIds = new Set(
      ordersRaw.filter((o: any) => {
        if (o.financial_status === 'refunded' || o.cancelled_at) return false;
        const ca = String(o.created_at || '');
        return ca >= curRange.from && ca <= curRange.to + '\xff';
      }).map((o: any) => String(o.id))
    );
    const map: Record<string, ProductListItem & { launched: string | null }> = {};
    const velocityMap: Record<string, number> = {};
    linesRaw.forEach((l: any) => {
      const pid = String(l.product_id || '');
      if (!newIds.has(pid) || !curOrderIds.has(String(l.order_id))) return;
      const qty = parseInt(String(l.quantity || 0), 10) || 0;
      const rev = parseFloat(String(l.price || 0)) * qty;
      const title = (l.title || '').trim() || pid;
      if (!map[title]) map[title] = { title, productId: pid, skus: new Set(), qty: 0, revenue: 0, profit: 0, coveredRev: 0, badge: '新上架', launched: productInfo[pid]?.created_at?.slice(0, 10) || null };
      const it = map[title];
      it.qty += qty;
      it.revenue += rev;
      if (l.sku) it.skus.add(l.sku);
      const c = l.sku ? costMap[l.sku] : undefined;
      if (c !== undefined) { it.profit += rev - c * qty; it.coveredRev += rev; }
    });
    // 上架至今日均速率(新品冇 60 日史,用首月速率估預計缺貨)
    Object.values(map).forEach(it => {
      const launchDay = it.launched ? Math.max(1, parseInt(it.launched.slice(8, 10), 10)) : 1;
      const daysOnSale = Math.max(1, effectiveDay - launchDay + 1);
      const perSku = it.qty / daysOnSale / Math.max(1, it.skus.size);
      it.skus.forEach(sku => { velocityMap[sku] = perSku; });
    });
    return {
      count: newIds.size,
      items: Object.values(map).sort((a, b) => b.revenue - a.revenue),
      velocityMap,
    };
  }, [productInfo, ordersRaw, linesRaw, curRange, ym, dim, effectiveDay, costMap]);

  // 新品庫存(得幾款,直接 in-query)
  useEffect(() => {
    const ids = newProducts.items.map(i => i.productId).filter(Boolean) as string[];
    if (ids.length === 0) { setNewProductStock({}); return; }
    let cancelled = false;
    supabase.from('shopify_inventory').select('product_id,inventory_quantity').in('product_id', ids)
      .then(({ data }) => {
        if (cancelled) return;
        const m: Record<string, number> = {};
        (data || []).forEach((r: any) => {
          if (!r.product_id) return;
          const k = String(r.product_id);
          m[k] = (m[k] || 0) + Math.max(0, r.inventory_quantity || 0);
        });
        setNewProductStock(m);
      });
    return () => { cancelled = true; };
  }, [newProducts]);

  const imageMap = useMemo(() => {
    const m: Record<string, string> = {};
    Object.entries(productInfo).forEach(([id, v]) => { if (v.image_url) m[id] = v.image_url; });
    return m;
  }, [productInfo]);
  const handleMap = useMemo(() => {
    const m: Record<string, string> = {};
    Object.entries(productInfo).forEach(([id, v]) => { if (v.handle) m[id] = v.handle; });
    return m;
  }, [productInfo]);

  // ── 月度目標 ─────────────────────────────────────────────
  const projectedRevenue = isCurrentMonth && effectiveDay > 0 ? (cur.revenue / effectiveDay) * dim : cur.revenue;
  const marginPct = cur.coveredRev > 0 ? (cur.profit / cur.coveredRev) * 100 : 0;

  const topBrands = useMemo(() => Object.entries(cur.brandMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5).map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })), [cur]);
  const topCats = useMemo(() => Object.entries(cur.catMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5).map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })), [cur]);
  const brandTable = useMemo(() => Object.entries(cur.brandMap).sort((a, b) => b[1].revenue - a[1].revenue).map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })), [cur]);
  const catTable = useMemo(() => Object.entries(cur.catMap).sort((a, b) => b[1].revenue - a[1].revenue).map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })), [cur]);
  const promoRows = useMemo(() => Object.entries(cur.promoCodes).sort((a, b) => b[1].revenue - a[1].revenue).map(([code, v]) => ({ code, uses: v.uses, discountAmt: v.discountAmt, revenue: v.revenue })), [cur]);
  const channelRows = useMemo(() => {
    const total = Object.values(cur.channelMap).reduce((s, c) => s + c.revenue, 0);
    return Object.entries(cur.channelMap).sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([name, v]) => ({ name, orders: v.orders, revenue: v.revenue, share: total > 0 ? v.revenue / total : 0 }));
  }, [cur]);
  const brandMovers = useMemo(() => {
    const names = new Set([...Object.keys(cur.brandMap), ...Object.keys(prev.brandMap)]);
    const deltas = [...names].map(name => ({
      name,
      cur: cur.brandMap[name]?.revenue || 0,
      prev: prev.brandMap[name]?.revenue || 0,
      delta: (cur.brandMap[name]?.revenue || 0) - (prev.brandMap[name]?.revenue || 0),
    }));
    deltas.sort((a, b) => b.delta - a.delta);
    return {
      gainer: deltas[0] && deltas[0].delta > 0 ? deltas[0] : null,
      loser: deltas.length > 0 && deltas[deltas.length - 1].delta < 0 ? deltas[deltas.length - 1] : null,
    };
  }, [cur, prev]);

  const monthLabel = `${ym.y}年${ym.m}月`;
  const compareNote = isCurrentMonth
    ? `MTD 進行中(1–${effectiveDay} 號)· 對比上月同日數,唔係上月全月`
    : `完整月 · 對比上月全月同去年同月`;

  const shiftMonth = (delta: number) => {
    setYm(({ y, m }) => {
      const nm = m + delta;
      if (nm < 1) return { y: y - 1, m: 12 };
      if (nm > 12) return { y: y + 1, m: 1 };
      return { y, m: nm };
    });
  };
  const canGoNext = !isCurrentMonth;

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (<Skeleton key={i} className="h-24" />))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 pb-20">
      {/* Title + month picker */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">月報 Monthly Review</h1>
        <p className="text-sm text-muted-foreground">{curRange.from} → {curRange.to} · {compareNote}</p>
      </div>

      <div className="sticky top-0 z-30 -mx-4 px-4 py-3 bg-background/85 backdrop-blur border-b border-border/40 flex flex-wrap items-center gap-3">
        <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded border border-border/50 bg-accent/30 hover:bg-accent/60" data-testid="month-prev">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-base font-semibold tabular-nums" data-testid="month-label">{monthLabel}</span>
        <button onClick={() => shiftMonth(1)} disabled={!canGoNext}
          className="p-1.5 rounded border border-border/50 bg-accent/30 hover:bg-accent/60 disabled:opacity-30 disabled:cursor-not-allowed" data-testid="month-next">
          <ChevronRight className="h-4 w-4" />
        </button>
        {!isCurrentMonth && (
          <button onClick={() => setYm({ y: hkNow.getFullYear(), m: hkNow.getMonth() + 1 })}
            className="text-[13px] px-2 py-1 rounded border border-border/50 bg-accent/30 hover:bg-accent/60">
            返本月
          </button>
        )}
        <span className={`text-[13px] px-2 py-0.5 rounded ${isCurrentMonth ? 'bg-sky-500/15 text-sky-400' : 'bg-emerald-500/15 text-emerald-400'}`}>
          {isCurrentMonth ? 'MTD 進行中' : '完整月'}
        </span>
        <div className="ml-auto"><DataFreshnessBadge /></div>
      </div>

      {/* ── 一分鐘總結 ─────────────────────────────────────── */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">📋 一分鐘總結</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-[15px] leading-relaxed">
          <p>
            {monthLabel}{isCurrentMonth ? `頭 ${effectiveDay} 日` : ''}營收 <b className="tabular-nums">{formatCurrency(cur.revenue)}</b>
            <DeltaInline cur={cur.revenue} prev={prev.revenue} label="上月" />
            <DeltaInline cur={cur.revenue} prev={yoy.revenue} label="去年" />
            ,訂單 <b className="tabular-nums">{formatNumber(cur.orders)}</b> 張
            <DeltaInline cur={cur.orders} prev={prev.orders} label="上月" />
            ,AOV <b className="tabular-nums">{formatCurrency(cur.aov)}</b>。
          </p>
          <p>
            毛利 <b className="tabular-nums">{formatCurrency(cur.profit)}</b>
            {cur.coveredRev > 0 && <>(率 {marginPct.toFixed(0)}%)</>}
            <DeltaInline cur={cur.profit} prev={prev.profit} label="上月" />
            {isCurrentMonth && (
              <>;照呢個 pace,預計月尾營收 <b className="tabular-nums">{formatCurrency(projectedRevenue)}</b>
              {projectedRevenue >= KPI_TARGETS.monthlyRevenue
                ? <span className="text-emerald-400"> 🟢 達標有望</span>
                : <span className="text-amber-400"> 差目標 {formatCurrency(KPI_TARGETS.monthlyRevenue - projectedRevenue)}</span>}
              </>
            )}。
          </p>
          {(brandMovers.gainer || brandMovers.loser) && (
            <p>
              {brandMovers.gainer && (
                <>拉升最多:<b>{brandMovers.gainer.name}</b>{' '}
                <span className="text-emerald-400 tabular-nums">+{formatCurrency(brandMovers.gainer.delta)}</span></>
              )}
              {brandMovers.gainer && brandMovers.loser && ';'}
              {brandMovers.loser && (
                <>回落最多:<b>{brandMovers.loser.name}</b>{' '}
                <span className="text-red-400 tabular-nums">−{formatCurrency(Math.abs(brandMovers.loser.delta))}</span></>
              )}
              {newProducts.count > 0 && <>;本月新上架 <b>{newProducts.count}</b> 款,有售 {newProducts.items.length} 款</>}。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 1. 月度目標進度 */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Target className="h-4 w-4 text-primary" /> 1. 月度目標進度</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              label: '月營收', target: KPI_TARGETS.monthlyRevenue, value: cur.revenue, fmt: formatCurrency,
              extra: isCurrentMonth ? `預計月尾 ${formatCurrency(projectedRevenue)}` : null,
              pctOf: isCurrentMonth ? projectedRevenue : cur.revenue,
            },
            { label: '毛利率', target: KPI_TARGETS.grossMarginPct, value: marginPct, fmt: (v: number) => `${v.toFixed(1)}%`, extra: null, pctOf: marginPct },
            { label: '平均單價 AOV', target: KPI_TARGETS.aov, value: cur.aov, fmt: formatCurrency, extra: null, pctOf: cur.aov },
          ].map(t => {
            const st = kpiStatus(t.pctOf, t.target);
            const barPct = Math.min(100, t.target > 0 ? (t.value / t.target) * 100 : 0);
            return (
              <div key={t.label} className="border border-border/40 rounded-lg p-4 bg-accent/10">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{t.label}</span>
                  <span className="text-[13px]">{st.icon}</span>
                </div>
                <div className="text-xl font-bold tabular-nums">{t.fmt(t.value)}</div>
                <div className="mt-2 h-2 bg-border/40 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${st.bgColor}`} style={{ width: `${barPct}%` }} />
                </div>
                <div className="mt-1 text-[13px] text-muted-foreground flex items-center justify-between">
                  <span>目標 {t.fmt(t.target)}</span>
                  {t.extra && <span className={st.color}>{t.extra}</span>}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* 2. 核心 KPI */}
      <div>
        <h2 className="text-base font-semibold mb-3">2. 核心 KPI <span className="text-[13px] font-normal text-muted-foreground">vs {isCurrentMonth ? '上月同日數' : '上月全月'}</span></h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard title="營收" subtitle="vs 上月 / 去年" value={formatCurrency(cur.revenue)} icon={DollarSign} delta={calcDelta(cur.revenue, prev.revenue)} testId="mkpi-revenue" />
          <KpiCard title="毛利" subtitle={cur.coveredRev > 0 ? `毛利率 ${marginPct.toFixed(0)}%` : '未有成本數據'} value={formatCurrency(cur.profit)} icon={Coins} delta={calcDelta(cur.profit, prev.profit)} testId="mkpi-profit" />
          <KpiCard title="訂單" subtitle="vs 上月 / 去年" value={formatNumber(cur.orders)} icon={ShoppingCart} delta={calcDelta(cur.orders, prev.orders)} testId="mkpi-orders" />
          <KpiCard title="平均單價 AOV" subtitle="vs 上月 / 去年" value={formatCurrency(cur.aov)} icon={TrendingUp} delta={calcDelta(cur.aov, prev.aov)} testId="mkpi-aov" />
          <KpiCard title="折扣碼" subtitle="本月生效" value={formatNumber(cur.promoCount)} icon={Tag} delta={calcDelta(cur.promoCount, prev.promoCount)} testId="mkpi-promo" />
        </div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-5 gap-3 text-[13px] text-muted-foreground">
          <YoyLine label="vs 去年同月" cur={cur.revenue} refValue={yoy.revenue} fmt={formatCurrency} />
          <YoyLine label="vs 去年同月" cur={cur.profit} refValue={yoy.profit} fmt={formatCurrency} />
          <YoyLine label="vs 去年同月" cur={cur.orders} refValue={yoy.orders} fmt={formatNumber} />
          <YoyLine label="vs 去年同月" cur={cur.aov} refValue={yoy.aov} fmt={formatCurrency} />
          <YoyLine label="vs 去年同月" cur={cur.promoCount} refValue={yoy.promoCount} fmt={formatNumber} />
        </div>
      </div>

      {/* 3. 每日營收走勢 */}
      <ChartCard title="3. 每日營收走勢" subtitle={`${monthLabel} 逐日 vs 上月同日`} note={compareNote}>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={dailyTrend}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="day" tick={AXIS_STYLE} interval={1} />
            <YAxis tick={AXIS_STYLE} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} labelFormatter={(l: string) => `${l} 號`} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Line type="monotone" dataKey="本月" stroke={CHART_COLORS.primary} strokeWidth={2.5} dot={{ r: 2 }} connectNulls={false} />
            <Line type="monotone" dataKey="上月" stroke={CHART_COLORS.secondary} strokeWidth={1.5} strokeDasharray="6 3" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 4. Top 5 品牌 / 品類 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-border/40">
          <CardHeader><CardTitle className="text-base">4a. Top 5 品牌 <span className="text-[13px] font-normal text-muted-foreground">括號係 vs 上月</span></CardTitle></CardHeader>
          <CardContent><TopList rows={topBrands} prevMap={prev.brandMap} /></CardContent>
        </Card>
        <Card className="border-border/40">
          <CardHeader><CardTitle className="text-base">4b. Top 5 品類 <span className="text-[13px] font-normal text-muted-foreground">括號係 vs 上月</span></CardTitle></CardHeader>
          <CardContent><TopList rows={topCats} prevMap={prev.catMap} /></CardContent>
        </Card>
      </div>

      {/* 5. 品牌 / 品類明細 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PerformanceTable title="5a. 品牌表現明細（點擊展開）" rows={brandTable} prevMap={prev.brandMap} onClick={n => setBrandDrill(n)} />
        <PerformanceTable title="5b. 品類表現明細（點擊展開）" rows={catTable} prevMap={prev.catMap} onClick={n => setCatDrill(n)} />
      </div>

      {/* 6. Top 5 SKU */}
      <Card className="border-border/40">
        <CardHeader><CardTitle className="text-base">6. 本月最佳產品 Top 5 SKU</CardTitle></CardHeader>
        <CardContent>
          {cur.topSkus.length === 0 ? (
            <div className="text-sm text-muted-foreground">本月暫無資料</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[13px] text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="text-left py-2.5 px-2">#</th>
                    <th className="text-left py-2.5 px-2">品牌</th>
                    <th className="text-left py-2.5 px-2">SKU / 產品名稱</th>
                    <th className="text-right py-2.5 px-2">件數</th>
                    <th className="text-right py-2.5 px-2">銷售額</th>
                    <th className="text-right py-2.5 px-2">vs 上月</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.topSkus.map((s, i) => (
                    <tr key={s.sku + i} className="border-b border-border/20 hover:bg-accent/20">
                      <td className="py-2.5 px-2 text-muted-foreground">#{i + 1}</td>
                      <td className="py-2.5 px-2">{s.vendor}</td>
                      <td className="py-2.5 px-2">
                        <div className="font-medium text-foreground">{s.title}</div>
                        <div className="text-[13px] text-muted-foreground">{s.sku}</div>
                      </td>
                      <td className="py-2.5 px-2 text-right">{formatNumber(s.qty)}</td>
                      <td className="py-2.5 px-2 text-right">{formatCurrency(s.revenue)}</td>
                      <td className="py-2.5 px-2 text-right"><DeltaCell cur={s.revenue} prev={prev.skuMap[s.sku]?.revenue || 0} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 7. 新品首月表現 */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-400" /> 7. 新品首月表現
            <span className="text-[13px] font-normal text-muted-foreground">
              {monthLabel}上架 {newProducts.count} 款 · 有售 {newProducts.items.length} 款 · 預計缺貨按上架至今速率估
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {newProducts.items.length === 0 ? (
            <div className="text-sm text-muted-foreground">{monthLabel}未有新上架產品錄得銷售</div>
          ) : (
            <ProductItemList
              items={newProducts.items} qtyLabel="本月售出" topN={10} showRank
              imageMap={imageMap} handleMap={handleMap}
              productStockMap={newProductStock} velocityMap={newProducts.velocityMap}
            />
          )}
        </CardContent>
      </Card>

      {/* 8. 員工月度排名 */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> 8. 員工月度排名
            <span className="text-[13px] font-normal text-muted-foreground">POS 落單歸屬 · 改名去「昨日/本週」頁員工表撳個名</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {staffRows.rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">本月無員工歸屬銷售</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[13px] text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="text-left py-2.5 px-2">排名</th>
                    <th className="text-left py-2.5 px-2">姓名</th>
                    <th className="text-right py-2.5 px-2">訂單</th>
                    <th className="text-right py-2.5 px-2">營收</th>
                    <th className="text-right py-2.5 px-2">均價</th>
                    <th className="text-right py-2.5 px-2">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {staffRows.rows.map((s, i) => (
                    <tr key={s.uid} className={`border-b border-border/20 ${i === 0 ? 'bg-amber-500/5' : ''}`}>
                      <td className="py-2.5 px-2">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</td>
                      <td className="py-2.5 px-2 font-medium">{s.name}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums">{s.cnt}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums font-semibold">{formatCurrency(s.rev)}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">{formatCurrency(s.cnt > 0 ? s.rev / s.cnt : 0)}</td>
                      <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">{staffRows.total > 0 ? `${((s.rev / staffRows.total) * 100).toFixed(0)}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 9. Promo Codes */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base">9. Promo Codes 折扣碼</CardTitle>
        </CardHeader>
        <CardContent>
          {promoRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">本月沒有使用折扣碼</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[13px] text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="text-left py-2.5 px-2">折扣碼</th>
                    <th className="text-right py-2.5 px-2">使用次數</th>
                    <th className="text-right py-2.5 px-2">折讓金額</th>
                    <th className="text-right py-2.5 px-2">帶來營收</th>
                    <th className="text-right py-2.5 px-2">vs 上月</th>
                  </tr>
                </thead>
                <tbody>
                  {promoRows.map(r => (
                    <tr key={r.code} className="border-b border-border/20 hover:bg-accent/20">
                      <td className="py-2.5 px-2 font-medium">{r.code}</td>
                      <td className="py-2.5 px-2 text-right">{formatNumber(r.uses)}</td>
                      <td className="py-2.5 px-2 text-right text-amber-400">− {formatCurrency(r.discountAmt)}</td>
                      <td className="py-2.5 px-2 text-right">{formatCurrency(r.revenue)}</td>
                      <td className="py-2.5 px-2 text-right"><DeltaCell cur={r.revenue} prev={prev.promoCodes[r.code]?.revenue || 0} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 10. 渠道分析 */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base">10. 銷售渠道分析</CardTitle>
          <p className="text-[13px] text-muted-foreground">{curRange.from} → {curRange.to} · 對比上月</p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {channelRows.map(c => (
            <div key={c.name} className="border border-border/40 rounded-lg p-4 bg-accent/10">
              <div className="flex items-center gap-2 mb-2">
                <ChannelIcon name={c.name} />
                <span className="text-sm font-medium">{c.name}</span>
                <span className="ml-auto text-[13px] text-muted-foreground">{(c.share * 100).toFixed(1)}%</span>
              </div>
              <div className="text-xl font-bold">{formatCurrency(c.revenue)}</div>
              <div className="text-[13px] text-muted-foreground mt-1">
                {formatNumber(c.orders)} 張訂單 · 上月 {formatCurrency(prev.channelMap[c.name]?.revenue || 0)}
                {' '}<DeltaCell cur={c.revenue} prev={prev.channelMap[c.name]?.revenue || 0} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Drill modals */}
      <Modal open={!!brandDrill} onClose={() => setBrandDrill(null)} title={`品牌明細 — ${brandDrill || ''}`} subtitle={`${curRange.from} → ${curRange.to}`}>
        {brandDrill && cur.brandTree[brandDrill] && <DrillTable variants={Object.values(cur.brandTree[brandDrill].variants).sort((a, b) => b.revenue - a.revenue)} parent={brandDrill} />}
      </Modal>
      <Modal open={!!catDrill} onClose={() => setCatDrill(null)} title={`品類明細 — ${catDrill || ''}`} subtitle={`${curRange.from} → ${curRange.to}`}>
        {catDrill && cur.catTree[catDrill] && <DrillTable variants={Object.values(cur.catTree[catDrill].variants).sort((a, b) => b.revenue - a.revenue)} parent={catDrill} />}
      </Modal>
    </div>
  );
}
