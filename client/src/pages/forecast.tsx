import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  TrendingUp, TrendingDown, Package, AlertTriangle, Calendar,
  ChevronDown, ChevronRight, ArrowUp, ArrowDown, Minus, BarChart3, Target,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

// ── Types ──────────────────────────────────────────────────────
interface MonthlyData {
  month: string; // YYYY-MM
  qty: number;
  revenue: number;
}

interface CategoryMonthly {
  [category: string]: MonthlyData[];
}

interface ForecastPoint {
  month: string;
  predicted_qty: number;
  predicted_revenue: number;
  lower_qty: number;
  upper_qty: number;
}

interface GapItem {
  category: string;
  current_stock: number;
  predicted_demand_1m: number;
  predicted_demand_2m: number;
  predicted_demand_3m: number;
  gap_1m: number;
  gap_2m: number;
  gap_3m: number;
}

// ── Constants ──────────────────────────────────────────────────
const MAJOR_CATEGORIES = ['HELMET', 'RIDER GEARS', 'ACCESSORIES', 'MOTORCYCLE PARTS'] as const;
const MAJOR_COLORS: Record<string, string> = {
  'HELMET': CHART_COLORS.primary,
  'RIDER GEARS': CHART_COLORS.secondary,
  'ACCESSORIES': CHART_COLORS.tertiary,
  'MOTORCYCLE PARTS': CHART_COLORS.quaternary,
};

// ── Helpers ────────────────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}

