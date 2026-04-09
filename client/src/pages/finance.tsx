import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { Store, Wrench, DollarSign, TrendingUp, BarChart3, Receipt } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function FinancePage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [carshopInvoices, setCarshopInvoices] = useState<any[]>([]);
  const [garageInvoices, setGarageInvoices] = useState<any[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // BC data should NOT use picker dates — fetch all available data
        const [carshop, garage, purchases] = await Promise.all([
          queryAll('bc_sales_invoices', 'id,invoice_date,customer_name,customer_number,total_amount_incl_tax', [{ column: 'dimension1_code', op: 'eq', value: 'CARSHOP' }]),
          queryAll('bc_sales_invoices', 'id,invoice_date,total_amount_incl_tax', [{ column: 'dimension1_code', op: 'eq', value: 'GARAGE' }]),
          queryAll('bc_purchase_invoices', 'id,posting_date,vendor_number,vendor_name,total_amount_incl_tax'),
        ]);
        if (!cancelled) { setCarshopInvoices(carshop); setGarageInvoices(garage); setPurchaseInvoices(purchases); }
      } catch (e) { console.error('Finance error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  const carshopRev = carshopInvoices.reduce((s, i) => s + (parseFloat(i.total_amount_incl_tax) || 0), 0);
  const garageRev = garageInvoices.reduce((s, i) => s + (parseFloat(i.total_amount_incl_tax) || 0), 0);
  const totalPurchase = purchaseInvoices.reduce((s, i) => s + (parseFloat(i.total_amount_incl_tax) || 0), 0);
  const totalBcRevenue = carshopRev + garageRev;
  const grossMargin = totalBcRevenue > 0 ? ((totalBcRevenue - totalPurchase) / totalBcRevenue) * 100 : 0;
  const avgCarshop = carshopInvoices.length > 0 ? carshopRev / carshopInvoices.length : 0;
  const avgGarage = garageInvoices.length > 0 ? garageRev / garageInvoices.length : 0;

  const monthlyRevenue = useMemo(() => {
    const map: Record<string, { carshop: number; garage: number }> = {};
    carshopInvoices.forEach((i) => { const m = i.invoice_date?.slice(0, 7); if (!m) return; if (!map[m]) map[m] = { carshop: 0, garage: 0 }; map[m].carshop += parseFloat(i.total_amount_incl_tax) || 0; });
    garageInvoices.forEach((i) => { const m = i.invoice_date?.slice(0, 7); if (!m) return; if (!map[m]) map[m] = { carshop: 0, garage: 0 }; map[m].garage += parseFloat(i.total_amount_incl_tax) || 0; });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, v]) => ({ month, ...v }));
  }, [carshopInvoices, garageInvoices]);

  const costVsRevenue = useMemo(() => {
    const salesMap: Record<string, number> = {};
    [...carshopInvoices, ...garageInvoices].forEach((i) => { const m = i.invoice_date?.slice(0, 7); if (m) salesMap[m] = (salesMap[m] || 0) + (parseFloat(i.total_amount_incl_tax) || 0); });
    const purchMap: Record<string, number> = {};
    purchaseInvoices.forEach((i) => { const m = i.posting_date?.slice(0, 7); if (m) purchMap[m] = (purchMap[m] || 0) + (parseFloat(i.total_amount_incl_tax) || 0); });
    const allMonths = new Set([...Object.keys(salesMap), ...Object.keys(purchMap)]);
    return Array.from(allMonths).sort().slice(-12).map((m) => ({ month: m, sales: salesMap[m] || 0, purchases: purchMap[m] || 0 }));
  }, [carshopInvoices, garageInvoices, purchaseInvoices]);

  const topVendors = useMemo(() => {
    const map: Record<string, { name: string; total: number }> = {};
    purchaseInvoices.forEach((i) => { const k = i.vendor_number || i.vendor_name || 'Unknown'; if (!map[k]) map[k] = { name: i.vendor_name || k, total: 0 }; map[k].total += parseFloat(i.total_amount_incl_tax) || 0; });
    return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [purchaseInvoices]);

  const topCarshopCustomers = useMemo(() => {
    const map: Record<string, { name: string; total: number }> = {};
    carshopInvoices.forEach((i) => { const k = i.customer_number || i.customer_name || 'Unknown'; if (!map[k]) map[k] = { name: i.customer_name || k, total: 0 }; map[k].total += parseFloat(i.total_amount_incl_tax) || 0; });
    return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [carshopInvoices]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="門店營收" subtitle="CARSHOP" value={formatCurrency(carshopRev)} icon={Store} loading={loading} testId="kpi-carshop" />
        <KpiCard title="車房營收" subtitle="GARAGE" value={formatCurrency(garageRev)} icon={Wrench} loading={loading} testId="kpi-garage" />
        <KpiCard title="採購成本" subtitle="Purchase" value={formatCurrency(totalPurchase)} icon={DollarSign} loading={loading} testId="kpi-purchase" />
        <KpiCard title="毛利率" subtitle="Margin" value={formatPercent(grossMargin)} icon={TrendingUp} loading={loading} testId="kpi-margin" />
        <KpiCard title="門店均單" subtitle="Avg CS" value={formatCurrency(avgCarshop)} icon={BarChart3} loading={loading} testId="kpi-avg-cs" />
        <KpiCard title="車房均單" subtitle="Avg GR" value={formatCurrency(avgGarage)} icon={Receipt} loading={loading} testId="kpi-avg-gr" />
      </div>

      <ChartCard title="月度營收" subtitle="CARSHOP vs GARAGE" loading={loading}>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={monthlyRevenue}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="carshop" name="CARSHOP" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
            <Bar dataKey="garage" name="GARAGE" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="採購 vs 銷售" subtitle="Cost vs Revenue Monthly" loading={loading}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={costVsRevenue}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Line type="monotone" dataKey="sales" name="Sales" stroke={CHART_COLORS.tertiary} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="purchases" name="Purchases" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Top 10 供應商" subtitle="By Purchase" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={topVendors} layout="vertical">
              <CartesianGrid {...GRID_STYLE} /><XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={100} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="total" fill={CHART_COLORS.fifth} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="門店客戶 Top 10" subtitle="CARSHOP Customers" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={topCarshopCustomers} layout="vertical">
              <CartesianGrid {...GRID_STYLE} /><XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={100} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="total" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
