import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useDateRange } from '@/lib/date-context';
import { getDateFrom, formatCurrency, formatNumber } from '@/lib/format';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { Receipt, FileText, TrendingUp, DollarSign } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { CHART_COLORS, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

interface InvoiceRow {
  number: string;
  invoice_date: string;
  customer_name: string;
  status: string;
  total_amount_incl_tax: number;
}

export default function FinancePage() {
  const { dateRange } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function fetchData() {
      let query = supabase
        .from('bc_sales_invoices')
        .select('number, invoice_date, customer_name, status, total_amount_incl_tax');

      const dateFrom = getDateFrom(dateRange);
      if (dateFrom) {
        query = query.gte('invoice_date', dateFrom.substring(0, 10));
      }

      const { data } = await query;
      if (!cancelled && data) {
        setInvoices(data as InvoiceRow[]);
      }
      if (!cancelled) setLoading(false);
    }

    fetchData();
    return () => { cancelled = true; };
  }, [dateRange]);

  // KPIs
  const totalRevenue = invoices.reduce((s, inv) => s + (Number(inv.total_amount_incl_tax) || 0), 0);
  const invoiceCount = invoices.length;
  const avgInvoiceValue = invoiceCount > 0 ? totalRevenue / invoiceCount : 0;

  // Revenue by month
  const revenueByMonth = (() => {
    const map: Record<string, number> = {};
    invoices.forEach((inv) => {
      const month = inv.invoice_date?.substring(0, 7);
      if (month) map[month] = (map[month] || 0) + (Number(inv.total_amount_incl_tax) || 0);
    });
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, revenue]) => ({ month: month.substring(2), revenue: Math.round(revenue) }));
  })();

  // Status breakdown
  const statusData = (() => {
    const map: Record<string, number> = {};
    invoices.forEach((inv) => {
      const s = inv.status || 'unknown';
      map[s] = (map[s] || 0) + 1;
    });
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  })();

  // Top customers
  const topCustomers = (() => {
    const map: Record<string, { count: number; total: number }> = {};
    invoices.forEach((inv) => {
      const name = inv.customer_name || 'Unknown';
      if (!map[name]) map[name] = { count: 0, total: 0 };
      map[name].count++;
      map[name].total += Number(inv.total_amount_incl_tax) || 0;
    });
    return Object.entries(map)
      .map(([customer_name, d]) => ({
        customer_name,
        invoice_count: d.count,
        total_spend: Math.round(d.total),
      }))
      .sort((a, b) => b.total_spend - a.total_spend)
      .slice(0, 10);
  })();

  return (
    <div className="space-y-4 max-w-[1400px]">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard title="發票總額" subtitle="Total Revenue" value={formatCurrency(totalRevenue)} icon={DollarSign} loading={loading} testId="kpi-bc-revenue" />
        <KpiCard title="發票數" subtitle="Invoices" value={formatNumber(invoiceCount)} icon={FileText} loading={loading} testId="kpi-invoices" />
        <KpiCard title="平均發票" subtitle="Avg Invoice" value={formatCurrency(avgInvoiceValue)} icon={TrendingUp} loading={loading} testId="kpi-avg-invoice" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Revenue by month */}
        <ChartCard title="每月收入" subtitle="Monthly Revenue" loading={loading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={revenueByMonth}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="month" tick={AXIS_STYLE} tickLine={false} axisLine={false} />
              <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`HK$${v.toLocaleString()}`, '收入']} />
              <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Invoice status */}
        <ChartCard title="發票狀態" subtitle="Invoice Status" loading={loading}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={statusData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value">
                {statusData.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Top customers table */}
      <ChartCard title="客戶消費排行" subtitle="Top Customers by Spend" loading={loading}>
        <div className="max-h-[300px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">客戶 Customer</TableHead>
                <TableHead className="text-xs text-right">發票數 Invoices</TableHead>
                <TableHead className="text-xs text-right">總消費 Total Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : (
                topCustomers.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs font-medium max-w-[200px] truncate">{c.customer_name}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{c.invoice_count}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">{formatCurrency(c.total_spend)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    </div>
  );
}
