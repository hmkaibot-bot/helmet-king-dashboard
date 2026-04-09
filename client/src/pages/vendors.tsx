import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll, queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, DONUT_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { Building2, DollarSign, FileText, Receipt } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function VendorsPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [lines, setLines] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // BC purchase data should NOT be date-filtered — show all available data
        const [inv, ln] = await Promise.all([
          queryAllPages(
            'bc_purchase_invoices',
            'id,number,posting_date,vendor_number,vendor_name,total_amount_incl_tax,dimension1_code'
          ),
          queryAllPages(
            'bc_purchase_invoice_lines',
            'invoice_id,item_number,description,quantity,unit_cost,amount_incl_tax'
          ),
        ]);
        if (cancelled) return;
        setInvoices(inv);
        setLines(ln);
      } catch (e) {
        console.error('Vendors error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  // Join lines to invoices
  const invoiceIds = useMemo(() => new Set(invoices.map((i: any) => i.id)), [invoices]);
  const filteredLines = useMemo(() => lines.filter((l: any) => invoiceIds.has(l.invoice_id)), [lines, invoiceIds]);

  // Build invoice → vendor map
  const invoiceVendorMap = useMemo(() => {
    const map: Record<string, string> = {};
    invoices.forEach((i: any) => { map[i.id] = i.vendor_number || i.vendor_name || 'Unknown'; });
    return map;
  }, [invoices]);

  // KPIs
  const totalVendors = useMemo(() => new Set(invoices.map((i: any) => i.vendor_number || i.vendor_name)).size, [invoices]);
  const totalAmount = useMemo(() => invoices.reduce((s: number, i: any) => s + (parseFloat(i.total_amount_incl_tax) || 0), 0), [invoices]);
  const avgInvoice = invoices.length > 0 ? totalAmount / invoices.length : 0;

  // Top 15 vendors by amount
  const vendorAmounts = useMemo(() => {
    const map: Record<string, { name: string; total: number }> = {};
    invoices.forEach((i: any) => {
      const k = i.vendor_number || i.vendor_name || 'Unknown';
      if (!map[k]) map[k] = { name: i.vendor_name || k, total: 0 };
      map[k].total += parseFloat(i.total_amount_incl_tax) || 0;
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [invoices]);

  const top15Vendors = useMemo(() => vendorAmounts.slice(0, 15), [vendorAmounts]);

  // Monthly purchase trend
  const monthlyTrend = useMemo(() => {
    const map: Record<string, number> = {};
    invoices.forEach((i: any) => {
      const m = i.posting_date?.slice(0, 7);
      if (m) map[m] = (map[m] || 0) + (parseFloat(i.total_amount_incl_tax) || 0);
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, total]) => ({ month, total }));
  }, [invoices]);

  // Vendor concentration donut
  const vendorConcentration = useMemo(() => {
    const top5 = vendorAmounts.slice(0, 5);
    const top5Total = top5.reduce((s, v) => s + v.total, 0);
    const othersTotal = totalAmount - top5Total;
    const result = top5.map((v) => ({ name: v.name, value: v.total }));
    if (othersTotal > 0) result.push({ name: '其他 Others', value: othersTotal });
    return result;
  }, [vendorAmounts, totalAmount]);

  // Purchase by dimension1_code
  const dimDistribution = useMemo(() => {
    const map: Record<string, number> = {};
    invoices.forEach((i: any) => {
      const d = i.dimension1_code || '未分類';
      map[d] = (map[d] || 0) + (parseFloat(i.total_amount_incl_tax) || 0);
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [invoices]);

  // Vendor summary table
  const vendorSummary = useMemo(() => {
    // Find most frequent description per vendor
    const vendorTopItem: Record<string, Record<string, number>> = {};
    filteredLines.forEach((l: any) => {
      const vk = invoiceVendorMap[l.invoice_id];
      if (!vk) return;
      if (!vendorTopItem[vk]) vendorTopItem[vk] = {};
      const desc = l.description || '—';
      vendorTopItem[vk][desc] = (vendorTopItem[vk][desc] || 0) + 1;
    });

    return vendorAmounts.slice(0, 30).map((v) => {
      const invCount = invoices.filter((i: any) => (i.vendor_number || i.vendor_name || 'Unknown') === (v.name === v.name ? invoices.find((ii: any) => ii.vendor_name === v.name)?.vendor_number || v.name : v.name)).length;
      // Simplified: count by vendor name
      const vInvoices = invoices.filter((i: any) => i.vendor_name === v.name);
      const count = vInvoices.length;
      const vendorNum = vInvoices[0]?.vendor_number || '—';
      const avg = count > 0 ? v.total / count : 0;
      const pct = totalAmount > 0 ? (v.total / totalAmount) * 100 : 0;

      // Top item
      const itemCounts = vendorTopItem[vendorNum] || vendorTopItem[v.name] || {};
      const topItem = Object.entries(itemCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

      return {
        name: v.name,
        vendorNum,
        count,
        total: v.total,
        avg,
        pct,
        topItem,
      };
    });
  }, [vendorAmounts, invoices, filteredLines, invoiceVendorMap, totalAmount]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="供應商數" subtitle="Total Vendors" value={formatNumber(totalVendors)} icon={Building2} loading={loading} testId="kpi-vendors" />
        <KpiCard title="採購總額" subtitle="Total Purchase" value={formatCurrency(totalAmount)} icon={DollarSign} loading={loading} testId="kpi-total-amt" />
        <KpiCard title="平均發票金額" subtitle="Avg Invoice" value={formatCurrency(avgInvoice)} icon={Receipt} loading={loading} testId="kpi-avg-inv" />
        <KpiCard title="採購發票數" subtitle="Total Invoices" value={formatNumber(invoices.length)} icon={FileText} loading={loading} testId="kpi-inv-count" />
      </div>

      <ChartCard title="Top 15 供應商" subtitle="By Purchase Amount" loading={loading}>
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={top15Vendors} layout="vertical">
            <CartesianGrid {...GRID_STYLE} />
            <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={120} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="total" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="月度採購趨勢" subtitle="Monthly Purchase Trend" loading={loading}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={monthlyTrend}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="month" tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Line type="monotone" dataKey="total" name="採購額" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.secondary }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="供應商集中度" subtitle="Vendor Concentration" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={vendorConcentration} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" nameKey="name" paddingAngle={2}>
                {vendorConcentration.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="採購分類" subtitle="By Dimension Code" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={dimDistribution} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" nameKey="name" paddingAngle={2}>
                {dimDistribution.map((_, i) => (
                  <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            供應商一覽 <span className="text-xs font-normal text-muted-foreground">Vendor Summary</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : vendorSummary.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">無數據</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-vendors">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">供應商 Vendor</th>
                    <th className="py-2 text-left font-medium">編號 #</th>
                    <th className="py-2 text-right font-medium">發票數</th>
                    <th className="py-2 text-right font-medium">總金額</th>
                    <th className="py-2 text-right font-medium">均單</th>
                    <th className="py-2 text-right font-medium">佔比%</th>
                    <th className="py-2 text-left font-medium">主要項目</th>
                  </tr>
                </thead>
                <tbody>
                  {vendorSummary.map((v, i) => (
                    <tr key={v.name + '-' + i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 font-medium max-w-[160px] truncate">{v.name}</td>
                      <td className="py-2 font-mono text-[11px] text-muted-foreground">{v.vendorNum}</td>
                      <td className="py-2 text-right tabular-nums">{v.count}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(v.total)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(v.avg)}</td>
                      <td className="py-2 text-right tabular-nums">{formatPercent(v.pct)}</td>
                      <td className="py-2 text-muted-foreground max-w-[180px] truncate">{v.topItem}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
