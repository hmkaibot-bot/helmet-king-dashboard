import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { DollarSign, ShoppingCart, TrendingUp, Calendar, Trophy, Package } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

type ViewMode = 'yesterday' | 'this_week' | 'last_week';

function getHKDate(d: Date): string {
  // Get HKT date string YYYY-MM-DD
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const hkt = new Date(utc + 8 * 3600000);
  return hkt.toISOString().slice(0, 10);
}

function getHKNow(): Date {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

function getYesterday(): string {
  const hkt = getHKNow();
  hkt.setDate(hkt.getDate() - 1);
  return hkt.toISOString().slice(0, 10);
}

function getSameDayLastWeek(): string {
  const hkt = getHKNow();
  hkt.setDate(hkt.getDate() - 8); // yesterday minus 7
  return hkt.toISOString().slice(0, 10);
}

function getThisWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const day = hkt.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0
  const monday = new Date(hkt);
  monday.setDate(hkt.getDate() - diff);
  return { from: monday.toISOString().slice(0, 10), to: getHKDate(new Date()) };
}

function getLastWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const day = hkt.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(hkt);
  thisMonday.setDate(hkt.getDate() - diff);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  const lastMonday = new Date(lastSunday);
  lastMonday.setDate(lastSunday.getDate() - 6);
  return { from: lastMonday.toISOString().slice(0, 10), to: lastSunday.toISOString().slice(0, 10) };
}

function toHKTimeString(isoStr: string): string {
  const d = new Date(isoStr);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const hkt = new Date(utc + 8 * 3600000);
  return `${String(hkt.getHours()).padStart(2, '0')}:${String(hkt.getMinutes()).padStart(2, '0')}`;
}

