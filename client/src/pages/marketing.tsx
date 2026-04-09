import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useDateRange } from '@/lib/date-context';
import { getDateFrom, formatCurrency, formatNumber, formatDecimal } from '@/lib/format';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { DollarSign, Eye, MousePointerClick, Target } from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';

interface AdRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  cpm: number;
  cpc: number;
}

export default function MarketingPage() {
  const { dateRange } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [ads, setAds] = useState<AdRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchData() {
      let query = supabase
        .from('meta_ad_insights')
        .select('date, spend, impressions, clicks, reach, cpm, cpc');

      const dateFrom = getDateFrom(dateRange);
      if (dateFrom) {
        query = query.gte('date', dateFrom.substring(0, 10));
      }

      const { data } = await query;
      if (!cancelled && data) {
        setAds(data as AdRow[]);
      }
      if (!cancelled) setLoading(false);
    }

    fetchData();
    return () => { cancelled = true; };
  }, [dateRange]);

  // KPIs
  const totalSpend = ads.reduce((s, a) => s + (Number(a.spend) || 0), 0);
  const totalImpressions = ads.reduce((s, a) => s + (Number(a.impressions) || 0), 0);
  const totalClicks = ads.reduce((s, a) => s + (Number(a.clicks) || 0), 0);
  const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

  // Daily data sorted
  const dailyData = [...ads]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => ({
      date: a.date?.substring(5) || '',
      spend: Math.round(Number(a.spend) || 0),
      impressions: Number(a.impressions) || 0,
      clicks: Number(a.clicks) || 0,
      ctr: (Number(a.impressions) || 0) > 0
        ? ((Number(a.clicks) || 0) / (Number(a.impressions) || 1)) * 100
        : 0,
    }));

  return (
    <div className="space-y-4 max-w-[1400px]">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard title="廣告支出" subtitle="Ad Spend" value={formatCurrency(totalSpend)} icon={DollarSign} loading={loading} testId="kpi-spend" />
        <KpiCard title="曝光次數" subtitle="Impressions" value={formatNumber(totalImpressions)} icon={Eye} loading={loading} testId="kpi-impressions" />
        <KpiCard title="點擊次數" subtitle="Clicks" value={formatNumber(totalClicks)} icon={MousePointerClick} loading={loading} testId="kpi-clicks" />
        <KpiCard title="平均CPC" subtitle="Avg CPC" value={`HK$${formatDecimal(avgCpc)}`} icon={Target} loading={loading} testId="kpi-cpc" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Spend by day */}
        <ChartCard title="每日廣告支出" subtitle="Daily Ad Spend (HKD)" loading={loading}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={dailyData}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`HK$${v.toLocaleString()}`, '支出']} />
              <Line type="monotone" dataKey="spend" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Impressions vs Clicks */}
        <ChartCard title="曝光 vs 點擊" subtitle="Impressions vs Clicks" loading={loading}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={dailyData}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis yAxisId="left" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              <Line yAxisId="left" type="monotone" dataKey="impressions" name="曝光" stroke={CHART_COLORS.secondary} strokeWidth={1.5} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="clicks" name="點擊" stroke={CHART_COLORS.primary} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* CTR trend */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard title="點擊率趨勢" subtitle="CTR Trend (%)" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={dailyData}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}%`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`${v.toFixed(2)}%`, 'CTR']} />
              <defs>
                <linearGradient id="ctrGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_COLORS.tertiary} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={CHART_COLORS.tertiary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="ctr" stroke={CHART_COLORS.tertiary} strokeWidth={2} fill="url(#ctrGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
