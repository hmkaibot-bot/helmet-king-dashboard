import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, Eye, MousePointer, BarChart3, Percent, TrendingUp } from 'lucide-react';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function MarketingPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [adInsights, setAdInsights] = useState<any[]>([]);
  const [shopifyRevByDay, setShopifyRevByDay] = useState<Record<string, number>>({});
  const [marselloCustomers, setMarselloCustomers] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [ads, orders, marsello] = await Promise.all([
          queryWithDateRange('meta_ad_insights', 'date,spend,impressions,clicks,reach,cpm,cpc,ctr', 'date', bounds),
          queryWithDateRange('shopify_orders', 'created_at,total_price,financial_status,cancelled_at', 'created_at', bounds),
          queryAll('marsello_customers', 'id,created_at,last_seen,tier_name,subscribed'),
        ]);
        if (cancelled) return;

        const validOrders = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const dayRevMap: Record<string, number> = {};
        validOrders.forEach((o: any) => { const d = o.created_at?.slice(0, 10); if (d) dayRevMap[d] = (dayRevMap[d] || 0) + (parseFloat(o.total_price) || 0); });

        setAdInsights(ads);
        setShopifyRevByDay(dayRevMap);
        setMarselloCustomers(marsello);
      } catch (e) { console.error('Marketing error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  const totalSpend = adInsights.reduce((s, a) => s + (parseFloat(a.spend) || 0), 0);
  const totalImpressions = adInsights.reduce((s, a) => s + (parseInt(a.impressions) || 0), 0);
  const totalClicks = adInsights.reduce((s, a) => s + (parseInt(a.clicks) || 0), 0);
  const avgCPC = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const totalShopifyRev = Object.values(shopifyRevByDay).reduce((s, v) => s + v, 0);
  const roas = totalSpend > 0 ? totalShopifyRev / totalSpend : 0;

  const spendVsRevenue = useMemo(() => {
    const adMap: Record<string, number> = {};
    adInsights.forEach((a) => { adMap[a.date] = (adMap[a.date] || 0) + (parseFloat(a.spend) || 0); });
    const allDays = new Set([...adInsights.map((a) => a.date), ...Object.keys(shopifyRevByDay)]);
    return Array.from(allDays).sort().map((d) => ({ date: d.slice(5), spend: adMap[d] || 0, revenue: shopifyRevByDay[d] || 0 }));
  }, [adInsights, shopifyRevByDay]);

  const ctrTrend = adInsights.sort((a, b) => a.date.localeCompare(b.date)).map((a) => ({ date: a.date.slice(5), ctr: parseFloat(a.ctr) || 0 }));
  const costTrend = adInsights.sort((a, b) => a.date.localeCompare(b.date)).map((a) => ({ date: a.date.slice(5), cpm: parseFloat(a.cpm) || 0, cpc: parseFloat(a.cpc) || 0 }));
  const impClickTrend = adInsights.sort((a, b) => a.date.localeCompare(b.date)).map((a) => ({ date: a.date.slice(5), impressions: parseInt(a.impressions) || 0, clicks: parseInt(a.clicks) || 0 }));

  const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const activeMembers = marselloCustomers.filter((c) => c.last_seen && c.last_seen >= ninetyAgo).length;
  const inactiveMembers = marselloCustomers.length - activeMembers;

  const memberGrowth = useMemo(() => {
    const monthMap: Record<string, number> = {};
    marselloCustomers.forEach((c) => { if (!c.created_at) return; const m = c.created_at.slice(0, 7); monthMap[m] = (monthMap[m] || 0) + 1; });
    let cum = 0;
    return Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => { cum += count; return { month, total: cum }; });
  }, [marselloCustomers]);

  const tierDist = useMemo(() => {
    const map: Record<string, number> = {};
    marselloCustomers.forEach((c) => { const t = c.tier_name || '未分層'; map[t] = (map[t] || 0) + 1; });
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [marselloCustomers]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="Meta 支出" subtitle="Spend" value={formatCurrency(totalSpend)} icon={DollarSign} loading={loading} testId="kpi-spend" />
        <KpiCard title="曝光量" subtitle="Impressions" value={formatNumber(totalImpressions)} icon={Eye} loading={loading} testId="kpi-imp" />
        <KpiCard title="點擊" subtitle="Clicks" value={formatNumber(totalClicks)} icon={MousePointer} loading={loading} testId="kpi-clicks" />
        <KpiCard title="CPC" subtitle="Avg" value={`HK$${avgCPC.toFixed(2)}`} icon={BarChart3} loading={loading} testId="kpi-cpc" />
        <KpiCard title="CTR" subtitle="Rate" value={formatPercent(avgCTR)} icon={Percent} loading={loading} testId="kpi-ctr" />
        <KpiCard title="廣告佔比率" subtitle="Rev/Spend" value={roas > 100 ? `>​99x` : `${roas.toFixed(1)}x`} icon={TrendingUp} loading={loading} testId="kpi-roas" />
      </div>

      <ChartCard title="支出 vs 營收" subtitle="Daily Spend vs Revenue" note="* 非歸因 ROAS，為期間總收入與 Meta 廣告費之比 (Not attributed ROAS — ratio of total Shopify revenue to Meta spend)">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={spendVsRevenue}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, n: string) => n === 'spend' ? `HK$${v.toFixed(0)}` : formatCurrency(v)} />
            <Line yAxisId="left" type="monotone" dataKey="revenue" name="Revenue" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="spend" name="Ad Spend" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="CTR 趨勢" subtitle="Click-Through Rate" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={ctrTrend}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${v.toFixed(1)}%`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => `${v.toFixed(2)}%`} />
              <Area type="monotone" dataKey="ctr" stroke={CHART_COLORS.tertiary} fill={CHART_COLORS.tertiary} fillOpacity={0.15} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="CPM / CPC" subtitle="Cost Trends" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={costTrend}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
              <YAxis yAxisId="left" tick={AXIS_STYLE} /><YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => `HK$${v.toFixed(2)}`} />
              <Line yAxisId="left" type="monotone" dataKey="cpm" name="CPM" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="cpc" name="CPC" stroke={CHART_COLORS.quaternary} strokeWidth={2} dot={false} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="曝光 vs 點擊" subtitle="Impressions vs Clicks" loading={loading}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={impClickTrend}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => formatNumber(v)} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatNumber(v)} />
            <Area yAxisId="left" type="monotone" dataKey="impressions" name="Impressions" stroke={CHART_COLORS.secondary} fill={CHART_COLORS.secondary} fillOpacity={0.1} strokeWidth={2} />
            <Area yAxisId="right" type="monotone" dataKey="clicks" name="Clicks" stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary} fillOpacity={0.1} strokeWidth={2} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <h2 className="text-sm font-semibold pt-2">Marsello 會員 <span className="text-xs font-normal text-muted-foreground">Analytics</span></h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="會員增長" subtitle="Cumulative" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={memberGrowth}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} /><Line type="monotone" dataKey="total" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="活躍 vs 非活躍" subtitle="Active Split" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={[{ name: '活躍', value: activeMembers }, { name: '非活躍', value: inactiveMembers }]} cx="50%" cy="50%" innerRadius={50} outerRadius={75} dataKey="value" paddingAngle={2}>
                <Cell fill={CHART_COLORS.tertiary} /><Cell fill={CHART_COLORS.fifth} />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} /><Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="等級分佈" subtitle="Tier" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tierDist}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="name" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} /><Bar dataKey="value" fill={CHART_COLORS.quaternary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