function toHKDateString(isoStr: string): string {
  const d = new Date(isoStr);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const hkt = new Date(utc + 8 * 3600000);
  return hkt.toISOString().slice(0, 10);
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function DailyWeeklyPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('yesterday');
  const [loading, setLoading] = useState(true);
  const [allOrders, setAllOrders] = useState<any[]>([]);
  const [allOrderLines, setAllOrderLines] = useState<any[]>([]);

  // Fetch wide enough data range to support all views
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // We need data going back ~2 weeks for comparisons
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 16);
        const fromDate = twoWeeksAgo.toISOString().slice(0, 10);

        const [orders, orderLines] = await Promise.all([
          (async () => {
            const { data, error } = await supabase
              .from('shopify_orders')
              .select('id,order_number,created_at,total_price,financial_status,cancelled_at,customer_name,customer_id,discount_codes,source_name')
              .gte('created_at', fromDate)
              .limit(5000);
            if (error) { console.error('Orders error:', error); return []; }
            return data || [];
          })(),
          queryAll('shopify_order_lines', 'order_id,product_id,title,sku,vendor,quantity,price,product_type', undefined, 50000),
        ]);
        if (cancelled) return;
        const valid = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        setAllOrders(valid);
        setAllOrderLines(orderLines);
      } catch (e) {
        console.error('Daily/Weekly load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Filter orders for a specific HKT date range
  const filterOrdersByHKDate = (orders: any[], from: string, to: string) => {
    return orders.filter((o: any) => {
      const d = toHKDateString(o.created_at);
      return d >= from && d <= to;
    });
  };

  const yesterday = getYesterday();
  const sameDayLastWeek = getSameDayLastWeek();
  const thisWeek = getThisWeekBounds();
  const lastWeek = getLastWeekBounds();

  // YESTERDAY view data
  const yesterdayOrders = useMemo(() => filterOrdersByHKDate(allOrders, yesterday, yesterday), [allOrders, yesterday]);
  const sameDayLWOrders = useMemo(() => filterOrdersByHKDate(allOrders, sameDayLastWeek, sameDayLastWeek), [allOrders, sameDayLastWeek]);

  const yRevenue = yesterdayOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
  const yOrders = yesterdayOrders.length;
  const yAov = yOrders > 0 ? yRevenue / yOrders : 0;

  const lwRevenue = sameDayLWOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
  const lwOrders = sameDayLWOrders.length;
  const lwAov = lwOrders > 0 ? lwRevenue / lwOrders : 0;

  const calcDelta = (curr: number, prev: number) => prev === 0 ? null : ((curr - prev) / prev) * 100;

  // Yesterday's products
  const yesterdayProducts = useMemo(() => {
    const orderIds = new Set(yesterdayOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => orderIds.has(l.order_id));
    const map: Record<string, { title: string; sku: string; vendor: string; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => {
      const key = l.product_id || l.title;
      if (!map[key]) map[key] = { title: l.title, sku: l.sku || '', vendor: l.vendor || '', qty: 0, revenue: 0 };
      map[key].qty += l.quantity || 0;
      map[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.values(map).sort((a, b) => b.qty - a.qty).slice(0, 30);
  }, [yesterdayOrders, allOrderLines]);

  // Yesterday's orders list
  const yesterdayOrderList = useMemo(() => {
    return [...yesterdayOrders]
      .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20)
      .map((o: any) => {
        const orderIds = new Set([o.id]);
        const lines = allOrderLines.filter((l: any) => orderIds.has(l.order_id));
        const itemCount = lines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
        return { ...o, itemCount, time: toHKTimeString(o.created_at) };
      });
  }, [yesterdayOrders, allOrderLines]);

  // THIS WEEK / LAST WEEK data
  const weekOrders = useMemo(() => {
    const b = viewMode === 'last_week' ? lastWeek : thisWeek;
    return filterOrdersByHKDate(allOrders, b.from, b.to);
  }, [allOrders, viewMode, thisWeek, lastWeek]);

  const prevWeekOrders = useMemo(() => {
    if (viewMode === 'last_week') {
      // Compare with week before last
      const d = new Date(lastWeek.from);
      d.setDate(d.getDate() - 7);
      const from = d.toISOString().slice(0, 10);
      const d2 = new Date(lastWeek.to);
      d2.setDate(d2.getDate() - 7);
      const to = d2.toISOString().slice(0, 10);
      return filterOrdersByHKDate(allOrders, from, to);
    }
    return filterOrdersByHKDate(allOrders, lastWeek.from, lastWeek.to);
  }, [allOrders, viewMode, lastWeek, thisWeek]);

  const wRevenue = weekOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
  const wOrders = weekOrders.length;
  const pwRevenue = prevWeekOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
  const pwOrders = prevWeekOrders.length;

  // Best day this week
  const bestDay = useMemo(() => {
    const dayMap: Record<string, number> = {};
    weekOrders.forEach((o: any) => {
      const d = toHKDateString(o.created_at);
      dayMap[d] = (dayMap[d] || 0) + (parseFloat(o.total_price) || 0);
    });
    let best = { date: '', revenue: 0 };
    Object.entries(dayMap).forEach(([date, rev]) => {
      if (rev > best.revenue) best = { date, revenue: rev };
    });
    return best;
  }, [weekOrders]);

  // Best product this week
  const bestProduct = useMemo(() => {
    const orderIds = new Set(weekOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => orderIds.has(l.order_id));
    const map: Record<string, { title: string; qty: number }> = {};
    lines.forEach((l: any) => {
      const key = l.title || l.product_id;
      if (!map[key]) map[key] = { title: l.title, qty: 0 };
      map[key].qty += l.quantity || 0;
    });
    let best = { title: '—', qty: 0 };
    Object.values(map).forEach((p) => { if (p.qty > best.qty) best = p; });
    return best;
  }, [weekOrders, allOrderLines]);

  // Weekly revenue bar chart (Mon-Sun)
  const weeklyBarData = useMemo(() => {
    const b = viewMode === 'last_week' ? lastWeek : thisWeek;
    const start = new Date(b.from + 'T00:00:00');
    const result: { day: string; revenue: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const dayOrders = filterOrdersByHKDate(allOrders, dateStr, dateStr);
      const rev = dayOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
      result.push({ day: DAY_NAMES[i], revenue: rev });
    }
    return result;
  }, [allOrders, viewMode, thisWeek, lastWeek]);

  // Top 10 products this week
  const weekTopProducts = useMemo(() => {
    const orderIds = new Set(weekOrders.map((o: any) => o.id));
    const lines = allOrderLines.filter((l: any) => orderIds.has(l.order_id));
    const map: Record<string, { title: string; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => {
      const key = l.title || l.product_id;
      if (!map[key]) map[key] = { title: l.title, qty: 0, revenue: 0 };
      map[key].qty += l.quantity || 0;
      map[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.values(map).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [weekOrders, allOrderLines]);

  const isWeekView = viewMode === 'this_week' || viewMode === 'last_week';

  return (
    <div className="space-y-4">
      {/* View mode toggle */}
      <div className="flex items-center gap-2">
        {(['yesterday', 'this_week', 'last_week'] as ViewMode[]).map((mode) => (
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
          {viewMode === 'yesterday' ? yesterday : isWeekView ? `${viewMode === 'last_week' ? lastWeek.from : thisWeek.from} → ${viewMode === 'last_week' ? lastWeek.to : thisWeek.to}` : ''}
        </span>
      </div>

      {/* YESTERDAY VIEW */}
      {viewMode === 'yesterday' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="昨日營收" subtitle="Revenue" value={formatCurrency(yRevenue)} icon={DollarSign} loading={loading} delta={calcDelta(yRevenue, lwRevenue)} testId="kpi-y-rev" />
            <KpiCard title="昨日訂單" subtitle="Orders" value={formatNumber(yOrders)} icon={ShoppingCart} loading={loading} delta={calcDelta(yOrders, lwOrders)} testId="kpi-y-orders" />
            <KpiCard title="昨日均價" subtitle="AOV" value={formatCurrency(yAov)} icon={TrendingUp} loading={loading} delta={calcDelta(yAov, lwAov)} testId="kpi-y-aov" />
            <KpiCard title="上週同日" subtitle="Same Day LW" value={formatCurrency(lwRevenue)} icon={Calendar} loading={loading} testId="kpi-y-lw" />
          </div>

          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">昨日產品 <span className="text-xs font-normal text-muted-foreground">Yesterday's Products (by qty)</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[300px] w-full" /> : yesterdayProducts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">昨日無銷售數據</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-yesterday-products">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium w-8">#</th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-left font-medium">品牌 Vendor</th>
                        <th className="py-2 text-right font-medium">數量 Qty</th>
                        <th className="py-2 text-right font-medium">營收 Revenue</th>
                        <th className="py-2 text-right font-medium">均價 Avg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yesterdayProducts.map((p, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2 text-muted-foreground">{i + 1}</td>
                          <td className="py-2 max-w-[220px] truncate">{p.title}</td>
                          <td className="py-2 font-mono text-[11px]">{p.sku || '—'}</td>
                          <td className="py-2 text-muted-foreground">{p.vendor || '—'}</td>
                          <td className="py-2 text-right tabular-nums font-medium">{p.qty}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.qty > 0 ? p.revenue / p.qty : 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">昨日訂單 <span className="text-xs font-normal text-muted-foreground">Yesterday's Orders (last 20)</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[300px] w-full" /> : yesterdayOrderList.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">昨日無訂單</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-yesterday-orders">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">訂單 Order#</th>
                        <th className="py-2 text-left font-medium">時間 Time</th>
                        <th className="py-2 text-left font-medium">客戶 Customer</th>
                        <th className="py-2 text-right font-medium">件數 Items</th>
                        <th className="py-2 text-right font-medium">金額 Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yesterdayOrderList.map((o: any) => (
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

      {/* WEEK VIEW (This Week / Last Week) */}
      {isWeekView && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="週營收" subtitle="Week Revenue" value={formatCurrency(wRevenue)} icon={DollarSign} loading={loading} delta={calcDelta(wRevenue, pwRevenue)} testId="kpi-w-rev" />
            <KpiCard title="週訂單" subtitle="Week Orders" value={formatNumber(wOrders)} icon={ShoppingCart} loading={loading} delta={calcDelta(wOrders, pwOrders)} testId="kpi-w-orders" />
            <KpiCard title="最佳日" subtitle="Best Day" value={bestDay.date ? `${bestDay.date.slice(5)} ${formatCurrency(bestDay.revenue)}` : '—'} icon={Trophy} loading={loading} testId="kpi-w-bestday" />
            <KpiCard title="最暢銷" subtitle="Best Product" value={bestProduct.title.length > 20 ? bestProduct.title.slice(0, 20) + '…' : bestProduct.title} icon={Package} loading={loading} testId="kpi-w-bestprod" />
          </div>

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

          <ChartCard title="本週暢銷 Top 10" subtitle="Top Products This Week" loading={loading}>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={weekTopProducts} layout="vertical">
                <CartesianGrid {...GRID_STYLE} />
                <XAxis type="number" tick={AXIS_STYLE} />
                <YAxis type="category" dataKey="title" tick={AXIS_STYLE} width={160} tickFormatter={(v: string) => v.length > 22 ? v.slice(0, 22) + '…' : v} />
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
