import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, Eye, MousePointer, BarChart3, Percent, TrendingUp, Target, Award, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

/* ── Constants ── */
const AOV = 1248; // HKD average order value
const PAGE_SIZE = 20;

/* ── Rating logic ── */
function getRating(c: any) {
  if (c.purchases_90d >= 20) return { label: '🔥 極佳', color: 'text-green-400', score: 5 };
  if (c.purchases_90d >= 5 || c.ctr_90d >= 8) return { label: '✅ 優秀', color: 'text-green-400', score: 4 };
  if (c.purchases_90d > 0 && c.ctr_90d >= 4) return { label: '👍 良好', color: 'text-blue-400', score: 3 };
  if (c.purchases_90d > 0 || c.ctr_90d >= 4) return { label: '📊 一般', color: 'text-yellow-400', score: 2 };
  if (c.ctr_90d >= 2 || c.spend_90d < 300) return { label: '📉 偏低', color: 'text-orange-400', score: 1 };
  return { label: '❌ 差', color: 'text-red-400', score: 0 };
}

function getRecommendation(c: any) {
  if (c.purchases_90d >= 20) return '重複投放';
  if (c.purchases_90d >= 5) return '可再做';
  if (c.purchases_90d > 0 && c.spend_90d < 200) return '增加預算測試';
  if (c.spend_90d > 500 && c.purchases_90d === 0 && c.ctr_90d < 3) return '不建議再做';
  if (c.spend_90d > 300 && c.purchases_90d === 0) return '審查受眾';
  return '持續觀察';
}

function computeCampaignFields(c: any) {
  const spend = parseFloat(c.spend_90d) || 0;
  const purchases = parseInt(c.purchases_90d) || 0;
  const ctr = parseFloat(c.ctr_90d) || 0;
  const impressions = parseInt(c.impressions_90d) || 0;
  const cpc = parseFloat(c.cpc_90d) || 0;
  const estimatedRev = purchases * AOV;
  const roas = spend > 0 && purchases > 0 ? estimatedRev / spend : 0;
  const cpa = purchases > 0 ? spend / purchases : null;
  const rating = getRating({ ...c, spend_90d: spend, purchases_90d: purchases, ctr_90d: ctr });
  const recommendation = getRecommendation({ ...c, spend_90d: spend, purchases_90d: purchases, ctr_90d: ctr });
  return { ...c, spend, purchases, ctr, impressions, cpc, estimatedRev, roas, cpa, rating, recommendation };
}

type SortBy = 'purchases' | 'ctr' | 'spend' | 'roas' | 'cpa';
type StatusFilter = 'all' | 'ACTIVE' | 'PAUSED' | 'ended';
type PerfFilter = 'all' | 'has_purchases' | 'no_purchases';

