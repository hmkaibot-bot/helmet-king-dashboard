import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { supabase } from '@/lib/supabase';
import { queryAll, queryInBatches } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { RotateCcw, DollarSign, Percent, TrendingDown } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  ComposedChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const CANCEL_REASON_LABELS: Record<string, string> = {
  customer: '顧客取消',
  inventory: '庫存不足',
  fraud: '詐騙',
  other: '其他',
};

export default function ReturnsPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [refundedOrders, setRefundedOrders] = useState<any[]>([]);
  const [cancelledOrders, setCancelledOrders] = useState<any[]>([]);
  const [totalOrderCount, setTotalOrderCount] = useState(0);
  const [refundLines, setRefundLines] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // 四個 orders query 互不依賴 — 一齊並行發 (以前逐個 await,白等 3 個 round trip)
        const refundCols = 'id,order_number,created_at,total_price,total_discounts,customer_name,cancel_reason,gateway,source_name,financial_status';
        const [allRes, r1Res, r2Res, cancelRes] = await Promise.all([
          supabase.from('shopify_orders')
            .select('id,created_at,financial_status,cancelled_at')
            .gte('created_at', bounds.from)
            .limit(10000),
          supabase.from('shopify_orders')
            .select(refundCols)
            .eq('financial_status', 'refunded')
            .gte('created_at', bounds.from)
            .limit(5000),
          supabase.from('shopify_orders')
            .select(refundCols)
            .eq('financial_status', 'partially_refunded')
            .gte('created_at', bounds.from)
            .limit(5000),
          supabase.from('shopify_orders')
            .select('id,order_number,created_at,total_price,cancel_reason,cancelled_at')
            .not('cancelled_at', 'is', null)
            .gte('created_at', bounds.from)
            .limit(5000),
        ]);

        const filteredAll = (allRes.data || []).filter((o: any) => o.created_at && o.created_at <= bounds.to + '\xff');
        const allRefunded = [...(r1Res.data || []), ...(r2Res.data || [])]
          .filter((o: any) => o.created_at && o.created_at <= bounds.to + '\xff');
        const filteredCancelled = (cancelRes.data || []).filter((o: any) => o.created_at && o.created_at <= bounds.to + '\xff');

        if (cancelled) return;

        // Fetch order lines for refunded orders
        const refundIds = allRefunded.map((o: any) => String(o.id));
        const lines = await queryInBatches('shopify_order_lines', 'order_id,title,vendor,quantity,price', 'order_id', refundIds);

        setRefundedOrders(allRefunded);
        setCancelledOrders(filteredCancelled);
        setTotalOrderCount(filteredAll.length);
        setRefundLines(lines);
      } catch (e) {
        console.error('Returns error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  // KPIs
  const refundCount = refundedOrders.length;
  const refundValue = useMemo(() => refundedOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [refundedOrders]);
  const refundRate = totalOrderCount > 0 ? (refundCount / totalOrderCount) * 100 : 0;
  const avgRefund = refundCount > 0 ? refundValue / refundCount : 0;

  // Monthly refund trend + rate
  const monthlyRefund = useMemo(() => {
    const refundMap: Record<string, { count: number; value: number }> = {};
    refundedOrders.forEach((o: any) => {
      const m = o.created_at?.slice(0, 7);
      if (!m) return;
      if (!refundMap[m]) refundMap[m] = { count: 0, value: 0 };
      refundMap[m].count++;
      refundMap[m].value += parseFloat(o.total_price) || 0;
    });

    // Total orders per month for rate
    // We'll approximate from refunded data range
    const allMonths = Object.keys(refundMap).sort();
    return allMonths.map((m) => ({
      month: m,
      value: refundMap[m]?.value || 0,
      count: refundMap[m]?.count || 0,
    }));
  }, [refundedOrders]);

  // Cancel reason distribution (from cancelled + refunded)
  const cancelReasons = useMemo(() => {
    const map: Record<string, number> = {};
    [...refundedOrders, ...cancelledOrders].forEach((o: any) => {
      const reason = o.cancel_reason || '未知';
      const label = CANCEL_REASON_LABELS[reason] || reason;
      map[label] = (map[label] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [refundedOrders, cancelledOrders]);

  // Top 10 refunded products by revenue impact
  const topRefundProducts = useMemo(() => {
    const map: Record<string, { title: string; revenue: number; qty: number }> = {};
    refundLines.forEach((l: any) => {
      const title = l.title || 'Unknown';
      if (!map[title]) map[title] = { title, revenue: 0, qty: 0 };
      map[title].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
      map[title].qty += l.quantity || 0;
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 10).map((p) => ({ name: p.title, value: p.revenue }));
  }, [refundLines]);

  // Refund by payment gateway
  const gatewayRefunds = useMemo(() => {
    const map: Record<string, number> = {};
    refundedOrders.forEach((o: any) => {
      const gw = o.gateway || '未知';
      map[gw] = (map[gw] || 0) + (parseFloat(o.total_price) || 0);
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  }, [refundedOrders]);

  // Recent 30 refunded orders
  const recentRefunds = useMemo(() => {
    return [...refundedOrders]
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 30);
  }, [refundedOrders]);

  // Order lines map for recent refunds display
  const orderLinesMap = useMemo(() => {
    const map: Record<string, string[]> = {};
    refundLines.forEach((l: any) => {
      if (!map[l.order_id]) map[l.order_id] = [];
      map[l.order_id].push(l.title || '');
    });
    return map;
  }, [refundLines]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="退款訂單" subtitle="Total Refunds" value={formatNumber(refundCount)} icon={RotateCcw} loading={loading} testId="kpi-refund-count" />
        <KpiCard title="退款金額" subtitle="Refund Value" value={formatCurrency(refundValue)} icon={DollarSign} loading={loading} testId="kpi-refund-value" />
        <KpiCard title="退款率" subtitle="Refund Rate" value={formatPercent(refundRate)} icon={Percent} loading={loading} testId="kpi-refund-rate" />
        <KpiCard title="平均退款" subtitle="Avg Refund" value={formatCurrency(avgRefund)} icon={TrendingDown} loading={loading} testId="kpi-avg-refund" />
      </div>

      <ChartCard title="退款月度趨勢" subtitle="Monthly Refund Trend" loading={loading}>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={monthlyRefund}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="month" tick={AXIS_STYLE} />
            <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => name === '退款額' ? formatCurrency(v) : v} />
            <Bar yAxisId="left" dataKey="value" name="退款額" fill={CHART_COLORS.fifth} radius={[3, 3, 0, 0]} opacity={0.7} />
            <Line yAxisId="right" type="monotone" dataKey="count" name="退款筆數" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="取消原因" subtitle="Cancel Reason" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={cancelReasons} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" nameKey="name" paddingAngle={2}>
                {cancelReasons.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="退款付款方式" subtitle="Refund by Gateway" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={gatewayRefunds}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="name" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="value" name="退款額" fill={CHART_COLORS.quaternary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="退款產品 Top 10" subtitle="By Revenue Impact" loading={loading}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={topRefundProducts} layout="vertical">
            <CartesianGrid {...GRID_STYLE} />
            <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={150} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="value" name="退款額" fill={CHART_COLORS.fifth} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            最近退款訂單 <span className="text-xs font-normal text-muted-foreground">Recent 30 Refunded Orders</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : recentRefunds.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">無退款訂單</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-returns">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">訂單 #</th>
                    <th className="py-2 text-left font-medium">日期 Date</th>
                    <th className="py-2 text-left font-medium">客戶 Customer</th>
                    <th className="py-2 text-right font-medium">金額 Amount</th>
                    <th className="py-2 text-left font-medium">原因 Reason</th>
                    <th className="py-2 text-left font-medium">產品 Products</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRefunds.map((o: any, i: number) => {
                    const reason = o.cancel_reason ? (CANCEL_REASON_LABELS[o.cancel_reason] || o.cancel_reason) : '未知';
                    const products = orderLinesMap[o.id]?.slice(0, 2).join(', ') || '—';
                    return (
                      <tr key={o.id + '-' + i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <td className="py-2 font-mono text-[11px]">#{o.order_number}</td>
                        <td className="py-2 text-muted-foreground">{o.created_at?.slice(0, 10)}</td>
                        <td className="py-2 max-w-[120px] truncate">{o.customer_name || '—'}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(parseFloat(o.total_price))}</td>
                        <td className="py-2 text-muted-foreground">{reason}</td>
                        <td className="py-2 max-w-[200px] truncate text-muted-foreground">{products}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
