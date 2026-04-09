import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useDateRange } from '@/lib/date-context';
import { getDateFrom, formatCurrency, formatNumber } from '@/lib/format';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { DollarSign, ShoppingCart, TrendingUp, Users } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { CHART_COLORS, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';

interface OrderRow {
  total_price: number;
  customer_id: string | null;
  created_at: string;
  financial_status: string;
}

// Paginated fetch for tables with >1000 rows
async function fetchAllOrders(dateFrom: string | null): Promise<OrderRow[]> {
  const all: OrderRow[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from('shopify_orders')
      .select('total_price, customer_id, created_at, financial_status')
      .range(from, from + pageSize - 1);

    if (dateFrom) {
      query = query.gte('created_at', dateFrom);
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) {
      hasMore = false;
    } else {
      all.push(...(data as OrderRow[]));
      from += pageSize;
      if (data.length < pageSize) hasMore = false;
    }
  }
  return all;
}

export default function SalesPage() {
  const { dateRange } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<OrderRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchOrders() {
      try {
        const dateFrom = getDateFrom(dateRange);
        const data = await fetchAllOrders(dateFrom);
        if (!cancelled) {
          setOrders(data);
        }
      } catch (err) {
        console.error('Sales fetch error:', err);
      }
      if (!cancelled) setLoading(false);
    }

    fetchOrders();
    return () => { cancelled = true; };
  }, [dateRange]);

  // Computed KPIs
  const validOrders = orders.filter((o) => o.financial_status !== 'refunded');
  const totalRevenue = validOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0);
  const orderCount = validOrders.length;
  const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const activeCustomers = new Set(
    validOrders
      .filter((o) => new Date(o.created_at) >= thirtyDaysAgo && o.customer_id)
      .map((o) => o.customer_id)
  ).size;

  // Revenue by day (last 30 days)
  const revenueByDay = (() => {
    const map: Record<string, number> = {};
    validOrders.forEach((o) => {
      const day = o.created_at?.substring(0, 10);
      if (day) map[day] = (map[day] || 0) + (Number(o.total_price) || 0);
    });
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30)
      .map(([date, revenue]) => ({
        date: date.substring(5),
        revenue: Math.round(revenue),
      }));
  })();

  // Revenue by month
  const revenueByMonth = (() => {
    const map: Record<string, number> = {};
    validOrders.forEach((o) => {
      const month = o.created_at?.substring(0, 7);
      if (month) map[month] = (map[month] || 0) + (Number(o.total_price) || 0);
    });
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, revenue]) => ({
        month: month.substring(2),
        revenue: Math.round(revenue),
      }));
  })();

  // Orders by financial_status
  const statusCounts = (() => {
    const map: Record<string, number> = {};
    orders.forEach((o) => {
      const s = o.financial_status || 'unknown';
      map[s] = (map[s] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  })();

  return (
    <div className="space-y-4 max-w-[1400px]">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          title="總營收" subtitle="Revenue"
          value={formatCurrency(totalRevenue)}
          icon={DollarSign} loading={loading}
          testId="kpi-revenue"
        />
        <KpiCard
          title="訂單數" subtitle="Orders"
          value={formatNumber(orderCount)}
          icon={ShoppingCart} loading={loading}
          testId="kpi-orders"
        />
        <KpiCard
          title="平均訂單" subtitle="AOV"
          value={formatCurrency(avgOrderValue)}
          icon={TrendingUp} loading={loading}
          testId="kpi-aov"
        />
        <KpiCard
          title="活躍客戶" subtitle="Active 30d"
          value={formatNumber(activeCustomers)}
          icon={Users} loading={loading}
          testId="kpi-active"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard title="每日營收" subtitle="Daily Revenue (Last 30 days)" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={revenueByDay}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`HK$${v.toLocaleString()}`, '營收']} />
              <Line type="monotone" dataKey="revenue" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="每月營收" subtitle="Monthly Revenue" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={revenueByMonth}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="month" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`HK$${v.toLocaleString()}`, '營收']} />
              <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Status donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ChartCard title="訂單狀態" subtitle="Order Status" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={statusCounts}
                cx="50%" cy="50%"
                innerRadius={55} outerRadius={85}
                paddingAngle={3}
                dataKey="value"
              >
                {statusCounts.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