function getMajorCategory(pt: string | null): string {
  if (!pt) return 'SERVICE/OTHER';
  if (pt.startsWith('HELMET')) return 'HELMET';
  if (pt.startsWith('RIDER GEARS')) return 'RIDER GEARS';
  if (pt.startsWith('ACCESSORIES')) return 'ACCESSORIES';
  if (pt.startsWith('MOTORCYCLE PARTS')) return 'MOTORCYCLE PARTS';
  if (pt === 'Workshop' || pt === 'General') return 'SERVICE/OTHER';
  return 'SERVICE/OTHER';
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split('-');
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m)]} ${y.slice(2)}`;
}

function formatMonthFull(ym: string): string {
  const [y, m] = ym.split('-');
  return `${y}年${parseInt(m)}月`;
}

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) + n;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// ── Forecast Algorithm ─────────────────────────────────────────
// Weighted Moving Average with Seasonal Adjustment
function generateForecast(
  monthlyData: MonthlyData[],
  horizonMonths: number,
  currentMonth: string
): ForecastPoint[] {
  if (monthlyData.length < 6) return [];
  
  // Sort by month
  const sorted = [...monthlyData].sort((a, b) => a.month.localeCompare(b.month));
  
  // Build a map for quick lookup
  const dataMap = new Map<string, MonthlyData>();
  for (const d of sorted) dataMap.set(d.month, d);
  
  // Calculate seasonal indices (month-of-year averages vs overall average)
  const monthAvgs: Record<number, { totalQty: number; totalRev: number; count: number }> = {};
  for (let m = 1; m <= 12; m++) monthAvgs[m] = { totalQty: 0, totalRev: 0, count: 0 };
  
  // Use only data from 2024+ for seasonal patterns (business matured)
  const matureData = sorted.filter(d => d.month >= '2024-01');
  if (matureData.length < 6) {
    // Fallback: use all data
    for (const d of sorted) {
      const m = parseInt(d.month.split('-')[1]);
      monthAvgs[m].totalQty += d.qty;
      monthAvgs[m].totalRev += d.revenue;
      monthAvgs[m].count += 1;
    }
  } else {
    for (const d of matureData) {
      const m = parseInt(d.month.split('-')[1]);
      monthAvgs[m].totalQty += d.qty;
      monthAvgs[m].totalRev += d.revenue;
      monthAvgs[m].count += 1;
    }
  }
  
  // Overall average
  const refData = matureData.length >= 6 ? matureData : sorted;
  const overallAvgQty = refData.reduce((s, d) => s + d.qty, 0) / refData.length;
  const overallAvgRev = refData.reduce((s, d) => s + d.revenue, 0) / refData.length;
  
  // Seasonal indices
  const seasonalQty: Record<number, number> = {};
  const seasonalRev: Record<number, number> = {};
  for (let m = 1; m <= 12; m++) {
    const avg = monthAvgs[m];
    if (avg.count > 0 && overallAvgQty > 0) {
      seasonalQty[m] = (avg.totalQty / avg.count) / overallAvgQty;
      seasonalRev[m] = (avg.totalRev / avg.count) / overallAvgRev;
    } else {
      seasonalQty[m] = 1;
      seasonalRev[m] = 1;
    }
  }
  
  // Weighted moving average of deseasonalized values (last 6 months, recent weighted more)
  const last6 = sorted.slice(-6);
  const weights = [1, 1.5, 2, 2.5, 3, 4]; // Most recent gets highest weight
  const wLen = Math.min(weights.length, last6.length);
  const usedWeights = weights.slice(weights.length - wLen);
  const totalWeight = usedWeights.reduce((s, w) => s + w, 0);
  
  let deseasonQtySum = 0;
  let deseasonRevSum = 0;
  for (let i = 0; i < wLen; i++) {
    const d = last6[last6.length - wLen + i];
    const m = parseInt(d.month.split('-')[1]);
    deseasonQtySum += (d.qty / (seasonalQty[m] || 1)) * usedWeights[i];
    deseasonRevSum += (d.revenue / (seasonalRev[m] || 1)) * usedWeights[i];
  }
  const baseQty = deseasonQtySum / totalWeight;
  const baseRev = deseasonRevSum / totalWeight;
  
  // Calculate trend (slope of last 12 months deseasonalized)
  const trendData = sorted.slice(-12).map((d, i) => {
    const m = parseInt(d.month.split('-')[1]);
    return { x: i, qty: d.qty / (seasonalQty[m] || 1), rev: d.revenue / (seasonalRev[m] || 1) };
  });
  
  let trendQty = 0;
  let trendRev = 0;
  if (trendData.length >= 3) {
    const n = trendData.length;
    const xMean = (n - 1) / 2;
    const qMean = trendData.reduce((s, d) => s + d.qty, 0) / n;
    const rMean = trendData.reduce((s, d) => s + d.rev, 0) / n;
    let numQ = 0, numR = 0, den = 0;
    for (const d of trendData) {
      numQ += (d.x - xMean) * (d.qty - qMean);
      numR += (d.x - xMean) * (d.rev - rMean);
      den += (d.x - xMean) * (d.x - xMean);
    }
    if (den > 0) {
      trendQty = numQ / den;
      trendRev = numR / den;
    }
  }
  
  // Generate predictions
  const forecasts: ForecastPoint[] = [];
  for (let h = 1; h <= horizonMonths; h++) {
    const targetMonth = addMonths(currentMonth, h);
    const targetM = parseInt(targetMonth.split('-')[1]);
    
    // Apply trend + seasonal
    const predQty = Math.max(0, Math.round((baseQty + trendQty * h) * (seasonalQty[targetM] || 1)));
    const predRev = Math.max(0, Math.round((baseRev + trendRev * h) * (seasonalRev[targetM] || 1)));
    
    // Confidence interval (±20% for 1m, ±30% for 2m, ±40% for 3m)
    const confPct = 0.15 + 0.1 * h;
    
    forecasts.push({
      month: targetMonth,
      predicted_qty: predQty,
      predicted_revenue: predRev,
      lower_qty: Math.max(0, Math.round(predQty * (1 - confPct))),
      upper_qty: Math.round(predQty * (1 + confPct)),
    });
  }
  
  return forecasts;
}

// ── Main Component ─────────────────────────────────────────────
export default function ForecastPage() {
  const [loading, setLoading] = useState(true);
  const [orderLines, setOrderLines] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'history' | 'forecast' | 'gap'>('history');
  const [expandedCat, setExpandedCat] = useState<string | null>(null);

  // ── Fetch Data ──────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [lines, ords, inv] = await Promise.all([
          queryAllPages('shopify_order_lines', 'order_id,product_type,quantity,price,line_total,title,sku'),
          queryAllPages('shopify_orders', 'id,created_at'),
          queryAllPages('shopify_inventory', 'product_type,inventory_quantity,sku'),
        ]);
        setOrderLines(lines);
        setOrders(ords);
        setInventory(inv);
      } catch (e) {
        console.error('Forecast data load error:', e);
      }
      setLoading(false);
    }
    load();
  }, []);

  // ── Process Data ────────────────────────────────────────────
  const processedData = useMemo(() => {
    if (!orderLines.length || !orders.length) return null;

    // Build order date map
    const orderDateMap = new Map<number, string>();
    for (const o of orders) {
      orderDateMap.set(o.id, (o.created_at || '').slice(0, 7)); // YYYY-MM
    }

    // Current month (HKT)
    const hkNow = getHKNow();
    const currentMonth = `${hkNow.getFullYear()}-${String(hkNow.getMonth() + 1).padStart(2, '0')}`;
    
    // Aggregate by major category + month
    const catMonthly: Record<string, Record<string, { qty: number; revenue: number }>> = {};
    const subCatMonthly: Record<string, Record<string, { qty: number; revenue: number }>> = {};
    const totalMonthly: Record<string, { qty: number; revenue: number }> = {};

    for (const line of orderLines) {
      const month = orderDateMap.get(line.order_id);
      if (!month) continue;
      // Skip current incomplete month for trend analysis (but include for display)
      
      const major = getMajorCategory(line.product_type);
      if (major === 'SERVICE/OTHER') continue; // Exclude service items
      
      const subCat = line.product_type || 'Unknown';
      const qty = line.quantity || 0;
      const rev = parseFloat(line.line_total || line.price || 0);

      // Major category
      if (!catMonthly[major]) catMonthly[major] = {};
      if (!catMonthly[major][month]) catMonthly[major][month] = { qty: 0, revenue: 0 };
      catMonthly[major][month].qty += qty;
      catMonthly[major][month].revenue += rev;

      // Sub category
      if (!subCatMonthly[subCat]) subCatMonthly[subCat] = {};
      if (!subCatMonthly[subCat][month]) subCatMonthly[subCat][month] = { qty: 0, revenue: 0 };
      subCatMonthly[subCat][month].qty += qty;
      subCatMonthly[subCat][month].revenue += rev;

      // Total
      if (!totalMonthly[month]) totalMonthly[month] = { qty: 0, revenue: 0 };
      totalMonthly[month].qty += qty;
      totalMonthly[month].revenue += rev;
    }

    // Convert to sorted arrays
    const toArray = (map: Record<string, { qty: number; revenue: number }>): MonthlyData[] =>
      Object.entries(map)
        .map(([month, d]) => ({ month, ...d }))
        .sort((a, b) => a.month.localeCompare(b.month));

    const catArrays: Record<string, MonthlyData[]> = {};
    for (const [cat, map] of Object.entries(catMonthly)) {
      catArrays[cat] = toArray(map);
    }
    const subCatArrays: Record<string, MonthlyData[]> = {};
    for (const [cat, map] of Object.entries(subCatMonthly)) {
      subCatArrays[cat] = toArray(map);
    }
    const totalArray = toArray(totalMonthly);

    // Inventory by major category
    const invByMajor: Record<string, number> = {};
    const invBySub: Record<string, number> = {};
    for (const item of inventory) {
      const major = getMajorCategory(item.product_type);
      if (major === 'SERVICE/OTHER') continue;
      const sub = item.product_type || 'Unknown';
      const avail = Math.max(0, item.inventory_quantity || 0);
      invByMajor[major] = (invByMajor[major] || 0) + avail;
      invBySub[sub] = (invBySub[sub] || 0) + avail;
    }

    // Generate forecasts
    const lastCompleteMonth = addMonths(currentMonth, -1);
    const forecasts: Record<string, ForecastPoint[]> = {};
    for (const cat of MAJOR_CATEGORIES) {
      // Use only complete months for forecasting
      const completeData = (catArrays[cat] || []).filter(d => d.month <= lastCompleteMonth);
      forecasts[cat] = generateForecast(completeData, 3, lastCompleteMonth);
    }
    // Total forecast
    const completeTotalData = totalArray.filter(d => d.month <= lastCompleteMonth);
    forecasts['TOTAL'] = generateForecast(completeTotalData, 3, lastCompleteMonth);

    return {
      catArrays,
      subCatArrays,
      totalArray,
      invByMajor,
      invBySub,
      forecasts,
      currentMonth,
      lastCompleteMonth,
    };
  }, [orderLines, orders, inventory]);

  // ── YoY Comparison ──────────────────────────────────────────
  const yoyData = useMemo(() => {
    if (!processedData) return null;
    const { catArrays, lastCompleteMonth } = processedData;
    const lastMonth = lastCompleteMonth;
    const lastYear = addMonths(lastMonth, -12);
    const last3Start = addMonths(lastMonth, -2);
    const last3StartLY = addMonths(lastYear, -2);

    const results: {
      category: string;
      lastMonth: { qty: number; revenue: number };
      lastMonthLY: { qty: number; revenue: number };
      last3M: { qty: number; revenue: number };
      last3MLY: { qty: number; revenue: number };
      yoyMonthQty: number;
      yoyMonthRev: number;
      yoy3MQty: number;
      yoy3MRev: number;
    }[] = [];

    for (const cat of MAJOR_CATEGORIES) {
      const data = catArrays[cat] || [];
      const dataMap = new Map(data.map(d => [d.month, d]));

      const lm = dataMap.get(lastMonth) || { qty: 0, revenue: 0, month: lastMonth };
      const lmly = dataMap.get(lastYear) || { qty: 0, revenue: 0, month: lastYear };
      
      // Last 3 months
      let l3 = { qty: 0, revenue: 0 };
      let l3ly = { qty: 0, revenue: 0 };
      for (let i = 0; i < 3; i++) {
        const m = addMonths(lastMonth, -i);
        const mly = addMonths(lastYear, -i);
        const d = dataMap.get(m);
        const dly = dataMap.get(mly);
        if (d) { l3.qty += d.qty; l3.revenue += d.revenue; }
        if (dly) { l3ly.qty += dly.qty; l3ly.revenue += dly.revenue; }
      }

      results.push({
        category: cat,
        lastMonth: lm,
        lastMonthLY: lmly,
        last3M: l3,
        last3MLY: l3ly,
        yoyMonthQty: lmly.qty > 0 ? ((lm.qty - lmly.qty) / lmly.qty) * 100 : 0,
        yoyMonthRev: lmly.revenue > 0 ? ((lm.revenue - lmly.revenue) / lmly.revenue) * 100 : 0,
        yoy3MQty: l3ly.qty > 0 ? ((l3.qty - l3ly.qty) / l3ly.qty) * 100 : 0,
        yoy3MRev: l3ly.revenue > 0 ? ((l3.revenue - l3ly.revenue) / l3ly.revenue) * 100 : 0,
      });
    }
    return results;
  }, [processedData]);

  // ── Chart Data ──────────────────────────────────────────────
  const trendChartData = useMemo(() => {
    if (!processedData) return [];
    const { catArrays, totalArray } = processedData;
    // Use data from 2023-11 onward (business matured)
    const allMonths = [...new Set([
      ...totalArray.map(d => d.month),
      ...Object.values(catArrays).flatMap(arr => arr.map(d => d.month)),
    ])].sort().filter(m => m >= '2023-11');
    
    return allMonths.map(month => {
      const row: any = { month, label: formatMonth(month) };
      for (const cat of MAJOR_CATEGORIES) {
        const catData = catArrays[cat] || [];
        const found = catData.find(d => d.month === month);
        row[`${cat}_qty`] = found?.qty || 0;
        row[`${cat}_rev`] = found?.revenue || 0;
      }
      const total = totalArray.find(d => d.month === month);
      row.total_qty = total?.qty || 0;
      row.total_rev = total?.revenue || 0;
      return row;
    });
  }, [processedData]);

  const forecastChartData = useMemo(() => {
    if (!processedData) return [];
    const { totalArray, forecasts, lastCompleteMonth } = processedData;
    
    // Last 12 months of actual + 3 forecast months
    const recentActual = totalArray
      .filter(d => d.month >= addMonths(lastCompleteMonth, -11) && d.month <= lastCompleteMonth)
      .map(d => ({
        month: d.month,
        label: formatMonth(d.month),
        actual_qty: d.qty,
        actual_rev: d.revenue,
        forecast_qty: null as number | null,
        forecast_rev: null as number | null,
        lower_qty: null as number | null,
        upper_qty: null as number | null,
      }));
    
    // Bridge: duplicate last actual month as first forecast point
    const lastActual = recentActual[recentActual.length - 1];
    if (lastActual) {
      lastActual.forecast_qty = lastActual.actual_qty;
      lastActual.forecast_rev = lastActual.actual_rev;
      lastActual.lower_qty = lastActual.actual_qty;
      lastActual.upper_qty = lastActual.actual_qty;
    }
    
    const forecastPoints = (forecasts['TOTAL'] || []).map(f => ({
      month: f.month,
      label: formatMonth(f.month),
      actual_qty: null as number | null,
      actual_rev: null as number | null,
      forecast_qty: f.predicted_qty,
      forecast_rev: f.predicted_revenue,
      lower_qty: f.lower_qty,
      upper_qty: f.upper_qty,
    }));

    return [...recentActual, ...forecastPoints];
  }, [processedData]);

  // ── Gap Analysis ────────────────────────────────────────────
  const gapData = useMemo(() => {
    if (!processedData) return [];
    const { invByMajor, forecasts } = processedData;
    
    return MAJOR_CATEGORIES.map(cat => {
      const stock = invByMajor[cat] || 0;
      const fc = forecasts[cat] || [];
      const d1 = fc[0]?.predicted_qty || 0;
      const d2 = d1 + (fc[1]?.predicted_qty || 0);
      const d3 = d2 + (fc[2]?.predicted_qty || 0);
      return {
        category: cat,
        current_stock: stock,
        predicted_demand_1m: d1,
        predicted_demand_2m: d2,
        predicted_demand_3m: d3,
        gap_1m: stock - d1,
        gap_2m: stock - d2,
        gap_3m: stock - d3,
        months_of_stock: d1 > 0 ? Math.round((stock / d1) * 10) / 10 : 999,
      };
    });
  }, [processedData]);

  // Sub-category gap
  const subGapData = useMemo(() => {
    if (!processedData) return [];
    const { subCatArrays, invBySub, lastCompleteMonth } = processedData;
    
    return Object.entries(subCatArrays)
      .filter(([cat]) => MAJOR_CATEGORIES.some(m => cat.startsWith(m)))
      .map(([cat, data]) => {
        const completeData = data.filter(d => d.month <= lastCompleteMonth);
        const fc = generateForecast(completeData, 3, lastCompleteMonth);
        const stock = invBySub[cat] || 0;
        const d1 = fc[0]?.predicted_qty || 0;
        const d2 = d1 + (fc[1]?.predicted_qty || 0);
        const d3 = d2 + (fc[2]?.predicted_qty || 0);
        return {
          category: cat,
          major: getMajorCategory(cat),
          current_stock: stock,
          predicted_demand_1m: d1,
          predicted_demand_2m: d2,
          predicted_demand_3m: d3,
          gap_1m: stock - d1,
          gap_2m: stock - d2,
          gap_3m: stock - d3,
          months_of_stock: d1 > 0 ? Math.round((stock / d1) * 10) / 10 : 999,
        };
      })
      .sort((a, b) => a.gap_3m - b.gap_3m); // Most critical first
  }, [processedData]);

  // ── Render Helpers ──────────────────────────────────────────
  function YoYBadge({ value }: { value: number }) {
    if (Math.abs(value) < 0.5) return <Badge variant="outline" className="text-[10px] px-1.5 py-0"><Minus className="h-2.5 w-2.5 mr-0.5" />持平</Badge>;
    const isUp = value > 0;
    return (
      <Badge
        variant="outline"
        className={`text-[10px] px-1.5 py-0 ${isUp ? 'text-emerald-500 border-emerald-500/30' : 'text-red-500 border-red-500/30'}`}
      >
        {isUp ? <ArrowUp className="h-2.5 w-2.5 mr-0.5" /> : <ArrowDown className="h-2.5 w-2.5 mr-0.5" />}
        {Math.abs(value).toFixed(1)}%
      </Badge>
    );
  }

  function GapIndicator({ gap, stock }: { gap: number; stock: number }) {
    if (gap >= 0) {
      return <span className="text-emerald-500 text-xs font-medium">+{formatNumber(gap)}</span>;
    }
    const severity = stock > 0 ? (Math.abs(gap) / stock > 1 ? 'critical' : 'warning') : 'critical';
    return (
      <span className={`text-xs font-medium ${severity === 'critical' ? 'text-red-500' : 'text-amber-500'}`}>
        {formatNumber(gap)}
      </span>
    );
  }

  // ── Loading State ───────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border/40">
              <CardContent className="p-4"><Skeleton className="h-20 w-full" /></CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (!processedData) {
    return (
      <Card className="border-border/40">
        <CardContent className="p-8 text-center text-muted-foreground">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>無法載入預測數據</p>
        </CardContent>
      </Card>
    );
  }

  const { lastCompleteMonth, forecasts } = processedData;

  return (
    <div className="space-y-4">
      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {MAJOR_CATEGORIES.map(cat => {
          const fc = forecasts[cat]?.[0];
          const gap = gapData.find(g => g.category === cat);
          return (
            <Card key={cat} className="border-border/40" data-testid={`kpi-${cat.toLowerCase().replace(/\s+/g, '-')}`}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{cat}</span>
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: MAJOR_COLORS[cat] }} />
                </div>
                <div className="text-lg font-semibold" data-testid={`text-forecast-qty-${cat.toLowerCase().replace(/\s+/g, '-')}`}>
                  {fc ? formatNumber(fc.predicted_qty) : '—'}
                  <span className="text-[10px] text-muted-foreground ml-1">件 / 下月預測</span>
                </div>
                {gap && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] text-muted-foreground">庫存覆蓋</span>
                    <span className={`text-xs font-medium ${
                      gap.months_of_stock > 3 ? 'text-emerald-500' :
                      gap.months_of_stock > 1.5 ? 'text-amber-500' : 'text-red-500'
                    }`}>
                      {gap.months_of_stock >= 99 ? '∞' : `${gap.months_of_stock}個月`}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Tab Navigation */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
        <TabsList className="h-9">
          <TabsTrigger value="history" className="text-xs" data-testid="tab-history">
            <BarChart3 className="h-3.5 w-3.5 mr-1" />歷史趨勢
          </TabsTrigger>
          <TabsTrigger value="forecast" className="text-xs" data-testid="tab-forecast">
            <TrendingUp className="h-3.5 w-3.5 mr-1" />需求預測
          </TabsTrigger>
          <TabsTrigger value="gap" className="text-xs" data-testid="tab-gap">
            <Target className="h-3.5 w-3.5 mr-1" />庫存缺口
          </TabsTrigger>
        </TabsList>

        {/* ── History Tab ───────────────────────────────────── */}
        <TabsContent value="history" className="space-y-4 mt-3">
          {/* Revenue Trend */}
          <ChartCard title="月度營收趨勢" subtitle="Major Category Revenue (2023/11 起)" data-testid="chart-revenue-trend">
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="label" {...AXIS_STYLE} interval="preserveStartEnd" />
                  <YAxis {...AXIS_STYLE} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(value: number, name: string) => {
                      const label = name.replace('_rev', '');
                      return [formatCurrency(value), label];
                    }}
                  />
                  {MAJOR_CATEGORIES.map(cat => (
                    <Area
                      key={cat}
                      type="monotone"
                      dataKey={`${cat}_rev`}
                      name={cat}
                      stackId="1"
                      stroke={MAJOR_COLORS[cat]}
                      fill={MAJOR_COLORS[cat]}
                      fillOpacity={0.4}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          {/* Quantity Trend */}
          <ChartCard title="月度銷量趨勢" subtitle="Quantity by Category" data-testid="chart-qty-trend">
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trendChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="label" {...AXIS_STYLE} interval="preserveStartEnd" />
                  <YAxis {...AXIS_STYLE} />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(value: number, name: string) => {
                      const label = name.replace('_qty', '');
                      return [`${formatNumber(value)} 件`, label];
                    }}
                  />
                  {MAJOR_CATEGORIES.map(cat => (
                    <Bar
                      key={cat}
                      dataKey={`${cat}_qty`}
                      name={cat}
                      stackId="1"
                      fill={MAJOR_COLORS[cat]}
                      radius={cat === 'MOTORCYCLE PARTS' ? [3, 3, 0, 0] : undefined}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          {/* YoY Comparison Table */}
          <Card className="border-border/40" data-testid="card-yoy">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                同期對比
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  Year-over-Year · {formatMonthFull(lastCompleteMonth)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">分類</TableHead>
                    <TableHead className="text-xs text-right">上月銷量</TableHead>
                    <TableHead className="text-xs text-right">去年同期</TableHead>
                    <TableHead className="text-xs text-right">YoY 銷量</TableHead>
                    <TableHead className="text-xs text-right">上月營收</TableHead>
                    <TableHead className="text-xs text-right">YoY 營收</TableHead>
                    <TableHead className="text-xs text-right">近3月 vs 去年</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {yoyData?.map(row => (
                    <TableRow key={row.category}>
                      <TableCell className="text-xs font-medium">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: MAJOR_COLORS[row.category] }} />
                          {row.category}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-right">{formatNumber(row.lastMonth.qty)}</TableCell>
                      <TableCell className="text-xs text-right text-muted-foreground">{formatNumber(row.lastMonthLY.qty)}</TableCell>
                      <TableCell className="text-right"><YoYBadge value={row.yoyMonthQty} /></TableCell>
                      <TableCell className="text-xs text-right">{formatCurrency(row.lastMonth.revenue)}</TableCell>
                      <TableCell className="text-right"><YoYBadge value={row.yoyMonthRev} /></TableCell>
                      <TableCell className="text-right"><YoYBadge value={row.yoy3MRev} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Forecast Tab ──────────────────────────────────── */}
        <TabsContent value="forecast" className="space-y-4 mt-3">
          {/* Total Forecast Chart */}
          <ChartCard 
            title="總需求預測" 
            subtitle="Demand Forecast (Qty)"
            note="基於加權移動平均 + 季節性調整 · 虛線為預測區間"
          >
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={forecastChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="label" {...AXIS_STYLE} />
                  <YAxis {...AXIS_STYLE} />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(value: any, name: any) => {
                      if (value === null) return ['—', name];
                      const labels: Record<string, string> = {
                        actual_qty: '實際銷量',
                        forecast_qty: '預測銷量',
                        upper_qty: '上限',
                        lower_qty: '下限',
                      };
                      return [`${formatNumber(value)} 件`, labels[name] || name];
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="upper_qty"
                    stroke="none"
                    fill={CHART_COLORS.primary}
                    fillOpacity={0.1}
                    connectNulls={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="lower_qty"
                    stroke="none"
                    fill="white"
                    fillOpacity={0}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="actual_qty"
                    stroke={CHART_COLORS.primary}
                    strokeWidth={2}
                    dot={{ r: 3, fill: CHART_COLORS.primary }}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="forecast_qty"
                    stroke={CHART_COLORS.primary}
                    strokeWidth={2}
                    strokeDasharray="6 3"
                    dot={{ r: 3, fill: CHART_COLORS.primary, stroke: '#fff', strokeWidth: 1 }}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          {/* Per-Category Forecast Table */}
          <Card className="border-border/40" data-testid="card-forecast-detail">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                分類需求預測
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  Category Demand Forecast — Next 3 Months
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">分類</TableHead>
                    <TableHead className="text-xs text-right">
                      {forecasts['HELMET']?.[0] ? formatMonthFull(forecasts['HELMET'][0].month) : '+1M'}
                    </TableHead>
                    <TableHead className="text-xs text-right">
                      {forecasts['HELMET']?.[1] ? formatMonthFull(forecasts['HELMET'][1].month) : '+2M'}
                    </TableHead>
                    <TableHead className="text-xs text-right">
                      {forecasts['HELMET']?.[2] ? formatMonthFull(forecasts['HELMET'][2].month) : '+3M'}
                    </TableHead>
                    <TableHead className="text-xs text-right">3個月合計</TableHead>
                    <TableHead className="text-xs text-right">預測營收 (3M)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MAJOR_CATEGORIES.map(cat => {
                    const fc = forecasts[cat] || [];
                    const totalQty = fc.reduce((s, f) => s + f.predicted_qty, 0);
                    const totalRev = fc.reduce((s, f) => s + f.predicted_revenue, 0);
                    return (
                      <TableRow key={cat}>
                        <TableCell className="text-xs font-medium">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: MAJOR_COLORS[cat] }} />
                            {cat}
                          </div>
                        </TableCell>
                        {fc.map((f, i) => (
                          <TableCell key={i} className="text-xs text-right">
                            {formatNumber(f.predicted_qty)}
                            <span className="text-[9px] text-muted-foreground ml-1">
                              ({formatNumber(f.lower_qty)}–{formatNumber(f.upper_qty)})
                            </span>
                          </TableCell>
                        ))}
                        {fc.length < 3 && Array.from({ length: 3 - fc.length }).map((_, i) => (
                          <TableCell key={`empty-${i}`} className="text-xs text-right text-muted-foreground">—</TableCell>
                        ))}
                        <TableCell className="text-xs text-right font-medium">{formatNumber(totalQty)}</TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(totalRev)}</TableCell>
                      </TableRow>
                    );
                  })}
                  {/* Total row */}
                  <TableRow className="border-t-2 font-medium">
                    <TableCell className="text-xs">合計 TOTAL</TableCell>
                    {(forecasts['TOTAL'] || []).map((f, i) => (
                      <TableCell key={i} className="text-xs text-right">
                        {formatNumber(f.predicted_qty)}
                      </TableCell>
                    ))}
                    <TableCell className="text-xs text-right font-semibold">
                      {formatNumber((forecasts['TOTAL'] || []).reduce((s, f) => s + f.predicted_qty, 0))}
                    </TableCell>
                    <TableCell className="text-xs text-right font-semibold">
                      {formatCurrency((forecasts['TOTAL'] || []).reduce((s, f) => s + f.predicted_revenue, 0))}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Gap Analysis Tab ──────────────────────────────── */}
        <TabsContent value="gap" className="space-y-4 mt-3">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {gapData.map(g => {
              const isShort = g.gap_3m < 0;
              return (
                <Card key={g.category} className={`border-border/40 ${isShort ? 'ring-1 ring-red-500/20' : ''}`}>
                  <CardContent className="p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: MAJOR_COLORS[g.category] }} />
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{g.category}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <span className="text-muted-foreground">現有庫存</span>
                      <span className="text-right font-medium">{formatNumber(g.current_stock)}</span>
                      <span className="text-muted-foreground">1個月需求</span>
                      <span className="text-right">{formatNumber(g.predicted_demand_1m)}</span>
                      <span className="text-muted-foreground">3個月需求</span>
                      <span className="text-right">{formatNumber(g.predicted_demand_3m)}</span>
                      <span className="text-muted-foreground">3個月缺口</span>
                      <span className="text-right"><GapIndicator gap={g.gap_3m} stock={g.current_stock} /></span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Detailed Gap Table */}
          <Card className="border-border/40" data-testid="card-gap-detail">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">
                子分類庫存缺口分析
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  Sub-category Stock Gap · 按缺口嚴重度排序
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="max-h-[500px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="text-xs">子分類</TableHead>
                      <TableHead className="text-xs text-right">現有庫存</TableHead>
                      <TableHead className="text-xs text-right">1個月需求</TableHead>
                      <TableHead className="text-xs text-right">缺口 1M</TableHead>
                      <TableHead className="text-xs text-right">2個月需求</TableHead>
                      <TableHead className="text-xs text-right">缺口 2M</TableHead>
                      <TableHead className="text-xs text-right">3個月需求</TableHead>
                      <TableHead className="text-xs text-right">缺口 3M</TableHead>
                      <TableHead className="text-xs text-right">庫存月數</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subGapData.map(g => (
                      <TableRow key={g.category} className={g.gap_1m < 0 ? 'bg-red-500/5' : ''}>
                        <TableCell className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: MAJOR_COLORS[g.major] }} />
                            {g.category.replace(`${g.major} - `, '')}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-right font-medium">{formatNumber(g.current_stock)}</TableCell>
                        <TableCell className="text-xs text-right">{formatNumber(g.predicted_demand_1m)}</TableCell>
                        <TableCell className="text-right"><GapIndicator gap={g.gap_1m} stock={g.current_stock} /></TableCell>
                        <TableCell className="text-xs text-right">{formatNumber(g.predicted_demand_2m)}</TableCell>
                        <TableCell className="text-right"><GapIndicator gap={g.gap_2m} stock={g.current_stock} /></TableCell>
                        <TableCell className="text-xs text-right">{formatNumber(g.predicted_demand_3m)}</TableCell>
                        <TableCell className="text-right"><GapIndicator gap={g.gap_3m} stock={g.current_stock} /></TableCell>
                        <TableCell className="text-xs text-right">
                          <span className={`font-medium ${
                            g.months_of_stock > 3 ? 'text-emerald-500' :
                            g.months_of_stock > 1.5 ? 'text-amber-500' : 'text-red-500'
                          }`}>
                            {g.months_of_stock >= 99 ? '∞' : g.months_of_stock.toFixed(1)}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
