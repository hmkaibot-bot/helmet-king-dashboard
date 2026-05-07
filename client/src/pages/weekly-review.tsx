import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  DollarSign, ShoppingCart, TrendingUp, Tag, Calendar,
  Store, Globe, Truck, ChevronRight, ChevronDown, X,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie,
} from 'recharts';

import { queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { DataFreshnessBadge } from '@/components/data-freshness';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  getDefaultWeekRange, getPrevRange, getYoYRange, getMonthBounds,
  toDateStr, calcDelta, processOrders, type Order, type Line,
} from '@/lib/weekly-review-utils';

// ─── DateRangeBar ────────────────────────────────────────────────────────────
function DateRangeBar({
  from, to, onChange,
}: {
  from: string; to: string;
  onChange: (f: string, t: string) => void;
}) {
  const setPreset = (preset: 'thisWeek' | 'lastWeek' | 'mtd' | 'last7' | 'last30') => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toDateStr(today);
    if (preset === 'thisWeek') {
      const r = getDefaultWeekRange();
      onChange(r.from, r.to);
    } else if (preset === 'lastWeek') {
      const r = getDefaultWeekRange();
      const p = getPrevRange(r.from, r.to);
      onChange(p.from, p.to);
    } else if (preset === 'mtd') {
      const m = getMonthBounds();
      onChange(m.from, m.to);
    } else if (preset === 'last7') {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      onChange(toDateStr(start), todayStr);
    } else {
      const start = new Date(today);
      start.setDate(today.getDate() - 29);
      onChange(toDateStr(start), todayStr);
    }
  };

  return (
    <div className="sticky top-0 z-30 -mx-4 px-4 py-3 bg-background/85 backdrop-blur border-b border-border/40 flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">日期範圍</span>
      </div>
      <input
        type="date"
        value={from}
        onChange={e => onChange(e.target.value, to)}
        className="bg-accent/40 border border-border/50 rounded px-2 py-1 text-xs text-foreground"
        data-testid="weekly-from"
      />
      <span className="text-muted-foreground text-xs">至</span>
      <input
        type="date"
        value={to}
        onChange={e => onChange(from, e.target.value)}
        className="bg-accent/40 border border-border/50 rounded px-2 py-1 text-xs text-foreground"
        data-testid="weekly-to"
      />
      <span className="text-xs text-muted-foreground hidden md:inline">
        · 預設為週三至週二（週會週期）
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <PresetButton onClick={() => setPreset('thisWeek')}>本週(三→二)</PresetButton>
        <PresetButton onClick={() => setPreset('lastWeek')}>上週</PresetButton>
        <PresetButton onClick={() => setPreset('last7')}>近 7 日</PresetButton>
        <PresetButton onClick={() => setPreset('last30')}>近 30 日</PresetButton>
        <PresetButton onClick={() => setPreset('mtd')}>本月</PresetButton>
        <DataFreshnessBadge />
      </div>
    </div>
  );
}

function PresetButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-2 py-1 rounded border border-border/50 bg-accent/30 hover:bg-accent/60 transition-colors"
    >
      {children}
    </button>
  );
}

