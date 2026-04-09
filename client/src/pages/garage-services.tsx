import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryAll, queryInBatches } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { ListOrdered, Hash, Star, DollarSign } from 'lucide-react';
import { BarChart, Bar, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function GarageServicesPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [lines, setLines] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // BC GARAGE data should NOT use date picker filter
        const invs = await queryAll('bc_sales_invoices', 'id,number,invoice_date,salesperson_code,total_amount_incl_tax', [{ column: 'dimension1_code', op: 'eq', value: 'GARAGE' }]);
        const invoiceIds = invs.map((i: any) => i.id);
        const garageLines = await queryInBatches('bc_invoice_lines', 'id,invoice_id,invoice_number,item_number,description,quantity,unit_price,amount_incl_tax', 'invoice_id', invoiceIds);
        if (!cancelled) { setInvoices(invs); setLines(garageLines); }
      } catch (e) { console.error('GarageServices error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  const totalLines = lines.length;
  const avgLinesPerInvoice = invoices.length > 0 ? totalLines / invoices.length : 0;

  const serviceMap = useMemo(() => {
    const map: Record<string, { count: number; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => { const d = l.description || 'Unknown'; if (!map[d]) map[d] = { count: 0, qty: 0, revenue: 0 }; map[d].count++; map[d].qty += l.quantity || 0; map[d].revenue += parseFloat(l.amount_incl_tax) || 0; });
    return map;
  }, [lines]);

  const sortedByRevenue = useMemo(() => Object.entries(serviceMap).sort((a, b) => b[1].revenue - a[1].revenue), [serviceMap]);
  const sortedByFreq = useMemo(() => Object.entries(serviceMap).sort((a, b) => b[1].count - a[1].count), [serviceMap]);
  const mostCommon = sortedByFreq[0]?.[0]?.slice(0, 20) || '—';
  const topRevService = sortedByRevenue[0]?.[0]?.slice(0, 20) || '—';

  const top20Revenue = sortedByRevenue.slice(0, 20).map(([name, d]) => ({ name: name.length > 30 ? name.slice(0, 30) + '…' : name, revenue: d.revenue }));
  const top20Freq = sortedByFreq.slice(0, 20).map(([name, d]) => ({ name: name.length > 30 ? name.slice(0, 30) + '…' : name, count: d.count }));

  const top5Services = sortedByRevenue.slice(0, 5).map(([n]) => n);
  const serviceTrend = useMemo(() => {
    const invMonthMap: Record<string, string> = {};
    invoices.forEach((i: any) => { invMonthMap[i.id] = i.invoice_date?.slice(0, 7) || ''; });
    const monthMap: Record<string, Record<string, number>> = {};
    lines.forEach((l: any) => { const m = invMonthMap[l.invoice_id]; const d = l.description || 'Unknown'; if (!m || !top5Services.includes(d)) return; if (!monthMap[m]) monthMap[m] = {}; monthMap[m][d] = (monthMap[m][d] || 0) + (parseFloat(l.amount_incl_tax) || 0); });
    return Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, s]) => ({ month, ...s }));
  }, [lines, invoices, top5Services]);

  const salespersonData = useMemo(() => {
    const map: Record<string, number> = {};
    invoices.forEach((i: any) => { const sp = i.salesperson_code || 'Unknown'; map[sp] = (map[sp] || 0) + (parseFloat(i.total_amount_incl_tax) || 0); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, revenue: value }));
  }, [invoices]);

  const diversityData = useMemo(() => {
    const invMonthMap: Record<string, string> = {};
    invoices.forEach((i: any) => { invMonthMap[i.id] = i.invoice_date?.slice(0, 7) || ''; });
    const ms: Record<string, Set<string>> = {};
    lines.forEach((l: any) => { const m = invMonthMap[l.invoice_id]; if (!m) return; if (!ms[m]) ms[m] = new Set(); ms[m].add(l.description || 'Unknown'); });
    return Object.entries(ms).sort(([a], [b]) => a.localeCompare(b)).map(([month, s]) => ({ month, count: s.size }));
  }, [lines, invoices]);

  const garageTotal = invoices.reduce((s: number, i: any) => s + (parseFloat(i.total_amount_incl_tax) || 0), 0);
  const serviceTable = sortedByRevenue.slice(0, 30).map(([name, d]) => ({ name, count: d.count, qty: d.qty, avgPrice: d.qty > 0 ? d.revenue / d.qty : 0, revenue: d.revenue, pct: garageTotal > 0 ? (d.revenue / garageTotal) * 100 : 0 }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="服務行數" subtitle="Lines" value={formatNumber(totalLines)} icon={ListOrdered} loading={loading} testId="kpi-lines" />
        <KpiCard title="平均行/單" subtitle="Avg" value={avgLinesPerInvoice.toFixed(1)} icon={Hash} loading={loading} testId="kpi-avg-lines" />
        <KpiCard title="最常見" subtitle="Most Common" value={mostCommon} icon={Star} loading={loading} testId="kpi-common" />
        <KpiCard title="最高收入" subtitle="Top Rev" value={topRevService} icon={DollarSign} loading={loading} testId="kpi-top-rev" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="服務營收 Top 20" subtitle="By Revenue" loading={loading}>
          <ResponsiveContainer width="100%" height={420}>
            <BarChart data={top20Revenue} layout="vertical">
              <CartesianGrid {...GRID_STYLE} /><XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} width={130} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="服務頻率 Top 20" subtitle="By Frequency" loading={loading}>
          <ResponsiveContainer width="100%" height={420}>
            <BarChart data={top20Freq} layout="vertical">
              <CartesianGrid {...GRID_STYLE} /><XAxis type="number" tick={AXIS_STYLE} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} width={130} />
              <Tooltip {...TOOLTIP_STYLE} /><Bar dataKey="count" fill={CHART_COLORS.secondary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="服務趨勢 (Top 5)" subtitle="Monthly" loading={loading}>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={serviceTrend}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            {top5Services.map((svc, i) => <Area key={svc} type="monotone" dataKey={svc} stackId="1" stroke={CHART_PALETTE[i]} fill={CHART_PALETTE[i]} fillOpacity={0.3} />)}
            <Legend wrapperStyle={{ fontSize: 10 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="銷售員" subtitle="Performance" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={salespersonData}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="name" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} /><Bar dataKey="revenue" fill={CHART_COLORS.tertiary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="服務多樣性" subtitle="Monthly Diversity" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={diversityData}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} /><Line type="monotone" dataKey="count" stroke={CHART_COLORS.quaternary} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-medium">服務分析 <span className="text-xs font-normal text-muted-foreground">Analysis</span></CardTitle></CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : serviceTable.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">数据不足</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-services">
                <thead><tr className="border-b border-border/50 text-muted-foreground">
                  <th className="py-2 text-left font-medium">服務</th><th className="py-2 text-right font-medium">單數</th><th className="py-2 text-right font-medium">數量</th><th className="py-2 text-right font-medium">均價</th><th className="py-2 text-right font-medium">營收</th><th className="py-2 text-right font-medium">%</th>
                </tr></thead>
                <tbody>{serviceTable.map((s, i) => (
                  <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                    <td className="py-2 max-w-[200px] truncate">{s.name}</td>
                    <td className="py-2 text-right tabular-nums">{s.count}</td>
                    <td className="py-2 text-right tabular-nums">{formatNumber(s.qty)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(s.avgPrice)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(s.revenue)}</td>
                    <td className="py-2 text-right tabular-nums">{s.pct.toFixed(1)}%</td>
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
