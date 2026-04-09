import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { DollarSign, ClipboardList, TrendingUp, Users, UserCheck } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

export default function GarageOrdersPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [revenue, setRevenue] = useState(0);
  const [invoiceCount, setInvoiceCount] = useState(0);
  const [avgInvoice, setAvgInvoice] = useState(0);
  const [uniqueCustomers, setUniqueCustomers] = useState(0);
  const [revPerCustomer, setRevPerCustomer] = useState(0);
  const [monthlyRevenue, setMonthlyRevenue] = useState<any[]>([]);
  const [dailyRevenue, setDailyRevenue] = useState<any[]>([]);
  const [valueDist, setValueDist] = useState<any[]>([]);
  const [topCustomers, setTopCustomers] = useState<any[]>([]);
  const [monthlyCustomers, setMonthlyCustomers] = useState<any[]>([]);
  const [recentInvoices, setRecentInvoices] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const invoices = await queryWithDateRange('bc_sales_invoices', 'id,number,invoice_date,customer_number,customer_name,status,total_amount_incl_tax', 'invoice_date', bounds, [{ column: 'dimension1_code', op: 'eq', value: 'GARAGE' }]);
        if (cancelled) return;

        const rev = invoices.reduce((s: number, i: any) => s + (parseFloat(i.total_amount_incl_tax) || 0), 0);
        const count = invoices.length;
        const custSet = new Set(invoices.map((i: any) => i.customer_number || i.customer_name).filter(Boolean));

        setRevenue(rev);
        setInvoiceCount(count);
        setAvgInvoice(count > 0 ? rev / count : 0);
        setUniqueCustomers(custSet.size);
        setRevPerCustomer(custSet.size > 0 ? rev / custSet.size : 0);

        // Monthly
        const monthMap: Record<string, number> = {};
        invoices.forEach((i: any) => { const m = i.invoice_date?.slice(0, 7); if (m) monthMap[m] = (monthMap[m] || 0) + (parseFloat(i.total_amount_incl_tax) || 0); });
        setMonthlyRevenue(Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, value]) => ({ month, revenue: value })));

        // Daily
        const dayMap: Record<string, number> = {};
        invoices.forEach((i: any) => { const d = i.invoice_date?.slice(0, 10); if (d) dayMap[d] = (dayMap[d] || 0) + (parseFloat(i.total_amount_incl_tax) || 0); });
        setDailyRevenue(Object.entries(dayMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date: date.slice(5), revenue: value })));

        // Value distribution
        const buckets = [{ label: '<500', min: 0, max: 500 }, { label: '500-2K', min: 500, max: 2000 }, { label: '2K-5K', min: 2000, max: 5000 }, { label: '5K+', min: 5000, max: Infinity }];
        setValueDist(buckets.map((b) => ({ name: b.label, count: invoices.filter((i: any) => { const a = parseFloat(i.total_amount_incl_tax) || 0; return a >= b.min && a < b.max; }).length })));

        // Top customers
        const custMap: Record<string, { name: string; total: number }> = {};
        invoices.forEach((i: any) => { const k = i.customer_number || i.customer_name || 'Unknown'; if (!custMap[k]) custMap[k] = { name: i.customer_name || k, total: 0 }; custMap[k].total += parseFloat(i.total_amount_incl_tax) || 0; });
        setTopCustomers(Object.values(custMap).sort((a, b) => b.total - a.total).slice(0, 10));

        // Monthly customer count
        const monthCust: Record<string, Set<string>> = {};
        invoices.forEach((i: any) => { const m = i.invoice_date?.slice(0, 7); const c = i.customer_number || i.customer_name; if (!m || !c) return; if (!monthCust[m]) monthCust[m] = new Set(); monthCust[m].add(c); });
        setMonthlyCustomers(Object.entries(monthCust).sort(([a], [b]) => a.localeCompare(b)).map(([month, s]) => ({ month, customers: s.size })));

        setRecentInvoices(invoices.sort((a: any, b: any) => (b.invoice_date || '').localeCompare(a.invoice_date || '')).slice(0, 20));
      } catch (e) { console.error('GarageOrders error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="車房營收" subtitle="Revenue" value={formatCurrency(revenue)} icon={DollarSign} loading={loading} testId="kpi-garage-rev" />
        <KpiCard title="工單數" subtitle="Orders" value={formatNumber(invoiceCount)} icon={ClipboardList} loading={loading} testId="kpi-invoices" />
        <KpiCard title="平均單值" subtitle="Avg Invoice" value={formatCurrency(avgInvoice)} icon={TrendingUp} loading={loading} testId="kpi-avg" />
        <KpiCard title="獨立客戶" subtitle="Unique" value={formatNumber(uniqueCustomers)} icon={Users} loading={loading} testId="kpi-cust" />
        <KpiCard title="人均消費" subtitle="Rev/Cust" value={formatCurrency(revPerCustomer)} icon={UserCheck} loading={loading} testId="kpi-rpc" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="月度營收" subtitle="Monthly" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyRevenue}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="每日趨勢" subtitle="Daily Trend" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={dailyRevenue}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Line type="monotone" dataKey="revenue" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="金額分佈" subtitle="Value Distribution" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={valueDist}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="name" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} /><Bar dataKey="count" fill={CHART_COLORS.quaternary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Top 10 客戶" subtitle="By Spend" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={topCustomers} layout="vertical">
              <CartesianGrid {...GRID_STYLE} /><XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={100} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="total" fill={CHART_COLORS.secondary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="月度客戶數" subtitle="Monthly Customers" loading={loading}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={monthlyCustomers}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
            <Tooltip {...TOOLTIP_STYLE} /><Line type="monotone" dataKey="customers" stroke={CHART_COLORS.tertiary} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-medium">最近工單 <span className="text-xs font-normal text-muted-foreground">Recent Invoices</span></CardTitle></CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : recentInvoices.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">数据不足</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-garage-invoices">
                <thead><tr className="border-b border-border/50 text-muted-foreground">
                  <th className="py-2 text-left font-medium">單號</th><th className="py-2 text-left font-medium">日期</th><th className="py-2 text-left font-medium">客戶</th><th className="py-2 text-right font-medium">金額</th><th className="py-2 text-right font-medium">狀態</th>
                </tr></thead>
                <tbody>{recentInvoices.map((inv: any) => (
                  <tr key={inv.id} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                    <td className="py-2 tabular-nums">{inv.number}</td>
                    <td className="py-2 text-muted-foreground">{inv.invoice_date?.slice(0, 10)}</td>
                    <td className="py-2">{inv.customer_name || '—'}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(parseFloat(inv.total_amount_incl_tax))}</td>
                    <td className="py-2 text-right"><Badge variant="secondary" className="text-[10px]">{inv.status || '—'}</Badge></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