// ─── Modal shell ─────────────────────────────────────────────────────────────
function Modal({
  open, onClose, title, subtitle, children,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="bg-card border border-border/40 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border/40">
          <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            {subtitle && <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/50">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto max-h-[calc(85vh-60px)]">{children}</div>
      </div>
    </div>
  );
}

// ─── Channel icon ────────────────────────────────────────────────────────────
function ChannelIcon({ name }: { name: string }) {
  if (name === '門市 POS') return <Store className="h-4 w-4 text-amber-400" />;
  if (name === '網店 Online') return <Globe className="h-4 w-4 text-sky-400" />;
  return <Truck className="h-4 w-4 text-violet-400" />;
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function WeeklyReview() {
  const [loading, setLoading] = useState(true);
  const [ordersRaw, setOrdersRaw] = useState<Order[]>([]);
  const [linesRaw, setLinesRaw] = useState<Line[]>([]);

  // Global date range
  const initial = useMemo(() => getDefaultWeekRange(), []);
  const [range, setRange] = useState(initial);
  const prevRange = useMemo(() => getPrevRange(range.from, range.to), [range]);
  const yoyRange = useMemo(() => getYoYRange(range.from, range.to), [range]);
  const monthRange = useMemo(() => getMonthBounds(), []);

  // Modals
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoDetail, setPromoDetail] = useState<string | null>(null);
  const [brandDrill, setBrandDrill] = useState<string | null>(null);
  const [catDrill, setCatDrill] = useState<string | null>(null);
  const [brandPerfMetric, setBrandPerfMetric] = useState<'revenue' | 'qty'>('revenue');
  const [brandPerfExpand, setBrandPerfExpand] = useState(false);
  const [hiddenBrands, setHiddenBrands] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const [orders, lines] = await Promise.all([
          queryAllPages(
            'shopify_orders',
            'id,order_number,created_at,total_price,total_discounts,financial_status,cancelled_at,discount_codes,source_name'
          ),
          queryAllPages(
            'shopify_order_lines',
            'order_id,product_id,sku,title,vendor,product_type,quantity,price'
          ),
        ]);
        setOrdersRaw(orders as any);
        setLinesRaw(lines as any);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const cur = useMemo(
    () => processOrders(ordersRaw, linesRaw, range.from, range.to),
    [ordersRaw, linesRaw, range]
  );
  const prev = useMemo(
    () => processOrders(ordersRaw, linesRaw, prevRange.from, prevRange.to),
    [ordersRaw, linesRaw, prevRange]
  );
  const yoy = useMemo(
    () => processOrders(ordersRaw, linesRaw, yoyRange.from, yoyRange.to),
    [ordersRaw, linesRaw, yoyRange]
  );
  const monthly = useMemo(
    () => processOrders(ordersRaw, linesRaw, monthRange.from, monthRange.to),
    [ordersRaw, linesRaw, monthRange]
  );

  // Section 1 — channel rows
  const channelRows = useMemo(() => {
    const total = Object.values(monthly.channelMap).reduce((s, c) => s + c.revenue, 0);
    return Object.entries(monthly.channelMap)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([name, v]) => ({
        name,
        orders: v.orders,
        revenue: v.revenue,
        share: total > 0 ? v.revenue / total : 0,
      }));
  }, [monthly]);

  // Section 4 — top brands / categories (exclude refunds → already done in process)
  const topBrands = useMemo(
    () =>
      Object.entries(cur.brandMap)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 5)
        .map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })),
    [cur]
  );
  const topCats = useMemo(
    () =>
      Object.entries(cur.catMap)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 5)
        .map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })),
    [cur]
  );

  // Section 5 — brand performance bar chart
  const brandPerf = useMemo(() => {
    const all = Object.entries(cur.brandMap)
      .filter(([n]) => !hiddenBrands.has(n))
      .map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty }))
      .sort((a, b) => (brandPerfMetric === 'revenue' ? b.revenue - a.revenue : b.qty - a.qty));
    return brandPerfExpand ? all : all.slice(0, 10);
  }, [cur, brandPerfMetric, brandPerfExpand, hiddenBrands]);

  // Section 6 — category & brand performance tables
  const brandTable = useMemo(
    () =>
      Object.entries(cur.brandMap)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })),
    [cur]
  );
  const catTable = useMemo(
    () =>
      Object.entries(cur.catMap)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty })),
    [cur]
  );

  // Section 3 — promo summary
  const promoSummary = useMemo(() => {
    const totalUses = Object.values(cur.promoCodes).reduce((s, c) => s + c.uses, 0);
    const totalDisc = Object.values(cur.promoCodes).reduce((s, c) => s + c.discountAmt, 0);
    const totalRev = Object.values(cur.promoCodes).reduce((s, c) => s + c.revenue, 0);
    return { totalUses, totalDisc, totalRev };
  }, [cur]);

  const promoRows = useMemo(
    () =>
      Object.entries(cur.promoCodes)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([code, v]) => ({
          code,
          uses: v.uses,
          discountAmt: v.discountAmt,
          revenue: v.revenue,
          orderIds: Array.from(v.orderIds),
        })),
    [cur]
  );

  // Helper: when expanding a promo, build its detail rows
  const promoDetailRows = useMemo(() => {
    if (!promoDetail) return null;
    const code = promoDetail;
    const orderIds = new Set(cur.promoCodes[code]?.orderIds || []);
    const orders = ordersRaw.filter(o => orderIds.has(String(o.id)));
    const lines = linesRaw.filter(l => orderIds.has(String(l.order_id)));
    const items = lines.map(l => ({
      orderName: orders.find(o => String(o.id) === String(l.order_id))?.order_number || '?',
      title: l.title || '',
      sku: l.sku || '',
      qty: parseInt(String(l.quantity || 0), 10),
      revenue: parseFloat(String(l.price || 0)) * (parseInt(String(l.quantity || 0), 10) || 0),
    }));
    return items.sort((a, b) => b.revenue - a.revenue);
  }, [promoDetail, cur, ordersRaw, linesRaw]);

  // Drill-down data for brand
  const brandDrillData = useMemo(() => {
    if (!brandDrill) return null;
    const node = cur.brandTree[brandDrill];
    if (!node) return null;
    return Object.values(node.variants).sort((a, b) => b.revenue - a.revenue);
  }, [brandDrill, cur]);

  const catDrillData = useMemo(() => {
    if (!catDrill) return null;
    const node = cur.catTree[catDrill];
    if (!node) return null;
    return Object.values(node.variants).sort((a, b) => b.revenue - a.revenue);
  }, [catDrill, cur]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (<Skeleton key={i} className="h-24" />))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const totalDays = Math.round(
    (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86400000
  ) + 1;

  return (
    <div className="space-y-6 p-4 pb-20">
      {/* Title + global filter */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">週報 Weekly Review</h1>
        <p className="text-sm text-muted-foreground">
          {range.from} → {range.to}（{totalDays} 天）· 對比上一期 {prevRange.from} → {prevRange.to}
        </p>
      </div>

      <DateRangeBar
        from={range.from}
        to={range.to}
        onChange={(f, t) => setRange({ from: f, to: t })}
      />

      {/* 1. 銷售渠道分析（當月） */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base">1. 銷售渠道分析（當月）</CardTitle>
          <p className="text-xs text-muted-foreground">{monthRange.from} → {monthRange.to}</p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {channelRows.length === 0 && (
            <div className="text-sm text-muted-foreground col-span-3">本月暫無銷售資料</div>
          )}
          {channelRows.map(c => (
            <div key={c.name} className="border border-border/40 rounded-lg p-4 bg-accent/10">
              <div className="flex items-center gap-2 mb-2">
                <ChannelIcon name={c.name} />
                <span className="text-sm font-medium">{c.name}</span>
                <Badge variant="secondary" className="ml-auto text-[10px]">
                  {formatPercent(c.share * 100)}
                </Badge>
              </div>
              <div className="text-xl font-bold">{formatCurrency(c.revenue)}</div>
              <div className="text-xs text-muted-foreground mt-1">{formatNumber(c.orders)} 張訂單</div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* 2. 本期核心 KPI */}
      <div>
        <h2 className="text-base font-semibold mb-3">2. 本期核心 KPI</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            title="本期營收"
            subtitle={`vs 上期 / vs 去年`}
            value={formatCurrency(cur.revenue)}
            icon={DollarSign}
            delta={calcDelta(cur.revenue, prev.revenue)}
            testId="kpi-revenue"
          />
          <KpiCard
            title="本期訂單"
            subtitle={`vs 上期 / vs 去年`}
            value={formatNumber(cur.orders)}
            icon={ShoppingCart}
            delta={calcDelta(cur.orders, prev.orders)}
            testId="kpi-orders"
          />
          <KpiCard
            title="平均單價 AOV"
            subtitle={`vs 上期 / vs 去年`}
            value={formatCurrency(cur.aov)}
            icon={TrendingUp}
            delta={calcDelta(cur.aov, prev.aov)}
            testId="kpi-aov"
          />
          <button onClick={() => setPromoOpen(true)} className="text-left" data-testid="kpi-promo-button">
            <KpiCard
              title="折扣碼數量"
              subtitle="點擊展開明細"
              value={formatNumber(cur.promoCount)}
              icon={Tag}
              delta={calcDelta(cur.promoCount, prev.promoCount)}
              testId="kpi-promo"
            />
          </button>
        </div>
        {/* YoY supplementary line */}
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] text-muted-foreground">
          <YoyLine label="vs 去年同期" cur={cur.revenue} ref={yoy.revenue} fmt={formatCurrency} />
          <YoyLine label="vs 去年同期" cur={cur.orders} ref={yoy.orders} fmt={formatNumber} />
          <YoyLine label="vs 去年同期" cur={cur.aov} ref={yoy.aov} fmt={formatCurrency} />
          <YoyLine label="vs 去年同期" cur={cur.promoCount} ref={yoy.promoCount} fmt={formatNumber} />
        </div>
      </div>

      {/* 3. Promo Codes 折扣碼使用情況 */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>3. Promo Codes 折扣碼使用情況</span>
            <span className="text-xs font-normal text-muted-foreground">
              共 {cur.promoCount} 個折扣碼，使用 {formatNumber(promoSummary.totalUses)} 次，
              折讓 {formatCurrency(promoSummary.totalDisc)}，
              帶來 {formatCurrency(promoSummary.totalRev)} 營收
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {promoRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">本期沒有使用折扣碼</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="text-left py-2 px-2">折扣碼</th>
                    <th className="text-right py-2 px-2">使用次數</th>
                    <th className="text-right py-2 px-2">折讓金額</th>
                    <th className="text-right py-2 px-2">帶來營收</th>
                    <th className="text-right py-2 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {promoRows.map(r => (
                    <tr key={r.code} className="border-b border-border/20 hover:bg-accent/20">
                      <td className="py-2 px-2 font-medium">{r.code}</td>
                      <td className="py-2 px-2 text-right">{formatNumber(r.uses)}</td>
                      <td className="py-2 px-2 text-right text-amber-400">
                        − {formatCurrency(r.discountAmt)}
                      </td>
                      <td className="py-2 px-2 text-right">{formatCurrency(r.revenue)}</td>
                      <td className="py-2 px-2 text-right">
                        <button
                          onClick={() => setPromoDetail(r.code)}
                          className="text-xs text-sky-400 hover:underline"
                        >
                          明細
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4. Top 5 Brands / Categories */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-border/40">
          <CardHeader>
            <CardTitle className="text-base">4a. Top 5 品牌</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList rows={topBrands} />
          </CardContent>
        </Card>
        <Card className="border-border/40">
          <CardHeader>
            <CardTitle className="text-base">4b. Top 5 品類</CardTitle>
          </CardHeader>
          <CardContent>
            <TopList rows={topCats} />
          </CardContent>
        </Card>
      </div>

      {/* 5. Brand Performance */}
      <ChartCard
        title="5. 品牌表現 Brand Performance"
        subtitle={`${range.from} → ${range.to}　·　${brandPerfMetric === 'revenue' ? '銷售額' : '件數'}`}
        note=""
      >
        <div className="flex items-center gap-2 mb-2">
          <button
            className={`text-xs px-2 py-1 rounded border ${brandPerfMetric === 'revenue' ? 'bg-primary text-primary-foreground' : 'bg-accent/30 border-border/40'}`}
            onClick={() => setBrandPerfMetric('revenue')}
          >銷售額</button>
          <button
            className={`text-xs px-2 py-1 rounded border ${brandPerfMetric === 'qty' ? 'bg-primary text-primary-foreground' : 'bg-accent/30 border-border/40'}`}
            onClick={() => setBrandPerfMetric('qty')}
          >件數</button>
          <button
            className="text-xs px-2 py-1 rounded border bg-accent/30 border-border/40 ml-auto"
            onClick={() => setBrandPerfExpand(v => !v)}
          >
            {brandPerfExpand ? '收起 (僅顯示 Top10)' : `展開全部 (${Object.keys(cur.brandMap).length})`}
          </button>
        </div>
        <div style={{ height: brandPerfExpand ? Math.max(300, brandPerf.length * 24) : 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={brandPerf}
              layout="vertical"
              margin={{ top: 10, right: 24, bottom: 10, left: 100 }}
            >
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" {...AXIS_STYLE} />
              <YAxis dataKey="name" type="category" {...AXIS_STYLE} width={100} />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(v: any) => brandPerfMetric === 'revenue' ? formatCurrency(v as number) : formatNumber(v as number)}
              />
              <Bar dataKey={brandPerfMetric} radius={[0, 4, 4, 0]}>
                {brandPerf.map((_, i) => (
                  <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {Object.keys(cur.brandMap).map(name => {
            const hidden = hiddenBrands.has(name);
            return (
              <button
                key={name}
                onClick={() => {
                  setHiddenBrands(s => {
                    const n = new Set(s);
                    if (n.has(name)) n.delete(name); else n.add(name);
                    return n;
                  });
                }}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${hidden ? 'bg-muted/30 border-border/30 text-muted-foreground line-through' : 'bg-accent/40 border-border/50'}`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </ChartCard>

      {/* 6. Brand & Category Performance Details (drill-down) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PerformanceTable
          title="6a. 品牌表現明細（點擊展開）"
          rows={brandTable}
          onClick={n => setBrandDrill(n)}
        />
        <PerformanceTable
          title="6b. 品類表現明細（點擊展開）"
          rows={catTable}
          onClick={n => setCatDrill(n)}
        />
      </div>

      {/* 7. Top 5 SKU */}
      <Card className="border-border/40">
        <CardHeader>
          <CardTitle className="text-base">7. 本期最佳產品 Top 5 SKU</CardTitle>
        </CardHeader>
        <CardContent>
          {cur.topSkus.length === 0 ? (
            <div className="text-sm text-muted-foreground">本期暫無資料</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="text-left py-2 px-2">#</th>
                    <th className="text-left py-2 px-2">品牌</th>
                    <th className="text-left py-2 px-2">SKU / 產品名稱</th>
                    <th className="text-right py-2 px-2">件數</th>
                    <th className="text-right py-2 px-2">銷售額</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.topSkus.map((s, i) => (
                    <tr key={s.sku + i} className="border-b border-border/20 hover:bg-accent/20">
                      <td className="py-2 px-2 text-muted-foreground">#{i + 1}</td>
                      <td className="py-2 px-2">{s.vendor}</td>
                      <td className="py-2 px-2">
                        <div className="font-medium text-foreground">{s.title}</div>
                        <div className="text-xs text-muted-foreground">{s.sku}</div>
                      </td>
                      <td className="py-2 px-2 text-right">{formatNumber(s.qty)}</td>
                      <td className="py-2 px-2 text-right">{formatCurrency(s.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Modals ─────────────────────────────────────────────────────── */}
      <Modal
        open={promoOpen}
        onClose={() => setPromoOpen(false)}
        title="折扣碼一覽"
        subtitle={`${range.from} → ${range.to}（${cur.promoCount} 個碼，${promoSummary.totalUses} 次使用）`}
      >
        <PromoTable rows={promoRows} onPick={c => { setPromoOpen(false); setPromoDetail(c); }} />
      </Modal>

      <Modal
        open={!!promoDetail}
        onClose={() => setPromoDetail(null)}
        title={`折扣碼明細 — ${promoDetail || ''}`}
        subtitle={`${range.from} → ${range.to}`}
      >
        {promoDetailRows && (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b border-border/40">
              <tr>
                <th className="text-left py-2 px-2">訂單</th>
                <th className="text-left py-2 px-2">商品</th>
                <th className="text-right py-2 px-2">件數</th>
                <th className="text-right py-2 px-2">銷售額</th>
              </tr>
            </thead>
            <tbody>
              {promoDetailRows.map((r, i) => (
                <tr key={i} className="border-b border-border/20">
                  <td className="py-2 px-2">{r.orderName}</td>
                  <td className="py-2 px-2">
                    <div>{r.title}</div>
                    <div className="text-xs text-muted-foreground">{r.sku}</div>
                  </td>
                  <td className="py-2 px-2 text-right">{formatNumber(r.qty)}</td>
                  <td className="py-2 px-2 text-right">{formatCurrency(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>

      <Modal
        open={!!brandDrill}
        onClose={() => setBrandDrill(null)}
        title={`品牌明細 — ${brandDrill || ''}`}
        subtitle={`${range.from} → ${range.to} · 點擊產品看 SKU 明細`}
      >
        {brandDrillData && (
          <DrillTable variants={brandDrillData} parent={brandDrill || ''} />
        )}
      </Modal>

      <Modal
        open={!!catDrill}
        onClose={() => setCatDrill(null)}
        title={`品類明細 — ${catDrill || ''}`}
        subtitle={`${range.from} → ${range.to} · 點擊產品看 SKU 明細`}
      >
        {catDrillData && (
          <DrillTable variants={catDrillData} parent={catDrill || ''} />
        )}
      </Modal>
    </div>
  );
}

// ─── Sub components ──────────────────────────────────────────────────────────
function YoyLine({ label, cur, ref, fmt }: { label: string; cur: number; ref: number; fmt: (v: number) => string }) {
  const d = calcDelta(cur, ref);
  if (d == null) {
    return <div className="px-3">{label}: 去年無數據</div>;
  }
  const color = d > 0 ? 'text-emerald-400' : d < 0 ? 'text-red-400' : 'text-muted-foreground';
  return (
    <div className="px-3">
      {label}: {fmt(ref)} <span className={color}>({d > 0 ? '+' : ''}{d.toFixed(1)}%)</span>
    </div>
  );
}

function TopList({ rows }: { rows: { name: string; revenue: number; qty: number }[] }) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">本期暫無資料</div>;
  const max = Math.max(...rows.map(r => r.revenue));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.name + i} className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground w-5 text-xs">#{i + 1}</span>
          <div className="flex-1">
            <div className="flex items-baseline justify-between">
              <span className="font-medium truncate">{r.name}</span>
              <span className="text-foreground tabular-nums ml-3">{formatCurrency(r.revenue)}</span>
            </div>
            <div className="h-1.5 bg-accent/30 rounded mt-1 overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{ width: max > 0 ? `${(r.revenue / max) * 100}%` : 0 }}
              />
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{formatNumber(r.qty)} 件</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PerformanceTable({
  title, rows, onClick,
}: {
  title: string;
  rows: { name: string; revenue: number; qty: number }[];
  onClick: (name: string) => void;
}) {
  return (
    <Card className="border-border/40">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">本期暫無資料</div>
        ) : (
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b border-border/40 sticky top-0 bg-card">
                <tr>
                  <th className="text-left py-2 px-2">名稱</th>
                  <th className="text-right py-2 px-2">銷售額</th>
                  <th className="text-right py-2 px-2">件數</th>
                  <th className="text-right py-2 px-2">AOV</th>
                  <th className="w-6"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr
                    key={r.name}
                    onClick={() => onClick(r.name)}
                    className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
                  >
                    <td className="py-2 px-2 font-medium">{r.name}</td>
                    <td className="py-2 px-2 text-right">{formatCurrency(r.revenue)}</td>
                    <td className="py-2 px-2 text-right">{formatNumber(r.qty)}</td>
                    <td className="py-2 px-2 text-right">
                      {r.qty > 0 ? formatCurrency(r.revenue / r.qty) : '—'}
                    </td>
                    <td className="px-2"><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PromoTable({
  rows, onPick,
}: {
  rows: ReturnType<typeof Object.entries> extends infer R ? any : any;
  onPick: (code: string) => void;
}) {
  const arr = rows as { code: string; uses: number; discountAmt: number; revenue: number }[];
  if (arr.length === 0) return <div className="text-sm text-muted-foreground">本期沒有使用折扣碼</div>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border/40">
        <tr>
          <th className="text-left py-2 px-2">折扣碼</th>
          <th className="text-right py-2 px-2">使用次數</th>
          <th className="text-right py-2 px-2">折讓金額</th>
          <th className="text-right py-2 px-2">帶來營收</th>
        </tr>
      </thead>
      <tbody>
        {arr.map(r => (
          <tr
            key={r.code}
            onClick={() => onPick(r.code)}
            className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
          >
            <td className="py-2 px-2 font-medium">{r.code}</td>
            <td className="py-2 px-2 text-right">{formatNumber(r.uses)}</td>
            <td className="py-2 px-2 text-right text-amber-400">− {formatCurrency(r.discountAmt)}</td>
            <td className="py-2 px-2 text-right">{formatCurrency(r.revenue)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DrillTable({
  variants, parent,
}: {
  variants: { title: string; qty: number; revenue: number; skus: Record<string, { sku: string; title: string; qty: number; revenue: number }> }[];
  parent: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const totalRev = variants.reduce((s, v) => s + v.revenue, 0);

  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border/40">
        <tr>
          <th className="text-left py-2 px-2">產品 (Variant)</th>
          <th className="text-right py-2 px-2">件數</th>
          <th className="text-right py-2 px-2">銷售額</th>
          <th className="text-right py-2 px-2">平均單價</th>
          <th className="text-right py-2 px-2">佔比</th>
        </tr>
      </thead>
      <tbody>
        {variants.map(v => {
          const open = expanded.has(v.title);
          const skuList = Object.values(v.skus).sort((a, b) => b.revenue - a.revenue);
          return (
            <Fragment key={v.title}>
              <tr
                onClick={() => {
                  setExpanded(s => {
                    const n = new Set(s);
                    if (n.has(v.title)) n.delete(v.title); else n.add(v.title);
                    return n;
                  });
                }}
                className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
              >
                <td className="py-2 px-2 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {v.title}
                  </span>
                </td>
                <td className="py-2 px-2 text-right">{formatNumber(v.qty)}</td>
                <td className="py-2 px-2 text-right">{formatCurrency(v.revenue)}</td>
                <td className="py-2 px-2 text-right">
                  {v.qty > 0 ? formatCurrency(v.revenue / v.qty) : '—'}
                </td>
                <td className="py-2 px-2 text-right text-xs text-muted-foreground">
                  {totalRev > 0 ? formatPercent((v.revenue / totalRev) * 100) : '—'}
                </td>
              </tr>
              {open && skuList.map(s => (
                <tr key={v.title + s.sku} className="bg-muted/10 border-b border-border/10">
                  <td className="py-1.5 pl-10 pr-2 text-xs text-muted-foreground">
                    SKU: {s.sku}
                  </td>
                  <td className="py-1.5 px-2 text-right text-xs">{formatNumber(s.qty)}</td>
                  <td className="py-1.5 px-2 text-right text-xs">{formatCurrency(s.revenue)}</td>
                  <td className="py-1.5 px-2 text-right text-xs">
                    {s.qty > 0 ? formatCurrency(s.revenue / s.qty) : '—'}
                  </td>
                  <td></td>
                </tr>
              ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
