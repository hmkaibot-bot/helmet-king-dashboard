import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatNumber } from '@/lib/format';
import { Users, UserCheck, UserPlus, Star } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { CHART_COLORS, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';

export default function CustomersPage() {
  const [loading, setLoading] = useState(true);
  const [totalMembers, setTotalMembers] = useState(0);
  const [subscribedData, setSubscribedData] = useState<{ name: string; value: number }[]>([]);
  const [pointsData, setPointsData] = useState<{ name: string; value: number }[]>([]);
  const [tierData, setTierData] = useState<{ name: string; count: number }[]>([]);
  const [newMembers30d, setNewMembers30d] = useState(0);
  const [membersByMonth, setMembersByMonth] = useState<{ month: string; count: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchData() {
      // Fetch all customers
      const { data: customers, count } = await supabase
        .from('marsello_customers')
        .select('loyalty_points, tier_name, subscribed, created_at', { count: 'exact' });

      if (cancelled || !customers) return;

      setTotalMembers(count || customers.length);

      // Subscribed vs unsubscribed
      const subscribed = customers.filter((c: any) => c.subscribed === true || c.subscribed === 'true').length;
      const unsubscribed = customers.length - subscribed;
      setSubscribedData([
        { name: '已訂閱 Subscribed', value: subscribed },
        { name: '未訂閱 Unsubscribed', value: unsubscribed },
      ]);

      // Points > 0 vs 0
      const withPoints = customers.filter((c: any) => (Number(c.loyalty_points) || 0) > 0).length;
      setPointsData([
        { name: '有積分 With Points', value: withPoints },
        { name: '無積分 No Points', value: customers.length - withPoints },
      ]);

      // Tier distribution
      const tierMap: Record<string, number> = {};
      customers.forEach((c: any) => {
        const tier = c.tier_name || 'No Tier';
        tierMap[tier] = (tierMap[tier] || 0) + 1;
      });
      setTierData(
        Object.entries(tierMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
      );

      // New members last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const newCount = customers.filter(
        (c: any) => c.created_at && new Date(c.created_at) >= thirtyDaysAgo
      ).length;
      setNewMembers30d(newCount);

      // Members by join month
      const monthMap: Record<string, number> = {};
      customers.forEach((c: any) => {
        if (c.created_at) {
          const month = c.created_at.substring(0, 7);
          monthMap[month] = (monthMap[month] || 0) + 1;
        }
      });
      setMembersByMonth(
        Object.entries(monthMap)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-12)
          .map(([month, count]) => ({ month: month.substring(2), count }))
      );

      setLoading(false);
    }

    fetchData();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-4 max-w-[1400px]">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard title="總會員" subtitle="Total Members" value={formatNumber(totalMembers)} icon={Users} loading={loading} testId="kpi-members" />
        <KpiCard title="已訂閱" subtitle="Subscribed" value={formatNumber(subscribedData[0]?.value || 0)} icon={UserCheck} loading={loading} testId="kpi-subscribed" />
        <KpiCard title="有積分會員" subtitle="With Points" value={formatNumber(pointsData[0]?.value || 0)} icon={Star} loading={loading} testId="kpi-with-points" />
        <KpiCard title="新會員(30天)" subtitle="New 30d" value={formatNumber(newMembers30d)} icon={UserPlus} loading={loading} testId="kpi-new-members" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Subscribed donut */}
        <ChartCard title="訂閱狀態" subtitle="Subscription" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={subscribedData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                <Cell fill="#10b981" />
                <Cell fill="#6b7280" />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Points donut */}
        <ChartCard title="積分分佈" subtitle="Points Distribution" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={pointsData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                <Cell fill={CHART_COLORS.primary} />
                <Cell fill="#4b5563" />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Tier distribution */}
        <ChartCard title="會員等級" subtitle="Tier Distribution" loading={loading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={tierData}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="name" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]}>
                {tierData.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Members by month */}
        <ChartCard title="每月新會員" subtitle="New Members by Month" loading={loading}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={membersByMonth}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="month" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="count" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ fill: CHART_COLORS.primary, r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
