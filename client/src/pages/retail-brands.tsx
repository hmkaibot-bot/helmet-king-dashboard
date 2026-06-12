import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll, queryAllPages, queryInBatches, getProductMeta } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { Package, DollarSign, BarChart3, Tag, Hash, TrendingUp, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react';
import { BarChart, Bar, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { kpiStatus } from '@/lib/kpi-targets';

type DrillLevel = 'brands' | 'brand-detail' | 'product-detail';

export default function RetailBrandsPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [brands, setBrands] = useState<string[]>([]);
  const [orderLines, setOrderLines] = useState<any[]>([]);
  const [allOrders, setAllOrders] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [bcInventory, setBcInventory] = useState<any[]>([]);
  const [purchaseDateMap, setPurchaseDateMap] = useState<Record<string, string>>({});
  const [purchaseHistory, setPurchaseHistory] = useState<any[]>([]);

  // Drill-down state
  const [drillLevel, setDrillLevel] = useState<DrillLevel>('brands');
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [orders, inv, bcInv, purchaseLines, purchaseInvoices, productMeta] = await Promise.all([
          queryWithDateRange('shopify_orders', 'id,created_at,financial_status,cancelled_at', 'created_at', bounds),
          queryAllPages('shopify_inventory', 'variant_id,product_title,vendor,price,inventory_quantity,sku'),
          queryAllPages('bc_inventory', 'number,display_name,unit_price,unit_cost,item_category_code'),
          // 注意: column 叫 unit_cost (以前寫錯 direct_unit_cost,select 唔存在嘅欄
          // 令成個 Promise.all 死晒 → 成頁空白)
          queryAllPages('bc_purchase_invoice_lines', 'invoice_id,item_number,quantity,unit_cost'),
          queryAllPages('bc_purchase_invoices', 'id,posting_date,vendor_name'),
          getProductMeta(),
        ]);
        if (cancelled) return;

        // Pull lines via batched IN (avoids 1000-row Supabase cap)
        const orderIdsAll = orders.map((o: any) => String(o.id));
        const linesRaw = await queryInBatches(
          'shopify_order_lines',
          'order_id,product_id,title,sku,vendor,product_type,quantity,price,total_discount',
          'order_id',
          orderIdsAll
        );
        if (cancelled) return;
        // Backfill vendor / product_type from products meta
        const lines = linesRaw.map((l: any) => {
          const pm = productMeta[String(l.product_id || '')];
          return { ...l, vendor: l.vendor || pm?.vendor || '', product_type: l.product_type || pm?.product_type || '' };
        });

        const validIds = new Set(orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at).map((o: any) => o.id));
        const orderDateMap: Record<string, string> = {};
        orders.forEach((o: any) => { orderDateMap[o.id] = o.created_at; });
        const validLines = lines.filter((l: any) => validIds.has(l.order_id)).map((l: any) => ({ ...l, date: orderDateMap[l.order_id]?.slice(0, 10) || '', month: orderDateMap[l.order_id]?.slice(0, 7) || '' }));
        const brandSet = new Set<string>();
        validLines.forEach((l: any) => { if (l.vendor) brandSet.add(l.vendor); });

        setOrderLines(validLines);
        setAllOrders(orders);
        setInventory(inv);
        setBcInventory(bcInv);
        setBrands(Array.from(brandSet).sort());

        // Purchase invoice date map + history
        const invoiceDateMap: Record<string, { date: string; vendor: string }> = {};
        purchaseInvoices.forEach((pi: any) => { invoiceDateMap[pi.id] = { date: pi.posting_date, vendor: pi.vendor_name || '' }; });
        const lpMap: Record<string, string> = {};
        purchaseLines.forEach((l: any) => {
          if (!l.item_number) return;
          const date = invoiceDateMap[l.invoice_id]?.date || '';
          if (date && (!lpMap[l.item_number] || date > lpMap[l.item_number])) {
            lpMap[l.item_number] = date;
          }
        });
        setPurchaseDateMap(lpMap);

        // Store full purchase history for product drill-down
        const phist = purchaseLines.map((l: any) => ({
          item_number: l.item_number,
          quantity: l.quantity,
          unit_cost: l.unit_cost,
          date: invoiceDateMap[l.invoice_id]?.date || '',
          vendor: invoiceDateMap[l.invoice_id]?.vendor || '',
        }));
        setPurchaseHistory(phist);
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

  // ─── Level 1: All Brands ──────────────────────────────────────
  const brandComparison = useMemo(() => {
    const map: Record<string, { skus: Set<string>; units: number; revenue: number; stock: number; stockQty: number; grossProfit: number; avgInvCost: number }> = {};
    orderLines.forEach((l: any) => {
      const b = l.vendor || 'Unknown';
      if (!map[b]) map[b] = { skus: new Set(), units: 0, revenue: 0, stock: 0, stockQty: 0, grossProfit: 0, avgInvCost: 0 };
      map[b].units += l.quantity || 0;
      const lineRev = (parseFloat(l.price) || 0) * (l.quantity || 0);
      map[b].revenue += lineRev;
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
      marginPct: d.revenue > 0 ? (d.grossProfit / d.revenue) * 100 : null,
      gmroi: d.avgInvCost > 0 ? d.grossProfit / d.avgInvCost : null,
    })).sort((a, b) => b.revenue - a.revenue).slice(0, 25);
  }, [orderLines, inventory, bcCostMap]);

  const brandRevenue = useMemo(() => {
    const map: Record<string, number> = {};
    orderLines.forEach((l: any) => { const b = l.vendor || 'Unknown'; map[b] = (map[b] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0); });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, value]) => ({ name, value }));
  }, [orderLines]);

  const top5Brands = useMemo(() => brandRevenue.slice(0, 5).map((b) => b.name), [brandRevenue]);
  const brandTrend = useMemo(() => {
    const monthMap: Record<string, Record<string, number>> = {};
    orderLines.forEach((l: any) => { const m = l.month; const b = l.vendor || 'Unknown'; if (!m || !top5Brands.includes(b)) return; if (!monthMap[m]) monthMap[m] = {}; monthMap[m][b] = (monthMap[m][b] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0); });
    return Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, brands]) => ({ month, ...brands }));
  }, [orderLines, top5Brands]);

  // ─── Level 2: Brand Detail ──────────────────────────────────────
  const brandLines = useMemo(() => selectedBrand ? orderLines.filter((l: any) => l.vendor === selectedBrand) : [], [orderLines, selectedBrand]);
  const brandInv = useMemo(() => selectedBrand ? inventory.filter((i: any) => i.vendor === selectedBrand) : [], [inventory, selectedBrand]);

  const brandKpis = useMemo(() => {
    const units = brandLines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
    const revenue = brandLines.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
    let gp = 0;
    brandLines.forEach((l: any) => {
      const cost = bcCostMap[l.sku];
      if (cost && cost.unitCost > 0) gp += (parseFloat(l.price) - cost.unitCost) * (l.quantity || 0);
    });
    const marginPct = revenue > 0 ? (gp / revenue) * 100 : null;
    let invCost = 0;
    brandInv.forEach((i: any) => {
      const cost = bcCostMap[i.sku];
      if (cost && cost.unitCost > 0) invCost += cost.unitCost * (i.inventory_quantity || 0);
    });
    const gmroi = invCost > 0 ? gp / invCost : null;
    return { units, revenue, marginPct, gmroi, orders: new Set(brandLines.map((l: any) => l.order_id)).size };
  }, [brandLines, brandInv, bcCostMap]);

  const brandProductDetail = useMemo(() => {
    if (!selectedBrand) return [];
    const map: Record<string, { title: string; sku: string; skus: Set<string>; qty: number; revenue: number; unitCost: number | null; lastPurchase: string; stockQty: number }> = {};
    brandLines.forEach((l: any) => {
      const key = l.title || l.sku;
      if (!map[key]) {
        const cost = bcCostMap[l.sku];
        map[key] = { title: l.title, sku: l.sku || '', skus: new Set(), qty: 0, revenue: 0, unitCost: cost ? cost.unitCost : null, lastPurchase: purchaseDateMap[l.sku] || '', stockQty: 0 };
      }
      if (l.sku) map[key].skus.add(l.sku);
      map[key].qty += l.quantity || 0;
      map[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    // Add stock qty
    brandInv.forEach((i: any) => {
      const key = i.product_title || i.sku;
      if (map[key]) {
        map[key].stockQty += i.inventory_quantity || 0;
      }
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).map((p) => {
      const avgSalePrice = p.qty > 0 ? p.revenue / p.qty : 0;
      const margin = p.unitCost !== null && avgSalePrice > 0 ? ((avgSalePrice - p.unitCost) / avgSalePrice) * 100 : null;
      return { ...p, avgSalePrice, margin };
    });
  }, [brandLines, brandInv, selectedBrand, bcCostMap, purchaseDateMap]);

  // ─── Level 3: Product Detail ──────────────────────────────────
  const productLines = useMemo(() => selectedProduct ? brandLines.filter((l: any) => (l.title || l.sku) === selectedProduct) : [], [brandLines, selectedProduct]);

  const productKpis = useMemo(() => {
    const units = productLines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
    const revenue = productLines.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
    const sku = productLines[0]?.sku || '';
    const cost = bcCostMap[sku];
    const unitCost = cost?.unitCost || null;
    const avgPrice = units > 0 ? revenue / units : 0;
    const margin = unitCost !== null && avgPrice > 0 ? ((avgPrice - unitCost) / avgPrice) * 100 : null;
    const invItem = inventory.find((i: any) => i.product_title === selectedProduct || i.sku === sku);
    const stockQty = invItem?.inventory_quantity || 0;
    return { units, revenue, unitCost, avgPrice, margin, stockQty, sku };
  }, [productLines, selectedProduct, bcCostMap, inventory]);

  const productSalesTrend = useMemo(() => {
    const dayMap: Record<string, number> = {};
    productLines.forEach((l: any) => {
      const day = l.date;
      if (day) dayMap[day] = (dayMap[day] || 0) + (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.entries(dayMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, revenue]) => ({ date: date.slice(5), revenue }));
  }, [productLines]);

  const productPurchaseHist = useMemo(() => {
    if (!productKpis.sku) return [];
    return purchaseHistory
      .filter((h: any) => h.item_number === productKpis.sku && h.date)
      .sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 20);
  }, [purchaseHistory, productKpis.sku]);

  // Drill handlers
  const handleBrandClick = (brand: string) => {
    setSelectedBrand(brand);
    setSelectedProduct(null);
    setDrillLevel('brand-detail');
  };
  const handleProductClick = (productTitle: string) => {
    setSelectedProduct(productTitle);
    setDrillLevel('product-detail');
  };
  const handleBack = () => {
    if (drillLevel === 'product-detail') {
      setSelectedProduct(null);
      setDrillLevel('brand-detail');
    } else if (drillLevel === 'brand-detail') {
      setSelectedBrand(null);
      setDrillLevel('brands');
    }
  };

  // Summary KPIs for level 1
  const totalUnits = orderLines.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
  const totalRevenue = orderLines.reduce((s: number, l: any) => s + (parseFloat(l.price) || 0) * (l.quantity || 0), 0);
  const totalAvgPrice = totalUnits > 0 ? totalRevenue / totalUnits : 0;
  const skuCount = new Set(inventory.map((i: any) => i.variant_id)).size;

  return (
    <div className="space-y-4">
      {/* ── Breadcrumb Navigation ── */}
      {drillLevel !== 'brands' && (
        <div className="flex items-center gap-2 text-sm" data-testid="breadcrumb-nav">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleBack} data-testid="btn-back">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> 返回
          </Button>
          <span className="text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onClick={() => { setSelectedBrand(null); setSelectedProduct(null); setDrillLevel('brands'); }}>
            所有品牌
          </span>
          {selectedBrand && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={drillLevel === 'brand-detail' ? 'font-medium' : 'text-muted-foreground cursor-pointer hover:text-foreground transition-colors'}
                onClick={() => { if (drillLevel === 'product-detail') { setSelectedProduct(null); setDrillLevel('brand-detail'); } }}>
                {selectedBrand}
              </span>
            </>
          )}
          {selectedProduct && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium truncate max-w-[200px]">{selectedProduct}</span>
            </>
          )}
        </div>
      )}

      {/* ══════════ LEVEL 1: ALL BRANDS ══════════ */}
      {drillLevel === 'brands' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard title="售出件數" subtitle="Units" value={formatNumber(totalUnits)} icon={Package} loading={loading} testId="kpi-units" />
            <KpiCard title="營收" subtitle="Revenue" value={formatCurrency(totalRevenue)} icon={DollarSign} loading={loading} testId="kpi-rev" />
            <KpiCard title="均價" subtitle="Avg Price" value={formatCurrency(totalAvgPrice)} icon={BarChart3} loading={loading} testId="kpi-avg" />
            <KpiCard title="SKU" subtitle="Count" value={formatNumber(skuCount)} icon={Hash} loading={loading} testId="kpi-sku" />
            <KpiCard title="品牌數" subtitle="Brands" value={formatNumber(brands.length)} icon={Tag} loading={loading} testId="kpi-brands" />
          </div>

          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4"><CardTitle className="text-sm font-medium">品牌比較 <span className="text-xs font-normal text-muted-foreground">Brand Comparison — click a row to drill down</span></CardTitle></CardHeader>
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
                        <th className="py-2 text-right font-medium">毛利%</th>
                        <th className="py-2 text-right font-medium">庫存值</th>
                        <th className="py-2 text-right font-medium">ST%</th>
                        <th className="py-2 text-right font-medium">GMROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brandComparison.map((b) => (
                        <tr key={b.brand} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer group" onClick={() => handleBrandClick(b.brand)} data-testid={`brand-row-${b.brand}`}>
                          <td className="py-2 font-medium">
                            <div className="flex items-center gap-1">
                              {b.brand}
                              <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                          </td>
                          <td className="py-2 text-right tabular-nums">{b.skus}</td>
                          <td className="py-2 text-right tabular-nums">{formatNumber(b.units)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(b.revenue)}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(b.avgPrice)}</td>
                          <td className="py-2 text-right tabular-nums">
                            {b.marginPct !== null ? (
                              <span className={b.marginPct >= 40 ? 'text-emerald-400' : b.marginPct >= 20 ? 'text-amber-400' : 'text-red-400'}>
                                {formatPercent(b.marginPct)}
                              </span>
                            ) : <span className="text-muted-foreground">N/A</span>}
                          </td>
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
        </>
      )}

      {/* ══════════ LEVEL 2: BRAND DETAIL ══════════ */}
      {drillLevel === 'brand-detail' && selectedBrand && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard title="營收" subtitle="Revenue" value={formatCurrency(brandKpis.revenue)} icon={DollarSign} loading={loading} testId="brand-kpi-rev" />
            <KpiCard title="訂單" subtitle="Orders" value={formatNumber(brandKpis.orders)} icon={BarChart3} loading={loading} testId="brand-kpi-orders" />
            <KpiCard title="售出件數" subtitle="Units" value={formatNumber(brandKpis.units)} icon={Package} loading={loading} testId="brand-kpi-units" />
            <KpiCard title="毛利率" subtitle="Margin %" value={brandKpis.marginPct !== null ? formatPercent(brandKpis.marginPct) : 'N/A'} icon={TrendingUp} loading={loading} testId="brand-kpi-margin" />
            <KpiCard title="GMROI" subtitle="Gross Margin ROI" value={brandKpis.gmroi !== null ? brandKpis.gmroi.toFixed(2) : 'N/A'} icon={Hash} loading={loading} testId="brand-kpi-gmroi" />
          </div>

          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                {selectedBrand} 產品明細 <span className="text-xs font-normal text-muted-foreground">Product Detail — click a row to drill down</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[300px] w-full" /> : brandProductDetail.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">無數據</p>
              ) : (
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <table className="w-full text-xs" data-testid="table-brand-products">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">產品 Title</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-right font-medium">數量 Qty</th>
                        <th className="py-2 text-right font-medium">營收 Revenue</th>
                        <th className="py-2 text-right font-medium">毛利% Margin</th>
                        <th className="py-2 text-right font-medium">庫存 Stock</th>
                        <th className="py-2 text-left font-medium">最後進貨</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brandProductDetail.map((p, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer group" onClick={() => handleProductClick(p.title)} data-testid={`product-row-${i}`}>
                          <td className="py-2 max-w-[200px] truncate">
                            <div className="flex items-center gap-1">
                              {p.title}
                              <ChevronRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                            </div>
                          </td>
                          <td className="py-2 font-mono text-[11px]">{p.sku || '—'}</td>
                          <td className="py-2 text-right tabular-nums">{p.qty}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                          <td className="py-2 text-right tabular-nums">
                            {p.margin !== null ? (
                              <span className={p.margin >= 40 ? 'text-emerald-400' : p.margin >= 20 ? 'text-amber-400' : 'text-red-400'}>
                                {formatPercent(p.margin)}
                              </span>
                            ) : <span className="text-muted-foreground">N/A</span>}
                          </td>
                          <td className="py-2 text-right tabular-nums">{p.stockQty || 0}</td>
                          <td className="py-2 text-muted-foreground text-[11px]">{p.lastPurchase?.slice(0, 10) || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ══════════ LEVEL 3: PRODUCT DETAIL ══════════ */}
      {drillLevel === 'product-detail' && selectedProduct && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard title="售出件數" subtitle="Units Sold" value={formatNumber(productKpis.units)} icon={Package} loading={loading} testId="prod-kpi-units" />
            <KpiCard title="營收" subtitle="Revenue" value={formatCurrency(productKpis.revenue)} icon={DollarSign} loading={loading} testId="prod-kpi-rev" />
            <KpiCard title="毛利率" subtitle="Margin %" value={productKpis.margin !== null ? formatPercent(productKpis.margin) : 'N/A'} icon={TrendingUp} loading={loading} testId="prod-kpi-margin" />
            <KpiCard title="庫存" subtitle="Stock" value={formatNumber(productKpis.stockQty)} icon={Hash} loading={loading} testId="prod-kpi-stock" />
            <KpiCard title="成本" subtitle="Unit Cost" value={productKpis.unitCost !== null ? formatCurrency(productKpis.unitCost) : 'N/A'} icon={Tag} loading={loading} testId="prod-kpi-cost" />
          </div>

          {/* Sales trend chart */}
          <ChartCard title="銷售趨勢" subtitle={`${selectedProduct} — Daily Revenue`} loading={loading}>
            {productSalesTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={productSalesTrend}>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="date" tick={AXIS_STYLE} />
                  <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
                  <Line type="monotone" dataKey="revenue" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">無每日數據</p>
            )}
          </ChartCard>

          {/* Procurement history */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">進貨紀錄 <span className="text-xs font-normal text-muted-foreground">Procurement History (BC Purchase Invoices)</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {productPurchaseHist.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">無進貨紀錄 (SKU: {productKpis.sku || 'N/A'})</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-procurement">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">日期 Date</th>
                        <th className="py-2 text-left font-medium">供應商 Vendor</th>
                        <th className="py-2 text-right font-medium">數量 Qty</th>
                        <th className="py-2 text-right font-medium">單價 Unit Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productPurchaseHist.map((h: any, i: number) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                          <td className="py-2">{h.date?.slice(0, 10) || '—'}</td>
                          <td className="py-2 text-muted-foreground">{h.vendor || '—'}</td>
                          <td className="py-2 text-right tabular-nums">{h.quantity || 0}</td>
                          <td className="py-2 text-right tabular-nums">{h.unit_cost ? formatCurrency(parseFloat(h.unit_cost)) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
