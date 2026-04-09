import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, ShoppingCart, TrendingUp, Package, Percent, Target, ChevronRight } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { KPI_TARGETS, kpiStatus } from '@/lib/kpi-targets';
import { getDateRanges, pctChange, formatPctChange } from '@/lib/time-intelligence';

// ─── Target KPI Card ───────────────────────────────────────────────
function TargetKpiCard({
  label, sublabel, value, target, prevValue, unit = 'HKD', loading, icon: Icon,
}: {
  label: string; sublabel: string; value: number; target: number; prevValue?: number | null;
  unit?: 'HKD' | '%' | '' | 'x'; loading?: boolean; icon: any;
}) {
  const status = kpiStatus(value, target);
  const mom = prevValue != null && prevValue !== 0 ? pctChange(value, prevValue) : null;

  const fmtValue = unit === 'HKD' ? formatCurrency(value)
    : unit === '%' ? formatPercent(value)
    : unit === 'x' ? `${value.toFixed(1)}x`
    : formatNumber(value);

  return (
    <Card className="border-border/40" data-testid={`target-kpi-${sublabel.toLowerCase().replace(/\s/g,'-')}`}>
      <CardContent className="p-4">
        <div className="flex justify-between items-start mb-1">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
              <Icon className="h-3.5 w-3.5" />
            </div>
            <span className="text-xs text-muted-foreground">{label} <span className="opacity-70">{sublabel}</span></span>
          </div>
          <span className="text-base leading-none" title={status.achieved ? 'On target' : `${status.pct}% of target`}>{status.icon}</span>
        </div>
        {loading ? <Skeleton className="h-7 w-24 mt-1" /> : (
          <>
            <p className="text-xl font-semibold tabular-nums tracking-tight mt-1">{fmtValue}</p>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1">
              {mom !== null && (
                <span className={mom >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {formatPctChange(mom)} MoM
                </span>
              )}
              <span>目標 {status.pct}%</span>
            </div>
            <div className="mt-2 bg-muted/40 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-1.5 rounded-full transition-all ${status.bgColor}`}
                style={{ width: `${Math.min(100, status.pct)}%` }}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────
export default function RetailSalesPage() {
  const { bounds, prevBounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [revenue, setRevenue] = useState(0);
  const [prevRevenue, setPrevRevenue] = useState(0);
  const [orders, setOrders] = useState(0);
  const [prevOrders, setPrevOrders] = useState(0);
  const [itemsSold, setItemsSold] = useState(0);
  const [prevItemsSold, setPrevItemsSold] = useState(0);
  const [discountRate, setDiscountRate] = useState(0);
  const [prevDiscountRate, setPrevDiscountRate] = useState(0);
  const [dailyRevenue, setDailyRevenue] = useState<any[]>([]);
  const [hourlyOrders, setHourlyOrders] = useState<any[]>([]);
  const [sourceData, setSourceData] = useState<any[]>([]);
  const [topCustomers, setTopCustomers] = useState<any[]>([]);
  const [refundTrend, setRefundTrend] = useState<any[]>([]);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [marginData, setMarginData] = useState<any[]>([]);

  // MTD data for targets
  const [mtdRevenue, setMtdRevenue] = useState(0);
  const [mtdOrders, setMtdOrders] = useState(0);
  const [prevMtdRevenue, setPrevMtdRevenue] = useState(0);
  const [prevMtdOrders, setPrevMtdOrders] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const ranges = getDateRanges();

        const [ordersData, prevOrdersData, orderLines, mtdOrdersData, prevMtdOrdersData] = await Promise.all([
          queryWithDateRange('shopify_orders', 'id,order_number,created_at,total_price,subtotal_price,total_discounts,financial_status,cancelled_at,customer_name,customer_email,source_name', 'created_at', bounds),
          queryWithDateRange('shopify_orders', 'id,total_price,subtotal_price,total_discounts,financial_status,cancelled_at', 'created_at', prevBounds),
          queryAll('shopify_order_lines', 'order_id,quantity'),
          queryWithDateRange('shopify_orders', 'id,total_price,financial_status,cancelled_at', 'created_at', { from: ranges.mtd.start, to: ranges.mtd.end }),
          queryWithDateRange('shopify_orders', 'id,total_price,financial_status,cancelled_at', 'created_at', { from: ranges.prevMtd.start, to: ranges.prevMtd.end }),
        ]);

        if (cancelled) return;

        // MTD calculations
        const mtdValid = mtdOrdersData.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const prevMtdValid = prevMtdOrdersData.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const mtdRev = mtdValid.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
        const pMtdRev = prevMtdValid.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
        setMtdRevenue(mtdRev);
        setMtdOrders(mtdValid.length);
        setPrevMtdRevenue(pMtdRev);
        setPrevMtdOrders(prevMtdValid.length);

        const valid = ordersData.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const prevValid = prevOrdersData.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);

        const rev = valid.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
        const pRev = prevValid.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);

        const orderIds = new Set(valid.map((o: any) => o.id));
        const items = orderLines.filter((l: any) => orderIds.has(l.order_id));
        const totalItems = items.reduce((s: number, l: any) => s + (l.quantity || 0), 0);

        const prevOrderIds = new Set(prevValid.map((o: any) => o.id));
        const prevItems = orderLines.filter((l: any) => prevOrderIds.has(l.order_id));
        const prevTotalItems = prevItems.reduce((s: number, l: any) => s + (l.quantity || 0), 0);

        const totalDisc = valid.reduce((s: number, o: any) => s + (parseFloat(o.total_discounts) || 0), 0);
        const totalSub = valid.reduce((s: number, o: any) => s + (parseFloat(o.subtotal_price) || 0), 0);
        const disc = totalSub > 0 ? (totalDisc / totalSub) * 100 : 0;

        const pTotalDisc = prevValid.reduce((s: number, o: any) => s + (parseFloat(o.total_discounts) || 0), 0);
        const pTotalSub = prevValid.reduce((s: number, o: any) => s + (parseFloat(o.subtotal_price) || 0), 0);
        const pDisc = pTotalSub > 0 ? (pTotalDisc / pTotalSub) * 100 : 0;

        setRevenue(rev); setPrevRevenue(pRev);
        setOrders(valid.length); setPrevOrders(prevValid.length);
        setItemsSold(totalItems); setPrevItemsSold(prevTotalItems);
        setDiscountRate(disc); setPrevDiscountRate(pDisc);

        // Daily revenue
        const dayMap: Record<string, number> = {};
        valid.forEach((o: any) => {
          const day = o.created_at?.slice(0, 10);
          if (day) dayMap[day] = (dayMap[day] || 0) + (parseFloat(o.total_price) || 0);
        });
        setDailyRevenue(Object.entries(dayMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, val]) => ({ date: date.slice(5), revenue: val })));

        // Hours - convert to HKT (UTC+8)
        const hourMap: Record<number, number> = {};
        for (let i = 0; i < 24; i++) hourMap[i] = 0;
        valid.forEach((o: any) => {
          const utcH = new Date(o.created_at).getUTCHours();
          const hkt = (utcH + 8) % 24;
          hourMap[hkt]++;
        });
        setHourlyOrders(Object.entries(hourMap).map(([h, c]) => ({ hour: `${h}:00`, orders: c })));

        // Source
        const srcMap: Record<string, number> = {};
        valid.forEach((o: any) => {
          let src = o.source_name || 'unknown';
          if (src.startsWith('http')) src = 'referral';
          else if (/^\d+$/.test(src)) src = 'app';
          srcMap[src] = (srcMap[src] || 0) + (parseFloat(o.total_price) || 0);
        });
        setSourceData(Object.entries(srcMap).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })));

        // Top customers
        const custMap: Record<string, { name: string; total: number }> = {};
        valid.forEach((o: any) => {
          const name = o.customer_name;
          if (!name || name === '' || name === 'Unknown') return;
          const key = o.customer_email || name;
          if (!custMap[key]) custMap[key] = { name, total: 0 };
          custMap[key].total += parseFloat(o.total_price) || 0;
        });
        setTopCustomers(Object.values(custMap).sort((a, b) => b.total - a.total).slice(0, 10));

        // Refund trend by week
        const weekMap: Record<string, { total: number; refunded: number }> = {};
        ordersData.forEach((o: any) => {
          const d = new Date(o.created_at);
          const weekStart = new Date(d);
          weekStart.setDate(d.getDate() - d.getDay());
          const key = weekStart.toISOString().slice(0, 10);
          if (!weekMap[key]) weekMap[key] = { total: 0, refunded: 0 };
          weekMap[key].total++;
          if (o.financial_status === 'refunded' || o.cancelled_at) weekMap[key].refunded++;
        });
        setRefundTrend(Object.entries(weekMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, val]) => ({ date: date.slice(5), rate: val.total > 0 ? (val.refunded / val.total) * 100 : 0 })));

        // Recent 20
        setRecentOrders(ordersData.sort((a: any, b: any) => b.created_at.localeCompare(a.created_at)).slice(0, 20));

        // Category revenue
        const fullLines = await queryAll('shopify_order_lines', 'order_id,product_id,title,sku,vendor,quantity,price,product_type', undefined, 50000);
        const validFullLines = fullLines.filter((l: any) => orderIds.has(l.order_id));

        const catMap: Record<string, { units: number; revenue: number; orders: Set<string> }> = {};
        validFullLines.forEach((l: any) => {
          const cat = l.product_type || 'Uncategorized';
          if (!catMap[cat]) catMap[cat] = { units: 0, revenue: 0, orders: new Set() };
          catMap[cat].units += l.quantity || 0;
          catMap[cat].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
          catMap[cat].orders.add(l.order_id);
        });
        const totalCatRev = Object.values(catMap).reduce((s, c) => s + c.revenue, 0);
        const categoryArr = Object.entries(catMap)
          .map(([name, d]) => ({ name, units: d.units, revenue: d.revenue, orderCount: d.orders.size, avgPrice: d.units > 0 ? d.revenue / d.units : 0, pctTotal: totalCatRev > 0 ? (d.revenue / totalCatRev) * 100 : 0 }))
          .sort((a, b) => b.revenue - a.revenue);
        setCategoryData(categoryArr);

        // Margin analysis
        const bcInv = await queryAll('bc_inventory', 'number,display_name,unit_price,unit_cost,item_category_code', undefined, 50000);
        const costMap: Record<string, { unitPrice: number; unitCost: number }> = {};
        bcInv.forEach((item: any) => {
          if (item.number) costMap[item.number] = { unitPrice: parseFloat(item.unit_price) || 0, unitCost: parseFloat(item.unit_cost) || 0 };
        });

        const prodMargin: Record<string, { title: string; sku: string; qty: number; revenue: number; unitCost: number | null; matched: boolean }> = {};
        validFullLines.forEach((l: any) => {
          const sku = l.sku || '';
          const key = sku || l.title;
          if (!prodMargin[key]) {
            const cost = costMap[sku];
            prodMargin[key] = { title: l.title, sku, qty: 0, revenue: 0, unitCost: cost ? cost.unitCost : null, matched: !!cost };
          }
          prodMargin[key].qty += l.quantity || 0;
          prodMargin[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
        });
        const marginArr = Object.values(prodMargin)
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 20)
          .map((p) => {
            const avgSalePrice = p.qty > 0 ? p.revenue / p.qty : 0;
            const marginPct = p.matched && p.unitCost !== null && avgSalePrice > 0 ? ((avgSalePrice - p.unitCost) / avgSalePrice) * 100 : null;
            const totalGM = p.matched && p.unitCost !== null ? (avgSalePrice - p.unitCost) * p.qty : null;
            return { ...p, avgSalePrice, marginPct, totalGM };
          });
        setMarginData(marginArr);
      } catch (e) {
        console.error('RetailSales error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds, prevBounds]);

  const calcDelta = (curr: number, prev: number) => prev === 0 ? null : ((curr - prev) / prev) * 100;
  const aov = orders > 0 ? revenue / orders : 0;
  const prevAov = prevOrders > 0 ? prevRevenue / prevOrders : 0;
  const mtdAov = mtdOrders > 0 ? mtdRevenue / mtdOrders : 0;
  const prevMtdAov = prevMtdOrders > 0 ? prevMtdRevenue / prevMtdOrders : 0;

  // Target statuses
  const revStatus = kpiStatus(mtdRevenue, KPI_TARGETS.monthlyRevenue);
  const aovStatus = kpiStatus(mtdAov, KPI_TARGETS.aov);

  return (
    <div className="space-y-4">
      {/* ── MTD Target Progress ── */}
      <Card className="border-border/40 border-amber-500/20 bg-gradient-to-r from-amber-500/5 to-transparent" data-testid="mtd-target-progress">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Target className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-medium">月銷售目標進度 <span className="text-xs font-normal text-muted-foreground">Monthly Revenue Progress</span></span>
          </div>
          {loading ? <Skeleton className="h-12 w-full" /> : (
            <div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-2xl font-bold tabular-nums">{formatCurrency(mtdRevenue)}</span>
                <span className="text-muted-foreground text-sm">/ {formatCurrency(KPI_TARGETS.monthlyRevenue)} 目標</span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className={`text-sm font-semibold ${revStatus.color}`}>{revStatus.pct}% 達成 {revStatus.icon}</span>
              </div>
              <div className="bg-muted/40 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-2.5 rounded-full transition-all ${revStatus.bgColor}`}
                  style={{ width: `${Math.min(100, revStatus.pct)}%` }}
                />
              </div>
              {!revStatus.achieved && (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  距目標尚差 {formatCurrency(revStatus.gap)}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Target KPI Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <TargetKpiCard label="MTD 營收" sublabel="Revenue" value={mtdRevenue} target={KPI_TARGETS.monthlyRevenue} prevValue={prevMtdRevenue} unit="HKD" loading={loading} icon={DollarSign} />
        <TargetKpiCard label="MTD 訂單" sublabel="Orders" value={mtdOrders} target={1000} prevValue={prevMtdOrders} unit="" loading={loading} icon={ShoppingCart} />
        <TargetKpiCard label="MTD 平均單價" sublabel="AOV" value={mtdAov} target={KPI_TARGETS.aov} prevValue={prevMtdAov} unit="HKD" loading={loading} icon={TrendingUp} />
        <TargetKpiCard label="售出件數" sublabel="Items Sold" value={itemsSold} target={0} prevValue={prevItemsSold} unit="" loading={loading} icon={Package} />
        <TargetKpiCard label="折扣率" sublabel="Discount Rate" value={discountRate} target={10} prevValue={prevDiscountRate} unit="%" loading={loading} icon={Percent} />
      </div>

      {/* ── Period Comparison Table ── */}
      <Card className="border-border/40" data-testid="period-comparison">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">期間比較 <span className="text-xs font-normal text-muted-foreground">Period Comparison (selected range vs previous)</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[120px] w-full" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-period-comparison">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">指標 Metric</th>
                    <th className="py-2 text-right font-medium">本期 This Period</th>
                    <th className="py-2 text-right font-medium">上期 Last Period</th>
                    <th className="py-2 text-right font-medium">MoM %</th>
                    <th className="py-2 text-right font-medium">同期去年 YoY</th>
                    <th className="py-2 text-right font-medium">YoY %</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: '營收 Revenue', curr: revenue, prev: prevRevenue, fmt: formatCurrency },
                    { label: '訂單 Orders', curr: orders, prev: prevOrders, fmt: formatNumber },
                    { label: '平均單價 AOV', curr: aov, prev: prevAov, fmt: formatCurrency },
                    { label: '售出件數 Items', curr: itemsSold, prev: prevItemsSold, fmt: formatNumber },
                    { label: '折扣率 Discount', curr: discountRate, prev: prevDiscountRate, fmt: formatPercent },
                  ].map((row) => {
                    const change = row.prev !== 0 ? pctChange(row.curr, row.prev) : null;
                    return (
                      <tr key={row.label} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <td className="py-2 font-medium">{row.label}</td>
                        <td className="py-2 text-right tabular-nums">{row.fmt(row.curr)}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{row.fmt(row.prev)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {change !== null ? (
                            <span className={change >= 0 ? 'text-emerald-400' : 'text-red-400'}>{formatPctChange(change)}</span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">N/A</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">N/A</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[10px] text-muted-foreground/60 mt-2">* YoY 需要超過60天 Shopify 歷史數據，暫不可用</p>
            </div>
          )}
        </CardContent>
      </Card>

      <ChartCard title="每日營收" subtitle="Revenue by Day" loading={loading}>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={dailyRevenue}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Area type="monotone" dataKey="revenue" stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary} fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="訂單時段分佈" subtitle="Orders by Hour" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hourlyOrders}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="hour" tick={AXIS_STYLE} interval={2} />
              <YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="orders" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="營收來源" subtitle="Revenue by Source" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={sourceData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" nameKey="name" paddingAngle={2}>
                {sourceData.map((_, i) => <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="消費最高客戶 Top 10" subtitle="Top Customers" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={topCustomers} layout="vertical">
              <CartesianGrid {...GRID_STYLE} />
              <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={100} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="total" fill={CHART_COLORS.secondary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="退款/取消率" subtitle="Refund/Cancel Rate" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={refundTrend}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${v.toFixed(0)}%`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => `${v.toFixed(1)}%`} />
              <Line type="monotone" dataKey="rate" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Category Revenue */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="產品分類收入" subtitle="Revenue by Category (Top 10)" loading={loading}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={categoryData.slice(0, 10)} layout="vertical">
              <CartesianGrid {...GRID_STYLE} />
              <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={120} tickFormatter={(v: string) => v.length > 18 ? v.slice(0, 18) + '…' : v} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="revenue" fill={CHART_COLORS.quaternary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <Card className="border-border/40">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium">分類明細 <span className="text-xs font-normal text-muted-foreground">Category Details</span></CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {loading ? <Skeleton className="h-[280px] w-full" /> : (
              <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                <table className="w-full text-xs" data-testid="table-categories">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border/50 text-muted-foreground">
                      <th className="py-2 text-left font-medium">分類 Category</th>
                      <th className="py-2 text-right font-medium">件數 Units</th>
                      <th className="py-2 text-right font-medium">營收 Revenue</th>
                      <th className="py-2 text-right font-medium">% Total</th>
                      <th className="py-2 text-right font-medium">均價 AOV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryData.map((c) => (
                      <tr key={c.name} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <td className="py-2 font-medium">{c.name}</td>
                        <td className="py-2 text-right tabular-nums">{formatNumber(c.units)}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(c.revenue)}</td>
                        <td className="py-2 text-right tabular-nums">{formatPercent(c.pctTotal)}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(c.avgPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Margin Analysis */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">產品毛利分析 <span className="text-xs font-normal text-muted-foreground">Product Margin Analysis (Top 20 by Revenue)</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : marginData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">數據不足</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="table-margin">
                  <thead>
                    <tr className="border-b border-border/50 text-muted-foreground">
                      <th className="py-2 text-left font-medium">產品 Product</th>
                      <th className="py-2 text-left font-medium">SKU</th>
                      <th className="py-2 text-right font-medium">數量 Qty</th>
                      <th className="py-2 text-right font-medium">營收 Revenue</th>
                      <th className="py-2 text-right font-medium">成本/件 Cost</th>
                      <th className="py-2 text-right font-medium">毛利% GM%</th>
                      <th className="py-2 text-right font-medium">總毛利 Total GM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {marginData.map((p, i) => (
                      <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <td className="py-2 max-w-[200px] truncate">{p.title}</td>
                        <td className="py-2 font-mono text-[11px]">{p.sku || '—'}</td>
                        <td className="py-2 text-right tabular-nums">{p.qty}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                        <td className="py-2 text-right tabular-nums">{p.matched ? formatCurrency(p.unitCost) : <span className="text-muted-foreground">N/A</span>}</td>
                        <td className="py-2 text-right tabular-nums">
                          {p.marginPct !== null ? (
                            <span className={p.marginPct >= 40 ? 'text-emerald-400' : p.marginPct >= 20 ? 'text-amber-400' : 'text-red-400'}>
                              {formatPercent(p.marginPct)}
                            </span>
                          ) : <span className="text-muted-foreground">N/A</span>}
                        </td>
                        <td className="py-2 text-right tabular-nums">{p.totalGM !== null ? formatCurrency(p.totalGM) : <span className="text-muted-foreground">N/A</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-2">* BC品項配對，非所有產品可計算</p>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">最近訂單 <span className="text-xs font-normal text-muted-foreground">Recent Orders</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : recentOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">数据不足</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-recent-orders">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">訂單 Order#</th>
                    <th className="py-2 text-left font-medium">日期 Date</th>
                    <th className="py-2 text-left font-medium">客戶 Customer</th>
                    <th className="py-2 text-right font-medium">金額 Total</th>
                    <th className="py-2 text-right font-medium">狀態 Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.map((o: any) => (
                    <tr key={o.id} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 tabular-nums">#{o.order_number}</td>
                      <td className="py-2 text-muted-foreground">{o.created_at?.slice(0, 10)}</td>
                      <td className="py-2">{o.customer_name || '—'}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(parseFloat(o.total_price))}</td>
                      <td className="py-2 text-right">
                        <Badge variant={o.financial_status === 'paid' ? 'default' : 'secondary'} className="text-[10px]">{o.financial_status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
