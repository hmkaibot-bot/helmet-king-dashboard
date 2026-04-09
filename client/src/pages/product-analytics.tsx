import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import {
  BarChart, Bar, ScatterChart, Scatter, ZAxis,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Package, TrendingUp, TrendingDown, Clock, DollarSign,
  ShoppingCart, Layers, Zap, AlertTriangle,
} from 'lucide-react';

// ── Category helpers ─────────────────────────────────────

function getCategoryGroup(productType: string | null | undefined): string {
  const pt = (productType || '').toUpperCase();
  if (pt.startsWith('HELMET')) return 'HELMET';
  if (pt.startsWith('RIDER GEARS')) return 'RIDER GEARS';
  if (pt.startsWith('ACCESSORIES')) return 'ACCESSORIES';
  if (pt.startsWith('MOTORCYCLE PARTS')) return 'MOTORCYCLE PARTS';
  return 'Other';
}

const CATEGORY_COLORS: Record<string, string> = {
  'HELMET': '#f59e0b',
  'RIDER GEARS': '#3b82f6',
  'ACCESSORIES': '#10b981',
  'MOTORCYCLE PARTS': '#8b5cf6',
  'Other': '#6b7280',
};

const CATEGORY_GROUPS = ['HELMET', 'RIDER GEARS', 'ACCESSORIES', 'MOTORCYCLE PARTS', 'Other'];

function daysDiff(dateStr: string): number {
  return Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 86400000);
}

// ── Custom Tooltip for Scatter ───────────────────────────

function ScatterTooltipContent({ active, payload }: any) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div style={TOOLTIP_STYLE.contentStyle}>
      <p style={{ fontWeight: 600, marginBottom: 4, color: '#fff', fontSize: 12 }}>{d.title}</p>
      <p style={TOOLTIP_STYLE.itemStyle}>Price: {formatCurrency(d.x)}</p>
      <p style={TOOLTIP_STYLE.itemStyle}>30d Velocity: {(d.velocity || 0).toFixed(2)}/day</p>
      <p style={TOOLTIP_STYLE.itemStyle}>Stock Qty: {formatNumber(d.qty)}</p>
      <p style={TOOLTIP_STYLE.itemStyle}>Stock Value: {formatCurrency(d.stockValue)}</p>
      <p style={TOOLTIP_STYLE.itemStyle}>Category: {d.category}</p>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────

