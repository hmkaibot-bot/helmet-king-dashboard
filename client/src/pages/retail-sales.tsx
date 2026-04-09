import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, ShoppingCart, TrendingUp, Package, Percent } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [ordersData, prevOrdersData, orderLines] = await Promise.all([
          queryWithDateRange('shopify_orders', 'id,order_number,created_at,total_price,subtotal_price,total_discounts,financial_status,cancelled_at,customer_name,customer_email,source_name', 'created_at', bounds),
          queryWithDateRange('shopify_orders', 'id,total_price,subtotal_price,total_discounts,financial_status,cancelled_at', 'created_at', prevBounds),
          queryAll('shopify_order_lines', 'order_id,quantity'),
        ]);

        if (cancelled) return;

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

        // Source - clean up URLs to 'referral'
        const srcMap: Record<string, number> = {};
        valid.forEach((o: any) => {
          let src = o.source_name || 'unknown';
          if (src.startsWith('http')) src = 'referral';
          else if (/^\d+$/.test(src)) src = 'app';
          srcMap[src] = (srcMap[src] || 0) + (parseFloat(o.total_price) || 0);
        });
        setSourceData(Object.entries(srcMap).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })));

        // Top customers - exclude Unknown/empty
        const custMap: Record<string, { name: string; total: number }> = {};
        valid.forEach((o: any) => {
          const name = o.customer_name;
          // Skip null, empty, or 'Unknown' customers
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

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="營收" subtitle="Revenue" value={formatCurrency(revenue)} icon={DollarSign} loading={loading} delta={calcDelta(revenue, prevRevenue)} testId="kpi-revenue" />
        <KpiCard title="訂單" subtitle="Orders" value={formatNumber(orders)} icon={ShoppingCart} loading={loading} delta={calcDelta(orders, prevOrders)} testId="kpi-orders" />
        <KpiCard title="平均單價" subtitle="AOV" value={formatCurrency(aov)} icon={TrendingUp} loading={loading} delta={calcDelta(aov, prevAov)} testId="kpi-aov" />
        <KpiCard title="售出件數" subtitle="Items Sold" value={formatNumber(itemsSold)} icon={Package} loading={loading} delta={calcDelta(itemsSold, prevItemsSold)} testId="kpi-items" />
        <KpiCard title="折扣率" subtitle="Discount Rate" value={formatPercent(discountRate)} icon={Percent} loading={loading} delta={calcDelta(discountRate, prevDiscountRate)} testId="kpi-discount" />
      </div>

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
