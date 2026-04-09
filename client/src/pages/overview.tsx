import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, ShoppingCart, TrendingUp, Users, Store, Wrench } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

export default function OverviewPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [shopifyRevenue, setShopifyRevenue] = useState(0);
  const [bcCarshopRevenue, setBcCarshopRevenue] = useState(0);
  const [bcGarageRevenue, setBcGarageRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [aov, setAov] = useState(0);
  const [marselloCount, setMarselloCount] = useState(0);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [splitData, setSplitData] = useState<any[]>([]);
  const [adVsRevData, setAdVsRevData] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [orders, carshop, garage, marsello, adData] = await Promise.all([
          queryWithDateRange('shopify_orders', 'created_at,total_price,financial_status,cancelled_at', 'created_at', bounds),
          queryWithDateRange('bc_sales_invoices', 'invoice_date,total_amount_incl_tax', 'invoice_date', bounds, [{ column: 'dimension1_code', op: 'eq', value: 'CARSHOP' }]),
          queryWithDateRange('bc_sales_invoices', 'invoice_date,total_amount_incl_tax', 'invoice_date', bounds, [{ column: 'dimension1_code', op: 'eq', value: 'GARAGE' }]),
          queryAll('marsello_customers', 'id'),
          queryWithDateRange('meta_ad_insights', 'date,spend', 'date', bounds),
        ]);

        if (cancelled) return;

        const validOrders = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const rev = validOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
        const count = validOrders.length;

        setShopifyRevenue(rev);
        setTotalOrders(count);
        setAov(count > 0 ? rev / count : 0);

        const carRev = carshop.reduce((s: number, o: any) => s + (parseFloat(o.total_amount_incl_tax) || 0), 0);
        setBcCarshopRevenue(carRev);

        const garRev = garage.reduce((s: number, o: any) => s + (parseFloat(o.total_amount_incl_tax) || 0), 0);
        setBcGarageRevenue(garRev);

        setMarselloCount(marsello.length);

        // Revenue trend by day
        const dayMap: Record<string, { shopify: number; bc: number }> = {};
        validOrders.forEach((o: any) => {
          const day = o.created_at?.slice(0, 10);
          if (!day) return;
          if (!dayMap[day]) dayMap[day] = { shopify: 0, bc: 0 };
          dayMap[day].shopify += parseFloat(o.total_price) || 0;
        });
        [...carshop, ...garage].forEach((o: any) => {
          const day = o.invoice_date?.slice(0, 10);
          if (!day) return;
          if (!dayMap[day]) dayMap[day] = { shopify: 0, bc: 0 };
          dayMap[day].bc += parseFloat(o.total_amount_incl_tax) || 0;
        });
        setTrendData(
          Object.entries(dayMap)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, val]) => ({ date: date.slice(5), shopify: val.shopify, bc: val.bc, total: val.shopify + val.bc }))
        );

        // Retail vs Garage donut
        setSplitData([
          { name: '零售 Retail', value: rev + carRev },
          { name: '車房 Garage', value: garRev },
        ]);

        // Ad spend vs revenue
        const adMap: Record<string, number> = {};
        adData.forEach((a: any) => {
          const day = a.date?.slice(0, 10);
          if (day) adMap[day] = (adMap[day] || 0) + (parseFloat(a.spend) || 0);
        });
        const allDays = new Set([...Object.keys(dayMap), ...Object.keys(adMap)]);
        setAdVsRevData(
          Array.from(allDays).sort().map((d) => ({
            date: d.slice(5),
            revenue: dayMap[d]?.shopify || 0,
            spend: adMap[d] || 0,
          }))
        );
      } catch (e) {
        console.error('Overview load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="Shopify 營收" subtitle="Revenue" value={formatCurrency(shopifyRevenue)} icon={DollarSign} loading={loading} testId="kpi-shopify-rev" />
        <KpiCard title="BC 門店" subtitle="CARSHOP" value={formatCurrency(bcCarshopRevenue)} icon={Store} loading={loading} testId="kpi-carshop-rev" />
        <KpiCard title="BC 車房" subtitle="GARAGE" value={formatCurrency(bcGarageRevenue)} icon={Wrench} loading={loading} testId="kpi-garage-rev" />
        <KpiCard title="總訂單" subtitle="Orders" value={formatNumber(totalOrders)} icon={ShoppingCart} loading={loading} testId="kpi-orders" />
        <KpiCard title="平均單價" subtitle="AOV" value={formatCurrency(aov)} icon={TrendingUp} loading={loading} testId="kpi-aov" />
        <KpiCard title="Marsello 會員" subtitle="Members" value={formatNumber(marselloCount)} icon={Users} loading={loading} testId="kpi-marsello" />
      </div>

      <ChartCard title="綜合營收趨勢" subtitle="Combined Revenue Trend" loading={loading}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={trendData}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Line type="monotone" dataKey="shopify" name="Shopify" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="bc" name="BC" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="total" name="Total" stroke={CHART_COLORS.tertiary} strokeWidth={2} dot={false} strokeDasharray="5 5" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="零售 vs 車房" subtitle="Retail vs Garage Split" loading={loading}>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={splitData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value" nameKey="name" paddingAngle={2}>
                {splitData.map((_, i) => <Cell key={i} fill={DONUT_PALETTE[i]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="廣告支出 vs 營收" subtitle="Meta Spend vs Shopify Revenue" loading={loading}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={adVsRevData}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} />
              <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => name === 'spend' ? `HK$${v.toFixed(0)}` : formatCurrency(v)} />
              <Line yAxisId="left" type="monotone" dataKey="revenue" name="Revenue" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="spend" name="Ad Spend" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