export default function ProductAnalytics() {
  // Phase 1 data
  const [orderLines, setOrderLines] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [phase1Loading, setPhase1Loading] = useState(true);

  // Phase 2 data
  const [purchaseInvoices, setPurchaseInvoices] = useState<any[]>([]);
  const [purchaseLines, setPurchaseLines] = useState<any[]>([]);
  const [bcInventory, setBcInventory] = useState<any[]>([]);
  const [phase2Loading, setPhase2Loading] = useState(true);

  // UI state
  const [scatterFilter, setScatterFilter] = useState<string>('所有');
  const [salesOverviewTab, setSalesOverviewTab] = useState<'category' | 'product'>('category');
  const [growthToggle, setGrowthToggle] = useState<'category' | 'brand'>('category');
  const [productSortBy, setProductSortBy] = useState<'revenue' | 'qty'>('revenue');

  // ── Data loading ─────────────────────────────────────

  useEffect(() => {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000).toISOString();

    async function loadPhase1() {
      const [ol, inv] = await Promise.all([
        queryAllPages('shopify_order_lines', 'order_id,product_id,title,sku,vendor,quantity,price,product_type,created_at'),
        queryAllPages('shopify_inventory', 'product_id,sku,product_title,price,inventory_quantity,vendor,product_type'),
      ]);
      const { data: ord } = await supabase
        .from('shopify_orders')
        .select('id,created_at,total_price,financial_status,cancelled_at')
        .gte('created_at', sixtyDaysAgo)
        .limit(5000);
      setOrderLines(ol);
      setInventory(inv);
      setOrders(ord || []);
      setPhase1Loading(false);
    }

    async function loadPhase2() {
      const [pi, pl, bci] = await Promise.all([
        queryAllPages('bc_purchase_invoices', 'id,vendor_name,posting_date,invoice_date'),
        queryAllPages('bc_purchase_invoice_lines', 'invoice_id,item_number,description,quantity,unit_cost,expected_receipt_date'),
        queryAllPages('bc_inventory', 'number,unit_price,unit_cost'),
      ]);
      setPurchaseInvoices(pi);
      setPurchaseLines(pl);
      setBcInventory(bci);
      setPhase2Loading(false);
    }

    loadPhase1();
    loadPhase2();
  }, []);

  // ── Tab 1: Product Map ───────────────────────────────

  const velocityMap = useMemo(() => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const counts: Record<string, number> = {};
    orderLines.forEach(line => {
      if (line.created_at >= thirtyDaysAgo) {
        const key = line.sku || line.product_id;
        if (key) counts[key] = (counts[key] || 0) + (line.quantity || 0);
      }
    });
    const result: Record<string, number> = {};
    Object.entries(counts).forEach(([key, qty]) => { result[key] = qty / 30; });
    return result;
  }, [orderLines]);

  const inventoryMap = useMemo(() => {
    const map: Record<string, any> = {};
    inventory.forEach(item => {
      const key = item.sku || item.product_id;
      if (key && !map[key]) {
        map[key] = {
          qty: item.inventory_quantity || 0,
          price: parseFloat(item.price) || 0,
          vendor: item.vendor || '',
          product_type: item.product_type || '',
          title: item.product_title || '',
          product_id: item.product_id,
        };
      }
    });
    return map;
  }, [inventory]);

  const scatterDataByGroup = useMemo(() => {
    const groups: Record<string, any[]> = {
      'HELMET': [], 'RIDER GEARS': [], 'ACCESSORIES': [], 'MOTORCYCLE PARTS': [], 'Other': [],
    };
    Object.entries(inventoryMap).forEach(([key, item]) => {
      const price = item.price;
      if (price <= 0 || price > 8000) return;
      const velocity = Math.min(velocityMap[key] || 0, 5);
      const stockValue = item.qty * price;
      const category = getCategoryGroup(item.product_type);
      const bubbleSize = Math.max(20, Math.min(400, stockValue / 200 + 20));
      groups[category].push({
        x: price,
        y: velocity,
        z: bubbleSize,
        title: item.title,
        vendor: item.vendor,
        qty: item.qty,
        stockValue,
        velocity,
        category,
        key,
      });
    });
    return groups;
  }, [inventoryMap, velocityMap]);

  const filteredScatterGroups = useMemo(() => {
    if (scatterFilter === '所有') return scatterDataByGroup;
    const result: Record<string, any[]> = {};
    result[scatterFilter] = scatterDataByGroup[scatterFilter] || [];
    return result;
  }, [scatterDataByGroup, scatterFilter]);

  // Revenue by category (60d)
  const revByCategory = useMemo(() => {
    const map: Record<string, number> = {};
    orderLines.forEach(line => {
      const cat = getCategoryGroup(line.product_type);
      map[cat] = (map[cat] || 0) + (line.quantity || 0) * parseFloat(line.price || 0);
    });
    return Object.entries(map)
      .map(([name, revenue]) => ({ name, revenue }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [orderLines]);

  // Top 50 products by revenue
  const topProductsData = useMemo(() => {
    const map: Record<string, { title: string; vendor: string; category: string; qty: number; revenue: number; prices: number[] }> = {};
    orderLines.forEach(line => {
      const key = String(line.product_id || line.sku || '');
      if (!key) return;
      const price = parseFloat(line.price || 0);
      if (map[key]) {
        map[key].qty += line.quantity || 0;
        map[key].revenue += (line.quantity || 0) * price;
        map[key].prices.push(price);
      } else {
        map[key] = {
          title: line.title || '',
          vendor: line.vendor || '',
          category: getCategoryGroup(line.product_type),
          qty: line.quantity || 0,
          revenue: (line.quantity || 0) * price,
          prices: [price],
        };
      }
    });
    return Object.values(map)
      .sort((a, b) => productSortBy === 'revenue' ? b.revenue - a.revenue : b.qty - a.qty)
      .slice(0, 50)
      .map(p => ({
        ...p,
        avgPrice: p.prices.length > 0 ? p.prices.reduce((a, b) => a + b, 0) / p.prices.length : 0,
      }));
  }, [orderLines, productSortBy]);

  // ── Tab 2: Growth Analysis ───────────────────────────

  const { periodALines, periodBLines } = useMemo(() => {
    const now = Date.now();
    const thirtyDaysAgoStr = new Date(now - 30 * 86400000).toISOString();
    const sixtyDaysAgoStr = new Date(now - 60 * 86400000).toISOString();
    return {
      periodALines: orderLines.filter(l => l.created_at >= sixtyDaysAgoStr && l.created_at < thirtyDaysAgoStr),
      periodBLines: orderLines.filter(l => l.created_at >= thirtyDaysAgoStr),
    };
  }, [orderLines]);

  const growthByCategoryData = useMemo(() => {
    const mapA: Record<string, number> = {};
    const mapB: Record<string, number> = {};
    periodALines.forEach(line => {
      const cat = getCategoryGroup(line.product_type);
      mapA[cat] = (mapA[cat] || 0) + (line.quantity || 0) * parseFloat(line.price || 0);
    });
    periodBLines.forEach(line => {
      const cat = getCategoryGroup(line.product_type);
      mapB[cat] = (mapB[cat] || 0) + (line.quantity || 0) * parseFloat(line.price || 0);
    });
    const allCats = Array.from(new Set([...Object.keys(mapA), ...Object.keys(mapB)]));
    return allCats.map(cat => {
      const a = mapA[cat] || 0;
      const b = mapB[cat] || 0;
      const delta = b - a;
      const pct = a > 0 ? (delta / a) * 100 : b > 0 ? 100 : 0;
      return { name: cat, periodA: a, periodB: b, delta, pct };
    }).sort((a, b) => b.delta - a.delta);
  }, [periodALines, periodBLines]);

  const growthByBrandData = useMemo(() => {
    const mapA: Record<string, number> = {};
    const mapB: Record<string, number> = {};
    periodALines.forEach(line => {
      const v = line.vendor || 'Unknown';
      mapA[v] = (mapA[v] || 0) + (line.quantity || 0) * parseFloat(line.price || 0);
    });
    periodBLines.forEach(line => {
      const v = line.vendor || 'Unknown';
      mapB[v] = (mapB[v] || 0) + (line.quantity || 0) * parseFloat(line.price || 0);
    });
    const allBrands = Array.from(new Set([...Object.keys(mapA), ...Object.keys(mapB)]));
    return allBrands.map(brand => {
      const a = mapA[brand] || 0;
      const b = mapB[brand] || 0;
      const delta = b - a;
      const pct = a > 0 ? (delta / a) * 100 : b > 0 ? 100 : 0;
      return { name: brand, periodA: a, periodB: b, delta, pct };
    }).sort((a, b) => b.delta - a.delta);
  }, [periodALines, periodBLines]);

  const activeGrowthData = growthToggle === 'category' ? growthByCategoryData : growthByBrandData;

  const top5Growers = useMemo(() =>
    [...activeGrowthData].sort((a, b) => b.delta - a.delta).slice(0, 5),
    [activeGrowthData]);

  const top5Decliners = useMemo(() =>
    [...activeGrowthData].sort((a, b) => a.delta - b.delta).slice(0, 5),
    [activeGrowthData]);

  // ── Tab 3: Bundle Analysis ───────────────────────────

  const bundleAnalysis = useMemo(() => {
    // Build order → product_ids map using plain objects
    const orderProductsMap: Record<string, Record<string, boolean>> = {};
    const orderItemsMap: Record<string, any[]> = {};
    orderLines.forEach(line => {
      const oid = String(line.order_id);
      if (!orderProductsMap[oid]) {
        orderProductsMap[oid] = {};
        orderItemsMap[oid] = [];
      }
      const pid = String(line.product_id || line.sku || '');
      if (pid) orderProductsMap[oid][pid] = true;
      orderItemsMap[oid].push(line);
    });

    // Classify orders
    const orderMeta: Record<string, { total_price: number; is_bundle: boolean }> = {};
    orders.forEach(order => {
      const oid = String(order.id);
      const products = orderProductsMap[oid];
      const isBundle = products ? Object.keys(products).length >= 2 : false;
      orderMeta[oid] = {
        total_price: parseFloat(order.total_price || 0),
        is_bundle: isBundle,
      };
    });

    let bundleCount = 0, singleCount = 0;
    let bundleRevSum = 0, singleRevSum = 0;
    const bundleSizeMap: Record<number, number> = {};

    Object.entries(orderMeta).forEach(([oid, meta]) => {
      const products = orderProductsMap[oid];
      const size = products ? Object.keys(products).length : 1;
      if (meta.is_bundle) {
        bundleCount++;
        bundleRevSum += meta.total_price;
        bundleSizeMap[size] = (bundleSizeMap[size] || 0) + 1;
      } else {
        singleCount++;
        singleRevSum += meta.total_price;
      }
    });

    const totalOrders = bundleCount + singleCount;
    const bundleRate = totalOrders > 0 ? (bundleCount / totalOrders) * 100 : 0;
    const bundleAOV = bundleCount > 0 ? bundleRevSum / bundleCount : 0;
    const singleAOV = singleCount > 0 ? singleRevSum / singleCount : 0;
    const revenueLift = singleAOV > 0 ? ((bundleAOV - singleAOV) / singleAOV) * 100 : 0;

    // Bundle size distribution
    const bundleSizeData = Object.entries(bundleSizeMap).map(([sizeStr, count]) => {
      const size = parseInt(sizeStr, 10);
      return {
        name: size === 2 ? '2-item' : size === 3 ? '3-item' : `${size}-item+`,
        value: count,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Co-purchase pairs (product_type pairs)
    const pairMap: Record<string, { count: number; totalValue: number }> = {};
    Object.entries(orderMeta).forEach(([oid, meta]) => {
      if (!meta.is_bundle) return;
      const lines = orderItemsMap[oid] || [];
      const typeSet = new Set(lines.map((l: any) => getCategoryGroup(l.product_type)));
      const types = Array.from(typeSet);
      for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
          const pair = [types[i], types[j]].sort().join(' + ');
          if (!pairMap[pair]) pairMap[pair] = { count: 0, totalValue: 0 };
          pairMap[pair].count++;
          pairMap[pair].totalValue += meta.total_price;
        }
      }
    });

    const pairsData = Object.entries(pairMap)
      .map(([pair, { count, totalValue }]) => ({
        pair,
        catA: pair.split(' + ')[0],
        catB: pair.split(' + ')[1],
        count,
        avgValue: count > 0 ? totalValue / count : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const topPair = pairsData[0] || null;

    return {
      bundleRate,
      bundleAOV,
      singleAOV,
      revenueLift,
      bundleCount,
      singleCount,
      bundleSizeData,
      pairsData,
      topPair,
    };
  }, [orderLines, orders]);

  // ── Tab 4: Lead Time ─────────────────────────────────

  const leadTimeData = useMemo(() => {
    if (phase2Loading) return { vendorData: [], itemData: [], avgLeadTime: 0, maxLeadTime: 0, longLeadVendors: 0 };

    // vendor lead times
    const vendorMap: Record<string, number[]> = {};
    purchaseInvoices.forEach(inv => {
      if (!inv.invoice_date || !inv.posting_date) return;
      const diff = daysDiff(inv.invoice_date) - daysDiff(inv.posting_date);
      if (diff <= 0) return;
      const v = inv.vendor_name || 'Unknown';
      if (!vendorMap[v]) vendorMap[v] = [];
      vendorMap[v].push(diff);
    });

    const vendorData = Object.entries(vendorMap)
      .map(([vendor, diffs]) => {
        const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        return { vendor, avgLeadTime: Math.round(avg), count: diffs.length };
      })
      .sort((a, b) => b.avgLeadTime - a.avgLeadTime)
      .slice(0, 15)
      .map(d => ({
        ...d,
        color: d.avgLeadTime > 60 ? '#ef4444' : d.avgLeadTime > 30 ? '#f59e0b' : '#10b981',
      }));

    // Build invoice lookup for lead time calc
    const invoiceLeadMap: Record<string, number> = {};
    purchaseInvoices.forEach(inv => {
      if (!inv.invoice_date || !inv.posting_date) return;
      const diff = daysDiff(inv.invoice_date) - daysDiff(inv.posting_date);
      if (diff > 0) invoiceLeadMap[String(inv.id)] = diff;
    });

    // Item lead times
    const itemMap: Record<string, { description: string; diffs: number[] }> = {};
    purchaseLines.forEach(line => {
      const lt = invoiceLeadMap[String(line.invoice_id)];
      if (!lt) return;
      const key = line.item_number || '';
      if (!key) return;
      if (!itemMap[key]) itemMap[key] = { description: line.description || key, diffs: [] };
      itemMap[key].diffs.push(lt);
    });

    const itemData = Object.entries(itemMap)
      .map(([item_number, { description, diffs }]) => ({
        item_number,
        description,
        avgLeadTime: Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length),
        count: diffs.length,
      }))
      .sort((a, b) => b.avgLeadTime - a.avgLeadTime)
      .slice(0, 20);

    const allLeadTimes = Object.values(invoiceLeadMap);
    const avgLeadTime = allLeadTimes.length > 0
      ? Math.round(allLeadTimes.reduce((a, b) => a + b, 0) / allLeadTimes.length)
      : 0;
    const maxLeadTime = allLeadTimes.length > 0 ? Math.max(...allLeadTimes) : 0;
    const longLeadVendors = vendorData.filter(v => v.avgLeadTime > 60).length;

    return { vendorData, itemData, avgLeadTime, maxLeadTime, longLeadVendors };
  }, [purchaseInvoices, purchaseLines, phase2Loading]);

  // ── Tab 5: Capital Efficiency ────────────────────────

  const capitalData = useMemo(() => {
    if (phase2Loading) return {
      topLocked: [], fastMovers: [],
      totalSlowCapital: 0, totalFastCapital: 0,
      mostEfficientBrand: '', riskiestSku: '',
    };

    // Build cost map from bc_inventory
    const costMap: Record<string, number> = {};
    bcInventory.forEach(item => {
      costMap[(item.number || '').toString()] = parseFloat(item.unit_cost || 0);
    });

    // Build last purchase date per item
    const invoiceDateMap: Record<string, string> = {};
    purchaseInvoices.forEach(inv => {
      invoiceDateMap[String(inv.id)] = inv.posting_date || '';
    });

    const lastPurchaseMap: Record<string, string> = {};
    purchaseLines.forEach(line => {
      const postingDate = invoiceDateMap[String(line.invoice_id)];
      if (!postingDate || !line.item_number) return;
      const key = String(line.item_number);
      if (!lastPurchaseMap[key] || postingDate > lastPurchaseMap[key]) {
        lastPurchaseMap[key] = postingDate;
      }
    });

    // Build velocity map (30d)
    const velocityMap30: Record<string, number> = {};
    const thirtyDaysAgoStr = new Date(Date.now() - 30 * 86400000).toISOString();
    orderLines.forEach(line => {
      if (line.created_at >= thirtyDaysAgoStr) {
        const key = line.sku || '';
        if (key) velocityMap30[key] = (velocityMap30[key] || 0) + (line.quantity || 0);
      }
    });

    // Build 60d revenue per SKU
    const revenue60Map: Record<string, number> = {};
    orderLines.forEach(line => {
      const key = line.sku || '';
      if (key) revenue60Map[key] = (revenue60Map[key] || 0) + (line.quantity || 0) * parseFloat(line.price || 0);
    });

    const products: any[] = [];
    inventory.forEach(item => {
      const sku = item.sku || '';
      const qty = item.inventory_quantity || 0;
      const price = parseFloat(item.price || 0);
      if (qty <= 0 || price <= 0) return;

      const costFromBC = costMap[sku] || costMap[item.product_id] || 0;
      const unitCost = costFromBC > 0 ? costFromBC : price * 0.55;
      const capitalValue = unitCost * qty;

      const lastPurchase = lastPurchaseMap[sku] || lastPurchaseMap[item.product_id];
      const daysOnShelf = lastPurchase ? Math.max(0, daysDiff(lastPurchase)) : 90;
      const capitalScore = capitalValue * Math.log(Math.max(daysOnShelf, 1));
      const soldQty30 = velocityMap30[sku] || 0;
      const turns30d = soldQty30 / Math.max(qty, 1);
      const revenue60d = revenue60Map[sku] || 0;

      products.push({
        sku,
        title: item.product_title || '',
        vendor: item.vendor || '',
        qty,
        unitCost,
        capitalValue,
        daysOnShelf,
        capitalScore,
        turns30d,
        soldQty30,
        revenue60d,
        revPerCapital: capitalValue > 0 ? revenue60d / capitalValue : 0,
      });
    });

    const topLocked = [...products].sort((a, b) => b.capitalScore - a.capitalScore).slice(0, 20);
    const fastMovers = [...products].sort((a, b) => b.turns30d - a.turns30d).slice(0, 20);

    const slowProducts = products.filter(p => p.daysOnShelf > 90);
    const fastProducts = products.filter(p => p.daysOnShelf < 30);
    const totalSlowCapital = slowProducts.reduce((s, p) => s + p.capitalValue, 0);
    const totalFastCapital = fastProducts.reduce((s, p) => s + p.capitalValue, 0);

    // Most efficient brand
    const brandRevMap: Record<string, number> = {};
    const brandCapMap: Record<string, number> = {};
    products.forEach(p => {
      brandRevMap[p.vendor] = (brandRevMap[p.vendor] || 0) + p.revenue60d;
      brandCapMap[p.vendor] = (brandCapMap[p.vendor] || 0) + p.capitalValue;
    });

    let mostEfficientBrand = '';
    let bestRatio = 0;
    Object.entries(brandRevMap).forEach(([brand, rev]) => {
      const cap = brandCapMap[brand] || 1;
      const ratio = rev / cap;
      if (ratio > bestRatio) { bestRatio = ratio; mostEfficientBrand = brand; }
    });

    const riskiest = topLocked[0];
    const riskiestSku = riskiest ? riskiest.title.slice(0, 30) + (riskiest.title.length > 30 ? '…' : '') : '';

    return { topLocked, fastMovers, totalSlowCapital, totalFastCapital, mostEfficientBrand, riskiestSku };
  }, [bcInventory, purchaseInvoices, purchaseLines, inventory, orderLines, phase2Loading]);

  // ── Render ─────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">商品分析 Product Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">Product performance, growth trends, bundle insights, and capital efficiency</p>
      </div>

      <Tabs defaultValue="product-map" className="space-y-4">
        <TabsList className="grid grid-cols-5 w-full">
          <TabsTrigger value="product-map">商品地圖</TabsTrigger>
          <TabsTrigger value="growth">增跌分析</TabsTrigger>
          <TabsTrigger value="bundles">組合銷售</TabsTrigger>
          <TabsTrigger value="lead-time">到貨周期</TabsTrigger>
          <TabsTrigger value="capital">資金效率</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Product Map ── */}
        <TabsContent value="product-map" className="space-y-4">
          {phase1Loading ? (
            <div className="space-y-4">
              <Skeleton className="h-[500px] w-full" />
              <Skeleton className="h-[300px] w-full" />
            </div>
          ) : (
            <>
              {/* Filter buttons */}
              <div className="flex gap-2 flex-wrap">
                {(['所有', ...CATEGORY_GROUPS]).map(cat => (
                  <button
                    key={cat}
                    onClick={() => setScatterFilter(cat)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      scatterFilter === cat
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    }`}
                    style={
                      scatterFilter === cat && cat !== '所有'
                        ? { backgroundColor: CATEGORY_COLORS[cat], color: '#fff' }
                        : {}
                    }
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <ChartCard
                title="商品地圖 Product Map"
                subtitle="Bubble = inventory value. X = price, Y = 30d velocity"
              >
                <ResponsiveContainer width="100%" height={480}>
                  <ScatterChart margin={{ top: 20, right: 20, bottom: 30, left: 20 }}>
                    <CartesianGrid {...GRID_STYLE} />
                    <XAxis
                      dataKey="x"
                      type="number"
                      name="Price"
                      domain={[0, 5000]}
                      tickFormatter={(v: number) => `HK$${v}`}
                      tick={AXIS_STYLE}
                      label={{ value: 'Price (HKD)', position: 'insideBottom', offset: -15, fill: AXIS_STYLE.fill, fontSize: 11 }}
                    />
                    <YAxis
                      dataKey="y"
                      type="number"
                      name="Velocity"
                      domain={[0, 5.5]}
                      tickFormatter={(v: number) => `${v}/d`}
                      tick={AXIS_STYLE}
                      label={{ value: '30d Velocity (units/day)', angle: -90, position: 'insideLeft', fill: AXIS_STYLE.fill, fontSize: 11 }}
                    />
                    <ZAxis dataKey="z" range={[20, 400]} />
                    <Tooltip content={<ScatterTooltipContent />} />
                    <Legend
                      wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                      formatter={(value: string) => <span style={{ color: CATEGORY_COLORS[value] || '#6b7280' }}>{value}</span>}
                    />
                    {Object.entries(filteredScatterGroups).map(([cat, data]) => (
                      <Scatter
                        key={cat}
                        name={cat}
                        data={data}
                        fill={CATEGORY_COLORS[cat] || '#6b7280'}
                        fillOpacity={0.7}
                      />
                    ))}
                  </ScatterChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* Sales Overview */}
              <Card className="border-border/40">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-medium">銷售概覽 Sales Overview (60d)</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => setSalesOverviewTab('category')}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${salesOverviewTab === 'category' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}
                    >
                      按類別 By Category
                    </button>
                    <button
                      onClick={() => setSalesOverviewTab('product')}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${salesOverviewTab === 'product' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}
                    >
                      按產品 By Product
                    </button>
                    {salesOverviewTab === 'product' && (
                      <button
                        onClick={() => setProductSortBy(s => s === 'revenue' ? 'qty' : 'revenue')}
                        className="ml-auto px-3 py-1 rounded text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80"
                      >
                        Sort: {productSortBy === 'revenue' ? 'Revenue' : 'Qty'}
                      </button>
                    )}
                  </div>

                  {salesOverviewTab === 'category' ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={revByCategory} layout="vertical" margin={{ left: 20, right: 20 }}>
                        <CartesianGrid {...GRID_STYLE} horizontal={false} />
                        <XAxis type="number" tickFormatter={(v: number) => formatCurrency(v)} tick={AXIS_STYLE} />
                        <YAxis type="category" dataKey="name" tick={AXIS_STYLE} width={130} />
                        <Tooltip
                          contentStyle={TOOLTIP_STYLE.contentStyle}
                          itemStyle={TOOLTIP_STYLE.itemStyle}
                          labelStyle={TOOLTIP_STYLE.labelStyle}
                          formatter={(v: number) => [formatCurrency(v), 'Revenue']}
                        />
                        <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                          {revByCategory.map((entry, i) => (
                            <Cell key={i} fill={CATEGORY_COLORS[entry.name] || DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="overflow-auto max-h-[400px]">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground border-b border-border/40">
                            <th className="text-left py-2 pr-3">Product</th>
                            <th className="text-left py-2 pr-3">Brand</th>
                            <th className="text-left py-2 pr-3">Category</th>
                            <th className="text-right py-2 pr-3">60d Qty</th>
                            <th className="text-right py-2 pr-3">60d Revenue</th>
                            <th className="text-right py-2">Avg Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {topProductsData.map((p, i) => (
                            <tr key={i} className="border-b border-border/20 hover:bg-white/5">
                              <td className="py-1.5 pr-3 max-w-[180px] truncate">{p.title}</td>
                              <td className="py-1.5 pr-3 text-muted-foreground">{p.vendor}</td>
                              <td className="py-1.5 pr-3">
                                <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: (CATEGORY_COLORS[p.category] || '#6b7280') + '33', color: CATEGORY_COLORS[p.category] || '#6b7280' }}>
                                  {p.category}
                                </span>
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(p.qty)}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                              <td className="py-1.5 text-right tabular-nums">{formatCurrency(p.avgPrice)}</td>
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
        </TabsContent>

        {/* ── Tab 2: Growth Analysis ── */}
        <TabsContent value="growth" className="space-y-4">
          {phase1Loading ? (
            <Skeleton className="h-[500px] w-full" />
          ) : (
            <>
              <div className="flex gap-2 items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Period A: 31-60 days ago &nbsp;|&nbsp; Period B: 0-30 days ago
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setGrowthToggle('category')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${growthToggle === 'category' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}
                  >
                    按類別 By Category
                  </button>
                  <button
                    onClick={() => setGrowthToggle('brand')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${growthToggle === 'brand' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}
                  >
                    按品牌 By Brand
                  </button>
                </div>
              </div>

              {/* Top growers / decliners charts */}
              <div className="grid grid-cols-2 gap-4">
                <ChartCard title="Top 5 Growers" subtitle="By absolute revenue growth">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={top5Growers} margin={{ left: 10, right: 10 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 9 }} interval={0} />
                      <YAxis tickFormatter={(v: number) => formatCurrency(v)} tick={AXIS_STYLE} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE.contentStyle}
                        itemStyle={TOOLTIP_STYLE.itemStyle}
                        labelStyle={TOOLTIP_STYLE.labelStyle}
                        formatter={(v: number, name: string) => [
                          name === 'delta' ? `+${formatCurrency(v)}` : formatCurrency(v),
                          name === 'delta' ? 'Growth' : name,
                        ]}
                      />
                      <Bar dataKey="delta" fill="#10b981" radius={[4, 4, 0, 0]}>
                        {top5Growers.map((_, i) => (
                          <Cell key={i} fill="#10b981" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="mt-2 space-y-1">
                    {top5Growers.map((g, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-muted-foreground truncate">{g.name}</span>
                        <span className="text-emerald-400 tabular-nums">+{formatCurrency(g.delta)} ({g.pct.toFixed(1)}%)</span>
                      </div>
                    ))}
                  </div>
                </ChartCard>

                <ChartCard title="Top 5 Decliners" subtitle="By absolute revenue decline">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={top5Decliners} margin={{ left: 10, right: 10 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 9 }} interval={0} />
                      <YAxis tickFormatter={(v: number) => formatCurrency(Math.abs(v))} tick={AXIS_STYLE} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE.contentStyle}
                        itemStyle={TOOLTIP_STYLE.itemStyle}
                        labelStyle={TOOLTIP_STYLE.labelStyle}
                        formatter={(v: number) => [formatCurrency(v), 'Change']}
                      />
                      <Bar dataKey="delta" radius={[4, 4, 0, 0]}>
                        {top5Decliners.map((_, i) => (
                          <Cell key={i} fill="#ef4444" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="mt-2 space-y-1">
                    {top5Decliners.map((g, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="text-muted-foreground truncate">{g.name}</span>
                        <span className="text-red-400 tabular-nums">{formatCurrency(g.delta)} ({g.pct.toFixed(1)}%)</span>
                      </div>
                    ))}
                  </div>
                </ChartCard>
              </div>

              {/* Comparison Table */}
              <Card className="border-border/40">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-medium">
                    {growthToggle === 'category' ? '按類別 By Category' : '按品牌 By Brand'} — Period Comparison
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="overflow-auto max-h-[400px]">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/40">
                          <th className="text-left py-2 pr-3">{growthToggle === 'category' ? 'Category' : 'Brand'}</th>
                          <th className="text-right py-2 pr-3">Period A (31-60d)</th>
                          <th className="text-right py-2 pr-3">Period B (0-30d)</th>
                          <th className="text-right py-2 pr-3">Δ HKD</th>
                          <th className="text-right py-2">Δ%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeGrowthData.map((row, i) => (
                          <tr key={i} className="border-b border-border/20 hover:bg-white/5">
                            <td className="py-1.5 pr-3 font-medium">{row.name}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{formatCurrency(row.periodA)}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">{formatCurrency(row.periodB)}</td>
                            <td className={`py-1.5 pr-3 text-right tabular-nums ${row.delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.delta >= 0 ? '+' : ''}{formatCurrency(row.delta)}
                            </td>
                            <td className={`py-1.5 text-right tabular-nums ${row.pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.pct >= 0 ? '+' : ''}{row.pct.toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ── Tab 3: Bundle Analysis ── */}
        <TabsContent value="bundles" className="space-y-4">
          {phase1Loading ? (
            <Skeleton className="h-[500px] w-full" />
          ) : (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard
                  title="Bundle Rate"
                  subtitle="% of orders with 2+ products"
                  value={formatPercent(bundleAnalysis.bundleRate)}
                  icon={Layers}
                />
                <KpiCard
                  title="Bundle AOV"
                  subtitle="Avg order value — bundles"
                  value={formatCurrency(bundleAnalysis.bundleAOV)}
                  icon={ShoppingCart}
                />
                <KpiCard
                  title="Single-Item AOV"
                  subtitle="Avg order value — single"
                  value={formatCurrency(bundleAnalysis.singleAOV)}
                  icon={Package}
                />
                <KpiCard
                  title="Revenue Lift"
                  subtitle="Bundle vs single AOV"
                  value={`+${formatPercent(bundleAnalysis.revenueLift)}`}
                  icon={TrendingUp}
                />
              </div>

              {/* Key insight card */}
              {bundleAnalysis.topPair && (
                <Card className="border-amber-500/30 bg-amber-500/5">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Zap className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-amber-400">Top Cross-Category Pairing</p>
                        <p className="text-sm mt-0.5">
                          <span className="font-semibold">{bundleAnalysis.topPair.catA} + {bundleAnalysis.topPair.catB}</span>
                          {' '}appears in{' '}
                          <span className="font-semibold">{bundleAnalysis.topPair.count} orders</span>
                          {', avg '}
                          <span className="font-semibold">{formatCurrency(bundleAnalysis.topPair.avgValue)}</span>
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-2 gap-4">
                {/* Bundle size donut */}
                <ChartCard title="Bundle Size Distribution" subtitle="How many items per bundle order">
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={bundleAnalysis.bundleSizeData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={90}
                        dataKey="value"
                        label={({ name, percent }: { name: string; percent: number }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}
                      >
                        {bundleAnalysis.bundleSizeData.map((_, i) => (
                          <Cell key={i} fill={DONUT_PALETTE[i % DONUT_PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE.contentStyle}
                        itemStyle={TOOLTIP_STYLE.itemStyle}
                        formatter={(v: number) => [v, 'Orders']}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>

                {/* Bundle counts overview */}
                <ChartCard title="Order Type Breakdown" subtitle="Single vs bundle orders">
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={[
                          { name: 'Single-item', value: bundleAnalysis.singleCount },
                          { name: 'Bundle (2+)', value: bundleAnalysis.bundleCount },
                        ]}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={90}
                        dataKey="value"
                      >
                        <Cell fill="#6b7280" />
                        <Cell fill="#f59e0b" />
                      </Pie>
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE.contentStyle}
                        itemStyle={TOOLTIP_STYLE.itemStyle}
                        formatter={(v: number) => [v, 'Orders']}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              {/* Top product pairings table */}
              <Card className="border-border/40">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-medium">Top Product Pairings</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border/40">
                        <th className="text-left py-2 pr-3">Product A Category</th>
                        <th className="text-left py-2 pr-3">Product B Category</th>
                        <th className="text-right py-2 pr-3">Orders Together</th>
                        <th className="text-right py-2">Avg Order Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bundleAnalysis.pairsData.map((pair, i) => (
                        <tr key={i} className="border-b border-border/20 hover:bg-white/5">
                          <td className="py-1.5 pr-3">
                            <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: (CATEGORY_COLORS[pair.catA] || '#6b7280') + '33', color: CATEGORY_COLORS[pair.catA] || '#6b7280' }}>
                              {pair.catA}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3">
                            <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: (CATEGORY_COLORS[pair.catB] || '#6b7280') + '33', color: CATEGORY_COLORS[pair.catB] || '#6b7280' }}>
                              {pair.catB}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{pair.count}</td>
                          <td className="py-1.5 text-right tabular-nums">{formatCurrency(pair.avgValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ── Tab 4: Lead Time ── */}
        <TabsContent value="lead-time" className="space-y-4">
          {phase2Loading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
              <Skeleton className="h-[400px] w-full" />
            </div>
          ) : (
            <>
              {/* Summary KPI cards */}
              <div className="grid grid-cols-3 gap-4">
                <KpiCard
                  title="Avg Lead Time"
                  subtitle="All vendors"
                  value={`${leadTimeData.avgLeadTime}d`}
                  icon={Clock}
                />
                <KpiCard
                  title="Max Lead Time"
                  subtitle="Longest vendor"
                  value={`${leadTimeData.maxLeadTime}d`}
                  icon={AlertTriangle}
                />
                <KpiCard
                  title="Vendors > 60 Days"
                  subtitle="High-risk suppliers"
                  value={String(leadTimeData.longLeadVendors)}
                  icon={TrendingDown}
                />
              </div>

              {/* Vendor lead time chart */}
              <ChartCard
                title="Top 15 Vendors by Lead Time"
                subtitle="Days from invoice date to posting date"
                note="Red > 60d · Yellow 30-60d · Green < 30d"
              >
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart
                    data={leadTimeData.vendorData}
                    layout="vertical"
                    margin={{ left: 20, right: 20 }}
                  >
                    <CartesianGrid {...GRID_STYLE} horizontal={false} />
                    <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v: number) => `${v}d`} />
                    <YAxis
                      type="category"
                      dataKey="vendor"
                      tick={AXIS_STYLE}
                      width={160}
                      tickFormatter={(v: string) => v.length > 22 ? v.slice(0, 22) + '…' : v}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE.contentStyle}
                      itemStyle={TOOLTIP_STYLE.itemStyle}
                      labelStyle={TOOLTIP_STYLE.labelStyle}
                      formatter={(v: number) => [`${v} days`, 'Avg Lead Time']}
                    />
                    <Bar dataKey="avgLeadTime" radius={[0, 4, 4, 0]}>
                      {leadTimeData.vendorData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* By item table */}
              <Card className="border-border/40">
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-medium">By Item — Longest Lead Times</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="overflow-auto max-h-[400px]">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/40">
                          <th className="text-left py-2 pr-3">Item #</th>
                          <th className="text-left py-2 pr-3">Description</th>
                          <th className="text-right py-2 pr-3">Avg Lead Time (days)</th>
                          <th className="text-right py-2"># Purchases</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leadTimeData.itemData.map((item, i) => (
                          <tr key={i} className="border-b border-border/20 hover:bg-white/5">
                            <td className="py-1.5 pr-3 font-mono text-[10px] text-muted-foreground">{item.item_number}</td>
                            <td className="py-1.5 pr-3 max-w-[240px] truncate">{item.description}</td>
                            <td className="py-1.5 pr-3 text-right tabular-nums">
                              <span className={`font-medium ${item.avgLeadTime > 60 ? 'text-red-400' : item.avgLeadTime > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                                {item.avgLeadTime}d
                              </span>
                            </td>
                            <td className="py-1.5 text-right tabular-nums text-muted-foreground">{item.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ── Tab 5: Capital Efficiency ── */}
        <TabsContent value="capital" className="space-y-4">
          {phase2Loading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-4">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)}
              </div>
              <Skeleton className="h-[400px] w-full" />
            </div>
          ) : (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiCard
                  title="Slow Stock Capital"
                  subtitle=">90 days on shelf"
                  value={formatCurrency(capitalData.totalSlowCapital)}
                  icon={AlertTriangle}
                />
                <KpiCard
                  title="Fast Stock Capital"
                  subtitle="<30 days on shelf"
                  value={formatCurrency(capitalData.totalFastCapital)}
                  icon={Zap}
                />
                <KpiCard
                  title="Most Efficient Brand"
                  subtitle="Highest revenue/capital ratio"
                  value={capitalData.mostEfficientBrand.slice(0, 18) || '—'}
                  icon={TrendingUp}
                />
                <KpiCard
                  title="Riskiest SKU"
                  subtitle="Highest capital × days locked"
                  value={capitalData.riskiestSku || '—'}
                  icon={DollarSign}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Top 20 capital locked table */}
                <Card className="border-border/40">
                  <CardHeader className="pb-2 pt-4 px-4">
                    <CardTitle className="text-sm font-medium">Top 20 Capital Locked</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="overflow-auto max-h-[480px]">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground border-b border-border/40">
                            <th className="text-left py-2 pr-2">Product</th>
                            <th className="text-right py-2 pr-2">Qty</th>
                            <th className="text-right py-2 pr-2">Unit Cost</th>
                            <th className="text-right py-2 pr-2">Total</th>
                            <th className="text-right py-2">Days</th>
                          </tr>
                        </thead>
                        <tbody>
                          {capitalData.topLocked.map((item, i) => {
                            const intensity = Math.max(0.05, Math.min(0.35, 0.35 * (1 - i / 20)));
                            return (
                              <tr
                                key={i}
                                className="border-b border-border/20"
                                style={{ backgroundColor: `rgba(239, 68, 68, ${intensity})` }}
                              >
                                <td className="py-1.5 pr-2 max-w-[140px] truncate">{item.title}</td>
                                <td className="py-1.5 pr-2 text-right tabular-nums">{item.qty}</td>
                                <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(item.unitCost)}</td>
                                <td className="py-1.5 pr-2 text-right tabular-nums font-medium">{formatCurrency(item.capitalValue)}</td>
                                <td className="py-1.5 text-right tabular-nums text-amber-400">{item.daysOnShelf}d</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                {/* Fast movers chart */}
                <ChartCard title="Fast Movers" subtitle="Top 20 by inventory turns (30d)">
                  <ResponsiveContainer width="100%" height={480}>
                    <BarChart
                      data={capitalData.fastMovers.map(f => ({
                        name: f.title.length > 20 ? f.title.slice(0, 20) + '…' : f.title,
                        turns: parseFloat(f.turns30d.toFixed(3)),
                        vendor: f.vendor,
                      }))}
                      layout="vertical"
                      margin={{ left: 10, right: 20 }}
                    >
                      <CartesianGrid {...GRID_STYLE} horizontal={false} />
                      <XAxis type="number" tick={AXIS_STYLE} tickFormatter={(v: number) => `${v}x`} />
                      <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 9 }} width={140} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE.contentStyle}
                        itemStyle={TOOLTIP_STYLE.itemStyle}
                        labelStyle={TOOLTIP_STYLE.labelStyle}
                        formatter={(v: number) => [`${v}x turns`, 'Inventory Turns (30d)']}
                      />
                      <Bar dataKey="turns" fill={CHART_COLORS.tertiary} radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
