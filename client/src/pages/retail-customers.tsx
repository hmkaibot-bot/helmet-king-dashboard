import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryAll, queryWithDateRange, queryCount } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { Users, UserCheck, UserPlus, Star, Mail, Repeat, ShoppingBag } from 'lucide-react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { queryAllPages as queryAllFull } from '@/lib/query-helpers';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { filterByDate } from '@/lib/format';

export default function RetailCustomersPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [totalMembers, setTotalMembers] = useState(0);
  const [activeMembers, setActiveMembers] = useState(0);
  const [newMembers, setNewMembers] = useState(0);
  const [avgPoints, setAvgPoints] = useState(0);
  const [subscribedRate, setSubscribedRate] = useState(0);
  const [repeatRate, setRepeatRate] = useState(0);
  const [monthlyNew, setMonthlyNew] = useState<any[]>([]);
  const [tierData, setTierData] = useState<any[]>([]);
  const [pointsDist, setPointsDist] = useState<any[]>([]);
  const [topByPoints, setTopByPoints] = useState<any[]>([]);
  const [oneTimeBuyers, setOneTimeBuyers] = useState(0);
  const [repeatBuyers, setRepeatBuyers] = useState(0);
  const [freqDist, setFreqDist] = useState<any[]>([]);
  const [repeatDonut, setRepeatDonut] = useState<any[]>([]);
  const [repeatProducts, setRepeatProducts] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // Total members = ALL TIME count (not date-filtered), use head:true for accurate count
        const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString();
        // orders 一次過攞齊所有需要嘅欄位 — 以前 line 51 + line 91 拉咗
        // shopify_orders 兩次 (36k 行 x2);order lines 都一齊併入呢輪 parallel
        const [totalCount, activeCount, customers, fullOrders, allOrderLines] = await Promise.all([
          queryCount('marsello_customers'),
          (async () => {
            const { count, error } = await supabase.from('marsello_customers').select('id', { count: 'exact', head: true }).gte('last_seen', ninetyAgo);
            if (error) { console.error('Active count error:', error); return 0; }
            return count || 0;
          })(),
          queryAllFull('marsello_customers', 'id,email,first_name,last_name,loyalty_points,tier_name,subscribed,last_seen,created_at'),
          queryAllFull('shopify_orders', 'id,customer_id,customer_email,customer_name,financial_status,cancelled_at,total_price'),
          // 以前用 queryInBatches 逐批 .in() 拉 — 全部 order id 都要,等於成張表,
          // 直接分頁拉仲快 (4 個 request + IndexedDB cache)
          queryAllFull('shopify_order_lines', 'order_id,title,vendor,quantity,price'),
        ]);
        if (cancelled) return;
        const ordersData = fullOrders;

        const total = totalCount;
        const active = activeCount;
        const newM = filterByDate(customers, 'created_at', bounds).length;
        const totalPts = customers.reduce((s: number, c: any) => s + (c.loyalty_points || 0), 0);
        const subCount = customers.filter((c: any) => c.subscribed === true).length;

        const custCount: Record<string, number> = {};
        ordersData.forEach((o: any) => { const key = o.customer_id || o.customer_email || ''; if (key) custCount[key] = (custCount[key] || 0) + 1; });
        const uniq = Object.keys(custCount).length;
        const repeats = Object.values(custCount).filter((c) => c > 1).length;

        setTotalMembers(total);
        setActiveMembers(active);
        setNewMembers(newM);
        // Use customers.length for average calc since we have actual data for those
        setAvgPoints(customers.length > 0 ? totalPts / customers.length : 0);
        setSubscribedRate(customers.length > 0 ? (subCount / customers.length) * 100 : 0);
        setRepeatRate(uniq > 0 ? (repeats / uniq) * 100 : 0);

        // Monthly new
        const monthMap: Record<string, number> = {};
        customers.forEach((c: any) => { if (!c.created_at) return; const m = c.created_at.slice(0, 7); monthMap[m] = (monthMap[m] || 0) + 1; });
        setMonthlyNew(Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, count]) => ({ month, count })));

        // Tier
        const tierMap: Record<string, number> = {};
        customers.forEach((c: any) => { const t = c.tier_name || '未分層'; tierMap[t] = (tierMap[t] || 0) + 1; });
        setTierData(Object.entries(tierMap).map(([name, value]) => ({ name, value })));

        // Points dist
        const bands = [{ name: '0', min: 0, max: 0 }, { name: '1-100', min: 1, max: 100 }, { name: '101-500', min: 101, max: 500 }, { name: '500+', min: 501, max: Infinity }];
        setPointsDist(bands.map((b) => ({ name: b.name, count: customers.filter((c: any) => { const p = c.loyalty_points || 0; return p >= b.min && p <= b.max; }).length })));

        setTopByPoints([...customers].sort((a: any, b: any) => (b.loyalty_points || 0) - (a.loyalty_points || 0)).slice(0, 20));

        // Repeat Purchase Analysis
        const validFullOrders = fullOrders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const ordersByCustomer: Record<string, { count: number; total: number }> = {};
        validFullOrders.forEach((o: any) => {
          const key = o.customer_email || o.customer_id || o.customer_name;
          if (!key) return;
          if (!ordersByCustomer[key]) ordersByCustomer[key] = { count: 0, total: 0 };
          ordersByCustomer[key].count++;
          ordersByCustomer[key].total += parseFloat(o.total_price) || 0;
        });
        const one = Object.values(ordersByCustomer).filter(c => c.count === 1).length;
        const rep = Object.values(ordersByCustomer).filter(c => c.count >= 2).length;
        setOneTimeBuyers(one);
        setRepeatBuyers(rep);
        setRepeatDonut([
          { name: '一次購買 1-time', value: one },
          { name: '回頭客 Repeat', value: rep },
        ]);

        // Frequency distribution
        const freq: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 };
        Object.values(ordersByCustomer).forEach((c) => {
          if (c.count === 1) freq['1']++;
          else if (c.count === 2) freq['2']++;
          else if (c.count === 3) freq['3']++;
          else if (c.count === 4) freq['4']++;
          else freq['5+']++;
        });
        setFreqDist(Object.entries(freq).map(([name, count]) => ({ name, count })));

        // What repeat buyers purchase
        const repeatCustomerKeys = new Set(
          Object.entries(ordersByCustomer).filter(([_, v]) => v.count >= 2).map(([k]) => k)
        );
        const repeatOrderIds = new Set(
          validFullOrders.filter((o: any) => {
            const key = o.customer_email || o.customer_id || o.customer_name;
            return repeatCustomerKeys.has(key);
          }).map((o: any) => o.id)
        );
        const repeatLines = allOrderLines.filter((l: any) => repeatOrderIds.has(l.order_id));
        const repProdMap: Record<string, { title: string; vendor: string; qty: number; orders: Set<string>; revenue: number }> = {};
        const totalRepeatRev = repeatLines.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
        repeatLines.forEach((l: any) => {
          const key = (l.title || '') + '|' + (l.vendor || '');
          if (!repProdMap[key]) repProdMap[key] = { title: l.title, vendor: l.vendor || '', qty: 0, orders: new Set(), revenue: 0 };
          repProdMap[key].qty += l.quantity || 0;
          repProdMap[key].orders.add(l.order_id);
          repProdMap[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
        });
        const repeatProductArr = Object.values(repProdMap)
          .map((p) => ({ ...p, orderCount: p.orders.size, pctRevenue: totalRepeatRev > 0 ? (p.revenue / totalRepeatRev) * 100 : 0 }))
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 20);
        setRepeatProducts(repeatProductArr);
      } catch (e) { console.error('Customers error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="總會員" subtitle="Total" value={formatNumber(totalMembers)} icon={Users} loading={loading} testId="kpi-total" />
        <KpiCard title="活躍會員" subtitle="Active 90d" value={formatNumber(activeMembers)} icon={UserCheck} loading={loading} testId="kpi-active" />
        <KpiCard title="新會員" subtitle="New" value={formatNumber(newMembers)} icon={UserPlus} loading={loading} testId="kpi-new" />
        <KpiCard title="平均積分" subtitle="Avg Pts" value={formatNumber(Math.round(avgPoints))} icon={Star} loading={loading} testId="kpi-pts" />
        <KpiCard title="訂閱率" subtitle="Subscribed" value={formatPercent(subscribedRate)} icon={Mail} loading={loading} testId="kpi-sub" />
        <KpiCard title="回購率" subtitle="Repeat" value={formatPercent(repeatRate)} icon={Repeat} loading={loading} testId="kpi-repeat" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="每月新會員" subtitle="New Members by Month" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyNew}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="month" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="會員等級" subtitle="Members by Tier" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={tierData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" nameKey="name" paddingAngle={2}>
                {tierData.map((_, i) => <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="積分分佈" subtitle="Loyalty Points Distribution" loading={loading}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={pointsDist}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="name" tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar dataKey="count" fill={CHART_COLORS.quaternary} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">積分最高 <span className="text-xs font-normal text-muted-foreground">Top 20 by Points</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-top-points">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">姓名 Name</th>
                    <th className="py-2 text-left font-medium">電郵 Email</th>
                    <th className="py-2 text-right font-medium">積分 Points</th>
                    <th className="py-2 text-left font-medium">等級 Tier</th>
                    <th className="py-2 text-left font-medium">最後上線</th>
                  </tr>
                </thead>
                <tbody>
                  {topByPoints.map((c: any) => (
                    <tr key={c.id} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2">{c.first_name} {c.last_name}</td>
                      <td className="py-2 text-muted-foreground">{c.email || '—'}</td>
                      <td className="py-2 text-right tabular-nums font-medium">{formatNumber(c.loyalty_points)}</td>
                      <td className="py-2"><Badge variant="secondary" className="text-[10px]">{c.tier_name || '未分層'}</Badge></td>
                      <td className="py-2 text-muted-foreground">{c.last_seen?.slice(0, 10) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Repeat Purchase Analysis */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="grid grid-cols-2 gap-3 lg:col-span-1">
          <KpiCard title="一次購買" subtitle="1-time" value={formatNumber(oneTimeBuyers)} icon={Users} loading={loading} testId="kpi-onetime" />
          <KpiCard title="回頭客" subtitle="Repeat 2+" value={formatNumber(repeatBuyers)} icon={Repeat} loading={loading} testId="kpi-repeat-buyers" />
        </div>

        <ChartCard title="回頭率分析" subtitle="1-time vs Repeat" loading={loading}>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={repeatDonut} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" nameKey="name" paddingAngle={2}>
                <Cell fill={CHART_COLORS.primary} />
                <Cell fill={CHART_COLORS.tertiary} />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="購買頻率分佈" subtitle="Purchase Frequency" loading={loading}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={freqDist}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="name" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="count" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* What Repeat Buyers Purchase */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">回頭客買什麼 <span className="text-xs font-normal text-muted-foreground">What Repeat Buyers Purchase</span></CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : repeatProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">數據不足</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={repeatProducts.slice(0, 10)} layout="vertical">
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis type="number" tick={AXIS_STYLE} />
                  <YAxis type="category" dataKey="title" tick={AXIS_STYLE} width={140} tickFormatter={(v: string) => v.length > 20 ? v.slice(0, 20) + '…' : v} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Bar dataKey="qty" name="數量 Qty" fill={CHART_COLORS.tertiary} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="table-repeat-products">
                  <thead>
                    <tr className="border-b border-border/50 text-muted-foreground">
                      <th className="py-2 text-left font-medium">產品 Product</th>
                      <th className="py-2 text-left font-medium">品牌</th>
                      <th className="py-2 text-right font-medium">數量</th>
                      <th className="py-2 text-right font-medium">訂單</th>
                      <th className="py-2 text-right font-medium">%營收</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repeatProducts.map((p, i) => (
                      <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <td className="py-2 max-w-[160px] truncate">{p.title}</td>
                        <td className="py-2 text-muted-foreground">{p.vendor || '—'}</td>
                        <td className="py-2 text-right tabular-nums font-medium">{p.qty}</td>
                        <td className="py-2 text-right tabular-nums">{p.orderCount}</td>
                        <td className="py-2 text-right tabular-nums">{formatPercent(p.pctRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
