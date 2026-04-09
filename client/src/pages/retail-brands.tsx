import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { Package, DollarSign, BarChart3, Tag, Hash, TrendingUp } from 'lucide-react';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function RetailBrandsPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [brands, setBrands] = useState<string[]>([]);
  const [orderLines, setOrderLines] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [bcInventory, setBcInventory] = useState<any[]>([]);
  const [purchaseDateMap, setPurchaseDateMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [orders, lines, inv, bcInv, purchaseLines, purchaseInvoices] = await Promise.all([
          queryWithDateRange('shopify_orders', 'id,created_at,financial_status,cancelled_at', 'created_at', bounds),
          queryAll('shopify_order_lines', 'order_id,title,sku,vendor,product_type,quantity,price,total_discount', undefined, 50000),
          queryAll('shopify_inventory', 'variant_id,product_title,vendor,price,inventory_quantity,sku', undefined, 50000),
          queryAll('bc_inventory', 'number,display_name,unit_price,unit_cost,item_category_code', undefined, 50000),
          queryAll('bc_purchase_invoice_lines', 'invoice_id,item_number', undefined, 50000),
          queryAll('bc_purchase_invoices', 'id,posting_date', undefined, 50000),
        ]);
        if (cancelled) return;

        const validIds = new Set(orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at).map((o: any) => o.id));
        const orderDateMap: Record<string, string> = {};
        orders.forEach((o: any) => { orderDateMap[o.id] = o.created_at; });
        const validLines = lines.filter((l: any) => validIds.has(l.order_id)).map((l: any) => ({ ...l, date: orderDateMap[l.order_id]?.slice(0, 7) || '' }));
        const brandSet = new Set<string>();
        validLines.forEach((l: any) => { if (l.vendor) brandSet.add(l.vendor); });

        setOrderLines(validLines);
        setInventory(inv);
        setBcInventory(bcInv);
        setBrands(Array.from(brandSet).sort());

        // Last purchase date per item
        const invoiceDateMap: Record<string, string> = {};
        purchaseInvoices.forEach((pi: any) => { invoiceDateMap[pi.id] = pi.posting_date; });
        const lpMap: Record<string, string> = {};
        purchaseLines.forEach((l: any) => {
          if (!l.item_number) return;
          const date = invoiceDateMap[l.invoice_id] || '';
          if (date && (!lpMap[l.item_number] || date > lpMap[l.item_number])) {
            lpMap[l.item_number] = date;
          }
        });
        setPurchaseDateMap(lpMap);
      } catch (e) { console.error('Brands error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  // BC cost map
  const bcCostMap = useMemo(() => {
    const map: Record<string, { unitPrice: number; unitCost: number }> = {};
    bcInventory.forEach((item: any) => {
      if (item.number) map[item.number] = { unitPrice: parseFloat(item.unit_price) || 0, unitCost: parseFloat(item.unit_cost) || 0 };
    });
    return map;
  }, [bcInventory]);

  const filtered = useMemo(() => selectedBrand === 'all' ? orderLines : orderLines.filter((l: any) => l.vendor === selectedBrand), [orderLines, selectedBrand]);
  const filteredInv = useMemo(() => selectedBrand === 'all' ? inventory : inventory.filter((i: any) => i.vendor === selectedBrand), [inventory, selectedBrand]);

  const unitsSold = filtered.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
  const revenue = filtered.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
  const avgPrice = unitsSold > 0 ? revenue / unitsSold : 0;
  const skuCount = new Set(filteredInv.map((i: any) => i.variant_id)).size;

  // Brand overview with GMROI
  const brandComparison = useMemo(() => {
    const map: Record<string, { skus: Set<string>; units: number; revenue: number; stock: number; stockQty: number; grossProfit: number; avgInvCost: number }> = {};
    orderLines.forEach((l: any) => {
      const b = l.vendor || 'Unknown';
      if (!map[b]) map[b] = { skus: new Set(), units: 0, revenue: 0, stock: 0, stockQty: 0, grossProfit: 0, avgInvCost: 0 };
      map[b].units += l.quantity || 0;
      const lineRev = (parseFloat(l.price) || 0) * (l.quantity || 0);
      map[b].revenue += lineRev;
      // Calculate gross profit if cost available
      const cost = bcCostMap[l.sku];
      if (cost && cost.unitCost > 0) {
        map[b].grossProfit += (parseFloat(l.price) - cost.unitCost) * (l.quantity || 0);
      }
    });
    inventory.forEach((i: any) => {
      const b = i.vendor || 'Unknown';
      if (!map[b]) map[b] = { skus: new Set(), units: 0, revenue: 0, stock: 0, stockQty: 0, grossProfit: 0, avgInvCost: 0 };
      map[b].skus.add(i.variant_id);
      map[b].stock += (parseFloat(i.price) || 0) * (i.inventory_quantity || 0);
      map[b].stockQty += i.inventory_quantity || 0;
      const cost = bcCostMap[i.sku];
      if (cost && cost.unitCost > 0) {
        map[b].avgInvCost += cost.unitCost * (i.inventory_quantity || 0);
      }
    });
    return Object.entries(map).map(([brand, d]) => ({
      brand,
      skus: d.skus.size,
      units: d.units,
      revenue: d.revenue,
      avgPrice: d.units > 0 ? d.revenue / d.units : 0,
      stockValue: d.stock,
      sellThrough: d.units + d.stockQty > 0 ? (d.units / (d.units + d.stockQty)) * 100 : 0,
      gmroi: d.avgInvCost > 0 ? d.grossProfit / d.avgInvCost : null,
    })).sort((a, b) => b.revenue - a.revenue).slice(0, 25);
  }, [orderLines, inventory, bcCostMap]);

  // Brand revenue chart
  const brandRevenue = useMemo(() => {
    const map: Record<string, number> = {};
    orderLines.forEach((l: any) => { const b = l.vendor || 'Unknown'; map[b] = (map[b] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, value]) => ({ name, value }));
  }, [orderLines]);

  const top5Brands = useMemo(() => brandRevenue.slice(0, 5).map((b) => b.name), [brandRevenue]);
  const brandTrend = useMemo(() => {
    const monthMap: Record<string, Record<string, number>> = {};
    orderLines.forEach((l: any) => { const m = l.date; const b = l.vendor || 'Unknown'; if (!m || !top5Brands.includes(b)) return; if (!monthMap[m]) monthMap[m] = {}; monthMap[m][b] = (monthMap[m][b] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0); });
    return Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, brands]) => ({ month, ...brands }));
  }, [orderLines, top5Brands]);

  // Brand product detail (when brand selected)
  const brandProductDetail = useMemo(() => {
    if (selectedBrand === 'all') return [];
    const map: Record<string, { title: string; sku: string; qty: number; revenue: number; unitCost: number | null; lastPurchase: string }> = {};
    filtered.forEach((l: any) => {
      const key = l.sku || l.title;
      if (!map[key]) {
        const cost = bcCostMap[l.sku];
        map[key] = { title: l.title, sku: l.sku || '', qty: 0, revenue: 0, unitCost: cost ? cost.unitCost : null, lastPurchase: purchaseDateMap[l.sku] || '' };
      }
      map[key].qty += l.quantity || 0;
      map[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).map((p) => {
      const avgSalePrice = p.qty > 0 ? p.revenue / p.qty : 0;
      const margin = p.unitCost !== null && avgSalePrice > 0 ? ((avgSalePrice - p.unitCost) / avgSalePrice) * 100 : null;
      return { ...p, avgSalePrice, margin };
    });
  }, [filtered, selectedBrand, bcCostMap, purchaseDateMap]);

  // Lineup (Series) analysis
  const lineupData = useMemo(() => {
    if (selectedBrand === 'all') return [];
    const map: Record<string, { series: string; skus: Set<string>; revenue: number; margins: number[]; stockValue: number }> = {};
    // Parse series from product title - get the word after vendor name
    const getSeries = (title: string) => {
      const parts = title.trim().split(/\s+/);
      // If the title starts with the brand name, take the next word
      if (parts.length > 1 && parts[0].toUpperCase() === selectedBrand.toUpperCase()) {
        return parts[1] || parts[0];
      }
      return parts.length > 1 ? parts[1] : parts[0];
    };

    filtered.forEach((l: any) => {
      const series = getSeries(l.title || '');
      if (!map[series]) map[series] = { series, skus: new Set(), revenue: 0, margins: [], stockValue: 0 };
      map[series].skus.add(l.sku || l.title);
      const lineRev = (parseFloat(l.price) || 0) * (l.quantity || 0);
      map[series].revenue += lineRev;
      const cost = bcCostMap[l.sku];
      if (cost && cost.unitCost > 0) {
        const margin = ((parseFloat(l.price) - cost.unitCost) / parseFloat(l.price)) * 100;
        map[series].margins.push(margin);
      }
    });
    // Add stock value
    filteredInv.forEach((i: any) => {
      const series = getSeries(i.product_title || '');
      if (map[series]) {
        map[series].stockValue += (parseFloat(i.price) || 0) * (i.inventory_quantity || 0);
      }
    });

    return Object.values(map).map((s) => ({
      series: s.series,
      skus: s.skus.size,
      revenue: s.revenue,
      avgMargin: s.margins.length > 0 ? s.margins.reduce((a, b) => a + b, 0) / s.margins.length : null,
      stockValue: s.stockValue,
    })).sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  }, [filtered, filteredInv, selectedBrand, bcCostMap]);

  // Price bands
  const priceBandAnalysis = useMemo(() => {
    const bands = [
      { label: '<$200', min: 0, max: 199.99 },
      { label: '$200-500', min: 200, max: 500 },
      { label: '$500-1K', min: 500.01, max: 1000 },
      { label: '$1K-2K', min: 1000.01, max: 2000 },
      { label: '$2K-5K', min: 2000.01, max: 5000 },
      { label: '$5K+', min: 5000.01, max: Infinity },
    ];
    const totalRev = filtered.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
    return bands.map((b) => {
      const matching = filtered.filter((l: any) => { const p = parseFloat(l.price) || 0; return p >= b.min && p <= b.max; });
      const units = matching.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
      const rev = matching.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
      return { name: b.label, units, revenue: rev, pctRevenue: totalRev > 0 ? (rev / totalRev) * 100 : 0 };
    });
  }, [filtered]);

  return (
    <div className="space-y-4">
      {/* Brand selector */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">品牌 Brand:</span>
        <Select value={selectedBrand} onValueChange={setSelectedBrand}>
          <SelectTrigger className="w-[200px] h-8 text-xs" data-testid="select-brand"><SelectValue placeholder="全部" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部品牌 All</SelectItem>
            {brands.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard title="售出件數" subtitle="Units" value={formatNumber(unitsSold)} icon={Package} loading={loading} testId="kpi-units" />
        <KpiCard title="營收" subtitle="Revenue" value={formatCurrency(revenue)} icon={DollarSign} loading={loading} testId="kpi-rev" />
        <KpiCard title="均價" subtitle="Avg Price" value={formatCurrency(avgPrice)} icon={BarChart3} loading={loading} testId="kpi-avg" />
        <KpiCard title="SKU" subtitle="Count" value={formatNumber(skuCount)} icon={Hash} loading={loading} testId="kpi-sku" />
        <KpiCard title="品牌數" subtitle="Brands" value={formatNumber(brands.length)} icon={Tag} loading={loading} testId="kpi-brands" />
      </div>

      {/* Section 1: Brand Overview Table with GMROI */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-medium">品牌比較 <span className="text-xs font-normal text-muted-foreground">Brand Comparison (with GMROI)</span></CardTitle></CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[300px] w-full" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-brands">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">品牌</th>
                    <th className="py-2 text-right font-medium">SKUs</th>
                    <th className="py-2 text-right font-medium">售出</th>
                    <th className="py-2 text-right font-medium">營收</th>
                    <th className="py-2 text-right font-medium">均價</th>
                    <th className="py-2 text-right font-medium">庫存值</th>
                    <th className="py-2 text-right font-medium">ST%</th>
                    <th className="py-2 text-right font-medium">GMROI</th>
                  </tr>
                </thead>
                <tbody>
                  {brandComparison.map((b) => (
                    <tr key={b.brand} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => setSelectedBrand(b.brand)}>
                      <td className="py-2 font-medium">{b.brand}</td>
                      <td className="py-2 text-right tabular-nums">{b.skus}</td>
                      <td className="py-2 text-right tabular-nums">{formatNumber(b.units)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(b.revenue)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(b.avgPrice)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(b.stockValue)}</td>
                      <td className="py-2 text-right tabular-nums">{formatPercent(b.sellThrough)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {b.gmroi !== null ? (
                          <span className={b.gmroi >= 2 ? 'text-emerald-400' : b.gmroi >= 1 ? 'text-amber-400' : 'text-red-400'}>
                            {b.gmroi.toFixed(2)}
                          </span>
                        ) : <span className="text-muted-foreground">N/A</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Brand Product Detail (when selected) */}
      {selectedBrand !== 'all' && (
        <Card className="border-border/40">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium">
              品牌產品詳情 <span className="text-xs font-normal text-muted-foreground">{selectedBrand} Product Detail</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {loading ? <Skeleton className="h-[300px] w-full" /> : brandProductDetail.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">無數據</p>
            ) : (
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-xs" data-testid="table-brand-detail">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border/50 text-muted-foreground">
                      <th className="py-2 text-left font-medium">產品 Title</th>
                      <th className="py-2 text-left font-medium">SKU</th>
                      <th className="py-2 text-right font-medium">數量 Qty</th>
                      <th className="py-2 text-right font-medium">營收 Revenue</th>
                      <th className="py-2 text-right font-medium">售價 Price</th>
                      <th className="py-2 text-right font-medium">成本 Cost</th>
                      <th className="py-2 text-right font-medium">毛利% Margin</th>
                      <th className="py-2 text-left font-medium">最後進貨</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brandProductDetail.map((p, i) => (
                      <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                        <td className="py-2 max-w-[200px] truncate">{p.title}</td>
                        <td className="py-2 font-mono text-[11px]">{p.sku || '—'}</td>
                        <td className="py-2 text-right tabular-nums">{p.qty}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                        <td className="py-2 text-right tabular-nums">{formatCurrency(p.avgSalePrice)}</td>
                        <td className="py-2 text-right tabular-nums">{p.unitCost !== null ? formatCurrency(p.unitCost) : <span className="text-muted-foreground">N/A</span>}</td>
                        <td className="py-2 text-right tabular-nums">
                          {p.margin !== null ? (
                            <span className={p.margin >= 40 ? 'text-emerald-400' : p.margin >= 20 ? 'text-amber-400' : 'text-red-400'}>
                              {formatPercent(p.margin)}
                            </span>
                          ) : <span className="text-muted-foreground">N/A</span>}
                        </td>
                        <td className="py-2 text-muted-foreground text-[11px]">{p.lastPurchase?.slice(0, 10) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Section 3: Lineup Analysis (when brand selected) */}
      {selectedBrand !== 'all' && lineupData.length > 0 && (
        <Card className="border-border/40">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-medium">
              系列分析 <span className="text-xs font-normal text-muted-foreground">{selectedBrand} Lineup Analysis</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-lineup">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">系列 Series</th>
                    <th className="py-2 text-right font-medium">SKUs</th>
                    <th className="py-2 text-right font-medium">營收 Revenue</th>
                    <th className="py-2 text-right font-medium">平均毛利% Avg Margin</th>
                    <th className="py-2 text-right font-medium">庫存值 Stock Value</th>
                  </tr>
                </thead>
                <tbody>
                  {lineupData.map((s, i) => (
                    <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 font-medium">{s.series}</td>
                      <td className="py-2 text-right tabular-nums">{s.skus}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(s.revenue)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {s.avgMargin !== null ? (
                          <span className={s.avgMargin >= 40 ? 'text-emerald-400' : s.avgMargin >= 20 ? 'text-amber-400' : 'text-red-400'}>
                            {formatPercent(s.avgMargin)}
                          </span>
                        ) : <span className="text-muted-foreground">N/A</span>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(s.stockValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Brand Revenue Chart + Trend */}
      <ChartCard title="品牌營收排名" subtitle="Top 15 by Revenue" loading={loading}>
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={brandRevenue} layout="vertical">
            <CartesianGrid {...GRID_STYLE} />
            <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={110} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="value" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="品牌趨勢 (Top 5)" subtitle="Monthly Trend" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={brandTrend}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="month" tick={AXIS_STYLE} />
              <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              {top5Brands.map((b, i) => <Area key={b} type="monotone" dataKey={b} stackId="1" stroke={CHART_PALETTE[i]} fill={CHART_PALETTE[i]} fillOpacity={0.3} />)}
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Section 4: Price Band */}
        <ChartCard title="價格帶分析" subtitle="Price Bands" loading={loading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={priceBandAnalysis} layout="vertical">
              <CartesianGrid {...GRID_STYLE} />
              <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={80} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="revenue" name="營收 Revenue" fill={CHART_COLORS.quaternary} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
