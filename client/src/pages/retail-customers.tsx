import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryAll, queryWithDateRange, queryCount } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { Users, UserCheck, UserPlus, Star, Mail, Repeat } from 'lucide-react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // Total members = ALL TIME count (not date-filtered), use head:true for accurate count
        const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString();
        const [totalCount, activeCount, customers, ordersData] = await Promise.all([
          queryCount('marsello_customers'),
          (async () => {
            const { count, error } = await supabase.from('marsello_customers').select('id', { count: 'exact', head: true }).gte('last_seen', ninetyAgo);
            if (error) { console.error('Active count error:', error); return 0; }
            return count || 0;
          })(),
          queryAll('marsello_customers', 'id,email,first_name,last_name,loyalty_points,tier_name,subscribed,last_seen,created_at', undefined, 50000),
          queryAll('shopify_orders', 'customer_id,customer_email', undefined, 50000),
        ]);
        if (cancelled) return;

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
    </div>
  );
}