export default function MarketingPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [adInsights, setAdInsights] = useState<any[]>([]);
  const [shopifyRevByDay, setShopifyRevByDay] = useState<Record<string, number>>({});
  const [marselloCustomers, setMarselloCustomers] = useState<any[]>([]);

  // Campaign Performance state
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortBy>('purchases');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [perfFilter, setPerfFilter] = useState<PerfFilter>('all');
  const [page, setPage] = useState(0);

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

  // Load meta_campaigns
  useEffect(() => {
    let cancelled = false;
    async function loadCampaigns() {
      setCampaignsLoading(true);
      try {
        const { data, error } = await supabase
          .from('meta_campaigns')
          .select('*')
          .gt('spend_90d', 0)
          .order('spend_90d', { ascending: false })
          .limit(2000);
        if (cancelled) return;
        if (error) { console.error('Campaigns error:', error); setCampaigns([]); return; }
        setCampaigns((data || []).map(computeCampaignFields));
      } catch (e) { console.error('Campaigns fetch error:', e); } finally { if (!cancelled) setCampaignsLoading(false); }
    }
    loadCampaigns();
    return () => { cancelled = true; };
  }, []);

  /* ── Existing KPIs ── */
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

  /* ── Campaign Performance computations ── */
  const filteredCampaigns = useMemo(() => {
    let result = [...campaigns];

    // Status filter
    if (statusFilter === 'ACTIVE') result = result.filter(c => c.status === 'ACTIVE');
    else if (statusFilter === 'PAUSED') result = result.filter(c => c.status === 'PAUSED');
    else if (statusFilter === 'ended') result = result.filter(c => c.status !== 'ACTIVE' && c.status !== 'PAUSED');

    // Performance filter
    if (perfFilter === 'has_purchases') result = result.filter(c => c.purchases > 0);
    else if (perfFilter === 'no_purchases') result = result.filter(c => c.purchases === 0);

    // Sort
    switch (sortBy) {
      case 'purchases': result.sort((a, b) => b.purchases - a.purchases); break;
      case 'ctr': result.sort((a, b) => b.ctr - a.ctr); break;
      case 'spend': result.sort((a, b) => b.spend - a.spend); break;
      case 'roas': result.sort((a, b) => b.roas - a.roas); break;
      case 'cpa': result.sort((a, b) => {
        if (a.cpa === null && b.cpa === null) return 0;
        if (a.cpa === null) return 1;
        if (b.cpa === null) return -1;
        return a.cpa - b.cpa; // lower is better
      }); break;
    }
    return result;
  }, [campaigns, statusFilter, perfFilter, sortBy]);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [statusFilter, perfFilter, sortBy]);

  const totalPages = Math.ceil(filteredCampaigns.length / PAGE_SIZE);
  const paginatedCampaigns = filteredCampaigns.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  /* ── Campaign Summary KPIs ── */
  const campSummary = useMemo(() => {
    const withSpend = campaigns.length;
    const withPurchases = campaigns.filter(c => c.purchases > 0).length;
    const totalPurchases = campaigns.reduce((s, c) => s + c.purchases, 0);
    const totalAdSpend = campaigns.reduce((s, c) => s + c.spend, 0);
    const purchaseCampaigns = campaigns.filter(c => c.purchases > 0);
    const bestRoas = purchaseCampaigns.length > 0
      ? purchaseCampaigns.reduce((best, c) => c.roas > best.roas ? c : best, purchaseCampaigns[0])
      : null;
    const avgCpa = purchaseCampaigns.length > 0
      ? purchaseCampaigns.reduce((s, c) => s + (c.cpa || 0), 0) / purchaseCampaigns.length
      : 0;
    return { withSpend, withPurchases, totalPurchases, totalAdSpend, bestRoas, avgCpa };
  }, [campaigns]);

  /* ── Section 2: ROAS & Ad Efficiency ── */
  const roasSection = useMemo(() => {
    const purchaseCampaigns = campaigns.filter(c => c.purchases > 0);
    const totalPurchases = purchaseCampaigns.reduce((s, c) => s + c.purchases, 0);
    const totalSpendPurch = purchaseCampaigns.reduce((s, c) => s + c.spend, 0);
    const overallRoas = totalSpendPurch > 0 ? (totalPurchases * AOV) / totalSpendPurch : 0;
    const targetRoas = 8;
    const roasProgress = Math.min((overallRoas / targetRoas) * 100, 100);

    const bestCampaign = purchaseCampaigns.length > 0
      ? purchaseCampaigns.reduce((best, c) => c.roas > best.roas ? c : best, purchaseCampaigns[0])
      : null;

    const zeroPurchSpenders = campaigns.filter(c => c.purchases === 0).sort((a, b) => b.spend - a.spend);
    const worstSpender = zeroPurchSpenders.length > 0 ? zeroPurchSpenders[0] : null;

    // Top 10 by purchases for bar chart
    const top10 = [...purchaseCampaigns].sort((a, b) => b.purchases - a.purchases).slice(0, 10).map(c => ({
      name: c.campaign_name?.length > 25 ? c.campaign_name.slice(0, 25) + '…' : (c.campaign_name || 'Unknown'),
      purchases: c.purchases,
      fill: c.rating.score >= 4 ? CHART_COLORS.tertiary : c.rating.score >= 3 ? CHART_COLORS.secondary : CHART_COLORS.primary,
    }));

    // Top 15 spend vs purchases comparison
    const top15 = [...purchaseCampaigns].sort((a, b) => b.purchases - a.purchases).slice(0, 15).map(c => ({
      name: c.campaign_name?.length > 20 ? c.campaign_name.slice(0, 20) + '…' : (c.campaign_name || 'Unknown'),
      spend: Math.round(c.spend),
      purchasesScaled: c.purchases * 100,
      purchases: c.purchases,
    }));

    // Should redo list
    const shouldRedo = purchaseCampaigns.filter(c => c.purchases >= 5).sort((a, b) => b.purchases - a.purchases);

    // Avoid list
    const avoid = campaigns.filter(c => c.spend > 500 && c.purchases === 0 && c.ctr < 3).sort((a, b) => b.spend - a.spend);

    return { overallRoas, targetRoas, roasProgress, bestCampaign, worstSpender, top10, top15, shouldRedo, avoid };
  }, [campaigns]);

  /* ── Status color helper ── */
  function statusColor(status: string) {
    if (status === 'ACTIVE') return 'text-green-400';
    if (status === 'PAUSED') return 'text-yellow-400';
    return 'text-gray-500';
  }

  function ctrColor(ctr: number, spend: number) {
    if (ctr >= 8) return 'text-green-400';
    if (ctr >= 4) return 'text-yellow-400';
    if (spend > 300) return 'text-red-400';
    return '';
  }

  return (
    <div className="space-y-4">
      {/* ── Existing Meta KPIs ── */}
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

      {/* ── Marsello Section (existing) ── */}
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

      {/* ═══════════════════════════════════════════════════════════════
           Section 1: 📊 廣告活動表現 Campaign Performance
         ═══════════════════════════════════════════════════════════════ */}
      <h2 className="text-sm font-semibold pt-4" data-testid="section-campaign-performance">
        📊 廣告活動表現 <span className="text-xs font-normal text-muted-foreground">Campaign Performance</span>
      </h2>

      {/* Summary KPI cards */}
      {!campaignsLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard title="有花費活動" subtitle="With Spend" value={String(campSummary.withSpend)} icon={BarChart3} testId="kpi-camp-total" />
          <KpiCard title="有購買活動" subtitle="With Purchases" value={String(campSummary.withPurchases)} icon={Target} testId="kpi-camp-purchases" />
          <KpiCard title="總購買數" subtitle="Total Purchases" value={String(campSummary.totalPurchases)} icon={TrendingUp} testId="kpi-camp-total-purchases" />
          <KpiCard title="最佳 ROAS" subtitle="Best Campaign" value={campSummary.bestRoas ? `${campSummary.bestRoas.roas.toFixed(1)}x` : '-'} icon={Award} testId="kpi-camp-best-roas" />
          <KpiCard title="平均 CPA" subtitle="Avg (有購買)" value={campSummary.avgCpa > 0 ? `HK$${campSummary.avgCpa.toFixed(0)}` : '-'} icon={DollarSign} testId="kpi-camp-avg-cpa" />
          <KpiCard title="總廣告費" subtitle="Total Ad Spend" value={formatCurrency(campSummary.totalAdSpend)} icon={DollarSign} testId="kpi-camp-total-spend" />
        </div>
      )}

      {/* Sort + Filter controls */}
      <Card className="border-border/40">
        <CardContent className="p-4 space-y-3">
          {/* Sort buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">排序:</span>
            {([
              { key: 'purchases', label: '按購買數 Purchases ↓' },
              { key: 'ctr', label: '按 CTR ↓' },
              { key: 'spend', label: '按花費 Spend ↓' },
              { key: 'roas', label: '按 ROAS ↓' },
              { key: 'cpa', label: '按 CPA ↑' },
            ] as { key: SortBy; label: string }[]).map(s => (
              <button
                key={s.key}
                data-testid={`sort-${s.key}`}
                onClick={() => setSortBy(s.key)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${sortBy === s.key ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* Filter row */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">狀態:</span>
              {([
                { key: 'all', label: 'All' },
                { key: 'ACTIVE', label: 'Active' },
                { key: 'PAUSED', label: 'Paused' },
                { key: 'ended', label: 'Ended' },
              ] as { key: StatusFilter; label: string }[]).map(f => (
                <button
                  key={f.key}
                  data-testid={`filter-status-${f.key}`}
                  onClick={() => setStatusFilter(f.key)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${statusFilter === f.key ? 'bg-secondary text-foreground border-border' : 'border-border/40 text-muted-foreground hover:text-foreground'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">表現:</span>
              {([
                { key: 'all', label: 'All' },
                { key: 'has_purchases', label: '有購買 Has purchases' },
                { key: 'no_purchases', label: '無購買 No purchases' },
              ] as { key: PerfFilter; label: string }[]).map(f => (
                <button
                  key={f.key}
                  data-testid={`filter-perf-${f.key}`}
                  onClick={() => setPerfFilter(f.key)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${perfFilter === f.key ? 'bg-secondary text-foreground border-border' : 'border-border/40 text-muted-foreground hover:text-foreground'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground ml-auto tabular-nums">
              {filteredCampaigns.length} campaigns
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Campaign table */}
      <Card className="border-border/40 overflow-hidden">
        <CardContent className="p-0">
          {campaignsLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">載入中...</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="campaign-table">
                  <thead>
                    <tr className="border-b border-border/40 bg-muted/30">
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">評分</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">活動名稱 Campaign</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">狀態</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">花費 Spend</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">曝光 Imp</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">CTR</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">CPC</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">購買</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">ROAS</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">CPA</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">建議</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedCampaigns.map((c, i) => (
                      <tr
                        key={c.id || i}
                        data-testid={`campaign-row-${i}`}
                        className="border-b border-border/20 hover:bg-muted/20 cursor-pointer transition-colors"
                      >
                        <td className="px-3 py-2">
                          <span className={`whitespace-nowrap ${c.rating.color}`}>{c.rating.label}</span>
                        </td>
                        <td className="px-3 py-2 max-w-[220px]">
                          <span
                            className="truncate block"
                            title={c.campaign_name || ''}
                          >
                            {c.campaign_name?.length > 35 ? c.campaign_name.slice(0, 35) + '…' : (c.campaign_name || '—')}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`${statusColor(c.status)} font-medium`}>
                            {c.status || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">HK${c.spend.toLocaleString('en-HK', { maximumFractionDigits: 0 })}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(c.impressions)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${ctrColor(c.ctr, c.spend)}`}>{c.ctr.toFixed(2)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">HK${c.cpc.toFixed(2)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${c.purchases > 0 ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{c.purchases}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.purchases > 0 ? <span className="text-green-400">{c.roas.toFixed(1)}x</span> : <span className="text-muted-foreground">-</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.cpa !== null ? `HK$${c.cpa.toFixed(0)}` : <span className="text-muted-foreground">-</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs whitespace-nowrap ${
                            c.recommendation === '重複投放' || c.recommendation === '可再做' ? 'text-green-400'
                            : c.recommendation === '不建議再做' ? 'text-red-400'
                            : c.recommendation === '審查受眾' ? 'text-orange-400'
                            : 'text-muted-foreground'
                          }`}>
                            {c.recommendation}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border/30">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    第 {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredCampaigns.length)} 筆，共 {filteredCampaigns.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      data-testid="page-prev"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="p-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {page + 1} / {totalPages}
                    </span>
                    <button
                      data-testid="page-next"
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="p-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════════════════
           Section 2: 🎯 ROAS & 廣告效益 Ad Efficiency
         ═══════════════════════════════════════════════════════════════ */}
      <h2 className="text-sm font-semibold pt-4" data-testid="section-roas-efficiency">
        🎯 ROAS & 廣告效益 <span className="text-xs font-normal text-muted-foreground">Ad Efficiency</span>
      </h2>

      {/* ROAS KPI Row */}
      {!campaignsLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Overall ROAS */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">整體 ROAS <span className="opacity-70">Overall</span></p>
              <p className="text-xl font-semibold tabular-nums" data-testid="roas-overall">
                {roasSection.overallRoas.toFixed(1)}x
              </p>
            </CardContent>
          </Card>
          {/* Target ROAS with progress */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">目標 ROAS <span className="opacity-70">Target: {roasSection.targetRoas}x</span></p>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${roasSection.overallRoas >= roasSection.targetRoas ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ width: `${roasSection.roasProgress}%` }}
                  />
                </div>
                <span className={`text-sm font-semibold tabular-nums ${roasSection.overallRoas >= roasSection.targetRoas ? 'text-green-400' : 'text-red-400'}`}>
                  {roasSection.roasProgress.toFixed(0)}%
                </span>
              </div>
            </CardContent>
          </Card>
          {/* Best campaign */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">最佳 Campaign <span className="opacity-70">Best</span></p>
              <p className="text-sm font-medium truncate" title={roasSection.bestCampaign?.campaign_name || ''} data-testid="roas-best-campaign">
                {roasSection.bestCampaign
                  ? `${roasSection.bestCampaign.campaign_name?.slice(0, 30) || '—'} (${roasSection.bestCampaign.roas.toFixed(1)}x)`
                  : '-'}
              </p>
            </CardContent>
          </Card>
          {/* Worst spender */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">最差投入 <span className="opacity-70">Worst Spend</span></p>
              <p className="text-sm font-medium truncate text-red-400" title={roasSection.worstSpender?.campaign_name || ''} data-testid="roas-worst-spender">
                {roasSection.worstSpender
                  ? `${roasSection.worstSpender.campaign_name?.slice(0, 30) || '—'} (HK$${roasSection.worstSpender.spend.toLocaleString('en-HK', { maximumFractionDigits: 0 })})`
                  : '-'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top 10 by purchases - horizontal bar */}
        <ChartCard title="Top 10 購買活動" subtitle="By Purchases" loading={campaignsLoading}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={roasSection.top10} layout="vertical" margin={{ left: 10, right: 20 }}>
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" tick={AXIS_STYLE} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} width={140} />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(v: number) => [`${v} purchases`, 'Purchases']}
              />
              <Bar dataKey="purchases" radius={[0, 3, 3, 0]}>
                {roasSection.top10.map((entry, idx) => (
                  <Cell key={idx} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Spend vs Purchases comparison */}
        <ChartCard title="花費 vs 購買 (Top 15)" subtitle="Spend (red) vs Purchases×100 (green)" loading={campaignsLoading}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={roasSection.top15} layout="vertical" margin={{ left: 10, right: 20 }}>
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" tick={AXIS_STYLE} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} width={120} />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(v: number, name: string) => {
                  if (name === 'Spend') return [`HK$${v.toLocaleString()}`, name];
                  return [`${v / 100} purchases (×100)`, 'Purchases'];
                }}
              />
              <Bar dataKey="spend" name="Spend" fill={CHART_COLORS.fifth} radius={[0, 3, 3, 0]} />
              <Bar dataKey="purchasesScaled" name="Purchases ×100" fill={CHART_COLORS.tertiary} radius={[0, 3, 3, 0]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Should Redo list ── */}
      {roasSection.shouldRedo.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-green-400 mb-2">
            ✅ 值得重做 Should Redo ({roasSection.shouldRedo.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {roasSection.shouldRedo.map((c, i) => (
              <Card key={c.id || i} className="border-green-800/40 bg-green-950/20" data-testid={`redo-card-${i}`}>
                <CardContent className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate" title={c.campaign_name}>
                      {c.campaign_name?.slice(0, 40) || '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                      {c.purchases} purchases · CPA HK${c.cpa?.toFixed(0) || '—'}
                    </p>
                  </div>
                  <span className="text-green-400 text-xs font-medium whitespace-nowrap">✅ 重做</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── Avoid list ── */}
      {roasSection.avoid.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-red-400 mb-2">
            ❌ 不建議再做 Avoid ({roasSection.avoid.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {roasSection.avoid.map((c, i) => (
              <Card key={c.id || i} className="border-red-800/40 bg-red-950/20" data-testid={`avoid-card-${i}`}>
                <CardContent className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate" title={c.campaign_name}>
                      {c.campaign_name?.slice(0, 40) || '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                      Spent HK${c.spend.toLocaleString('en-HK', { maximumFractionDigits: 0 })}
                    </p>
                  </div>
                  <span className="text-red-400 text-xs font-medium whitespace-nowrap">❌ 避免</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
