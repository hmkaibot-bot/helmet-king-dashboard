import { useEffect, useState, useMemo, useCallback } from 'react';
import { queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, CHART_PALETTE, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  DollarSign, ShoppingCart, TrendingUp, Tag, Package,
  ChevronDown, ChevronRight, X, Calendar, Store, Globe, Truck,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

// ── HK timezone helper ────────────────────────────────────────────────────────
function getHKNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "上星期三 to 本星期二":
// Find most-recent Tuesday (today if Tue), go back 6 days to get Wednesday.
function getWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const dow = hkt.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  // Days since most-recent Tuesday
  const daysToTue = (dow + 7 - 2) % 7; // 0 if today is Tue
  const tuesday = new Date(hkt);
  tuesday.setDate(hkt.getDate() - daysToTue);
  const wednesday = new Date(tuesday);
  wednesday.setDate(tuesday.getDate() - 6);
  return { from: toDateStr(wednesday), to: toDateStr(tuesday) };
}

function getPrevWeekBounds(): { from: string; to: string } {
  const curr = getWeekBounds();
  const wed = new Date(curr.from + 'T00:00:00');
  const prevTue = new Date(wed);
  prevTue.setDate(wed.getDate() - 1);
  const prevWed = new Date(prevTue);
  prevWed.setDate(prevTue.getDate() - 6);
  return { from: toDateStr(prevWed), to: toDateStr(prevTue) };
}

function getMonthBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const from = `${hkt.getFullYear()}-${String(hkt.getMonth() + 1).padStart(2, '0')}-01`;
  return { from, to: toDateStr(hkt) };
}

function fmtDow(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const labels = ['日', '一', '二', '三', '四', '五', '六'];
  return `(${labels[d.getDay()]})`;
}

// ── Channel mapping ───────────────────────────────────────────────────────────
function mapChannel(src: string | null): string {
  if (!src) return '其他渠道 Other';
  if (src === 'pos') return '門市 POS';
  if (src === 'web') return '網店 Online';
  if (src === 'shopify_draft_order') return '手動訂單 Draft';
  return '其他渠道 Other';
}

// ── Channel icons ─────────────────────────────────────────────────────────────
function ChannelIcon({ name }: { name: string }) {
  if (name.includes('POS')) return <Store className="h-4 w-4" />;
  if (name.includes('Online')) return <Globe className="h-4 w-4" />;
  if (name.includes('Draft')) return <Truck className="h-4 w-4" />;
  return <Package className="h-4 w-4" />;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface ProcessResult {
  revenue: number;
  orders: number;
  aov: number;
  brandMap: Record<string, { qty: number; revenue: number }>;
  catMap: Record<string, { qty: number; revenue: number }>;
  promoCodes: Record<string, { uses: number; discountAmt: number; revenue: number }>;
  topSkus: { title: string; sku: string; vendor: string; qty: number; revenue: number }[];
  channelMap: Record<string, { orders: number; revenue: number }>;
}

// ── Data processor ────────────────────────────────────────────────────────────
function processOrders(
  ordersRaw: any[],
  linesRaw: any[],
  from: string,
  to: string
): ProcessResult {
  const fromStr = from;
  const toStr = to + '\xff';

  // Filter valid orders within date range
  const orders = ordersRaw.filter(o => {
    if (o.financial_status === 'refunded') return false;
    if (o.cancelled_at) return false;
    const ca = String(o.created_at || '');
    return ca >= fromStr && ca <= toStr;
  });

  const orderIds = new Set(orders.map(o => String(o.id)));

  // Lines for these orders
  const lines = linesRaw.filter(l => orderIds.has(String(l.order_id)));

  // Core KPIs
  const revenue = orders.reduce((s, o) => s + parseFloat(o.total_price || '0'), 0);
  const orderCount = orders.length;
  const aov = orderCount > 0 ? revenue / orderCount : 0;

  // Channel map
  const channelMap: Record<string, { orders: number; revenue: number }> = {};
  for (const o of orders) {
    const ch = mapChannel(o.source_name);
    if (!channelMap[ch]) channelMap[ch] = { orders: 0, revenue: 0 };
    channelMap[ch].orders += 1;
    channelMap[ch].revenue += parseFloat(o.total_price || '0');
  }

  // Brand map
  const brandMap: Record<string, { qty: number; revenue: number }> = {};
  const catMap: Record<string, { qty: number; revenue: number }> = {};
  const skuMap: Record<string, { title: string; sku: string; vendor: string; qty: number; revenue: number }> = {};

  for (const l of lines) {
    const vendor = l.vendor || '未知品牌';
    const cat = l.product_type || '未分類';
    const qty = parseInt(l.quantity || '1', 10);
    const price = parseFloat(l.price || '0') * qty;
    const skuKey = l.sku || l.title || 'N/A';

    if (!brandMap[vendor]) brandMap[vendor] = { qty: 0, revenue: 0 };
    brandMap[vendor].qty += qty;
    brandMap[vendor].revenue += price;

    if (!catMap[cat]) catMap[cat] = { qty: 0, revenue: 0 };
    catMap[cat].qty += qty;
    catMap[cat].revenue += price;

    if (!skuMap[skuKey]) skuMap[skuKey] = { title: l.title || skuKey, sku: l.sku || '', vendor, qty: 0, revenue: 0 };
    skuMap[skuKey].qty += qty;
    skuMap[skuKey].revenue += price;
  }

  const topSkus = Object.values(skuMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Promo codes
  const promoCodes: Record<string, { uses: number; discountAmt: number; revenue: number }> = {};
  for (const o of orders) {
    let codes: { code: string; amount: number }[] = [];
    try {
      const dc = o.discount_codes;
      if (typeof dc === 'string' && dc.startsWith('[')) {
        codes = JSON.parse(dc);
      } else if (Array.isArray(dc)) {
        codes = dc;
      }
    } catch {}
    const rev = parseFloat(o.total_price || '0');
    for (const c of codes) {
      const key = (c.code || '').toUpperCase();
      if (!key) continue;
      if (!promoCodes[key]) promoCodes[key] = { uses: 0, discountAmt: 0, revenue: 0 };
      promoCodes[key].uses += 1;
      promoCodes[key].discountAmt += parseFloat(String(c.amount || '0'));
      promoCodes[key].revenue += rev;
    }
  }

  return { revenue, orders: orderCount, aov, brandMap, catMap, promoCodes, topSkus, channelMap };
}

function calcDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

// ── DateRangePicker ───────────────────────────────────────────────────────────
function DateRangePicker({
  from, to, onChange,
}: {
  from: string;
  to: string;
  onChange: (f: string, t: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
      <input
        type="date"
        value={from}
        onChange={e => onChange(e.target.value, to)}
        className="bg-accent/50 border border-border/50 rounded px-2 py-1 text-xs text-foreground"
      />
      <span className="text-muted-foreground">至</span>
      <input
        type="date"
        value={to}
        onChange={e => onChange(from, e.target.value)}
        className="bg-accent/50 border border-border/50 rounded px-2 py-1 text-xs text-foreground"
      />
    </div>
  );
}

// ── DetailModal ───────────────────────────────────────────────────────────────
function DetailModal({
  open, onClose, title, children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border/40 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border/40">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent/50">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto max-h-[calc(80vh-60px)]">{children}</div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function WeeklyReview() {
  const [loading, setLoading] = useState(true);
  const [ordersRaw, setOrdersRaw] = useState<any[]>([]);
  const [linesRaw, setLinesRaw] = useState<any[]>([]);
  const [promoOpen, setPromoOpen] = useState(false);

  // Section 5 date range (brand chart)
  const monthBounds = getMonthBounds();
  const [brandChartRange, setBrandChartRange] = useState({ from: monthBounds.from, to: monthBounds.to });

  // Section 6 date ranges
  const [brandTableRange, setBrandTableRange] = useState({ from: monthBounds.from, to: monthBounds.to });
  const [catTableRange, setCatTableRange] = useState({ from: monthBounds.from, to: monthBounds.to });

  // Modal state
  const [brandModal, setBrandModal] = useState<{ open: boolean; brand: string }>({ open: false, brand: '' });
  const [catModal, setCatModal] = useState<{ open: boolean; cat: string }>({ open: false, cat: '' });

  // Fixed date bounds
  const weekBounds = useMemo(() => getWeekBounds(), []);
  const prevWeekBounds = useMemo(() => getPrevWeekBounds(), []);

  // Load data once
  useEffect(() => {
    (async () => {
      try {
        const [orders, lines] = await Promise.all([
          queryAllPages(
            'shopify_orders',
            'id,order_number,created_at,total_price,total_discounts,financial_status,cancelled_at,discount_codes,source_name'
          ),
          queryAllPages(
            'shopify_order_lines',
            'order_id,product_id,sku,title,vendor,product_type,quantity,price,created_at'
          ),
        ]);
        setOrdersRaw(orders);
        setLinesRaw(lines);
      } catch (err) {
        console.error('Failed to load data:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Weekly KPI data
  const weekData = useMemo(
    () => processOrders(ordersRaw, linesRaw, weekBounds.from, weekBounds.to),
    [ordersRaw, linesRaw, weekBounds.from, weekBounds.to]
  );

  const prevWeekData = useMemo(
    () => processOrders(ordersRaw, linesRaw, prevWeekBounds.from, prevWeekBounds.to),
    [ordersRaw, linesRaw, prevWeekBounds.from, prevWeekBounds.to]
  );

  // Monthly channel data
  const monthData = useMemo(
    () => processOrders(ordersRaw, linesRaw, monthBounds.from, monthBounds.to),
    [ordersRaw, linesRaw, monthBounds.from, monthBounds.to]
  );

  // Section 5: brand chart data
  const brandChartData = useMemo(() => {
    const d = processOrders(ordersRaw, linesRaw, brandChartRange.from, brandChartRange.to);
    return Object.entries(d.brandMap)
      .filter(([, v]) => v.revenue > 0)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([name, v]) => ({ name, revenue: v.revenue, qty: v.qty }));
  }, [ordersRaw, linesRaw, brandChartRange]);

  // Section 6: brand table data
  const brandTableData = useMemo(() => {
    const d = processOrders(ordersRaw, linesRaw, brandTableRange.from, brandTableRange.to);
    return Object.entries(d.brandMap)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([name, v], i) => ({ rank: i + 1, name, ...v }));
  }, [ordersRaw, linesRaw, brandTableRange]);

  // Section 6: cat table data
  const catTableData = useMemo(() => {
    const d = processOrders(ordersRaw, linesRaw, catTableRange.from, catTableRange.to);
    return Object.entries(d.catMap)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([name, v], i) => ({ rank: i + 1, name, ...v }));
  }, [ordersRaw, linesRaw, catTableRange]);

  // Brand modal lines
  const brandModalLines = useMemo(() => {
    if (!brandModal.brand) return [];
    const fromStr = brandTableRange.from;
    const toStr = brandTableRange.to + '\xff';
    const filtered = linesRaw.filter(l => {
      const vendor = l.vendor || '未知品牌';
      const ca = String(l.created_at || '');
      return vendor === brandModal.brand && ca >= fromStr && ca <= toStr;
    });
    const grouped: Record<string, { title: string; sku: string; qty: number; revenue: number }> = {};
    for (const l of filtered) {
      const key = (l.sku || l.title || 'N/A');
      if (!grouped[key]) grouped[key] = { title: l.title || key, sku: l.sku || '', qty: 0, revenue: 0 };
      const qty = parseInt(l.quantity || '1', 10);
      grouped[key].qty += qty;
      grouped[key].revenue += parseFloat(l.price || '0') * qty;
    }
    return Object.values(grouped).sort((a, b) => b.revenue - a.revenue);
  }, [linesRaw, brandModal.brand, brandTableRange]);

  // Category modal lines (brand breakdown)
  const catModalLines = useMemo(() => {
    if (!catModal.cat) return [];
    const fromStr = catTableRange.from;
    const toStr = catTableRange.to + '\xff';
    const filtered = linesRaw.filter(l => {
      const cat = l.product_type || '未分類';
      const ca = String(l.created_at || '');
      return cat === catModal.cat && ca >= fromStr && ca <= toStr;
    });
    const grouped: Record<string, { brand: string; qty: number; revenue: number }> = {};
    for (const l of filtered) {
      const brand = l.vendor || '未知品牌';
      if (!grouped[brand]) grouped[brand] = { brand, qty: 0, revenue: 0 };
      const qty = parseInt(l.quantity || '1', 10);
      grouped[brand].qty += qty;
      grouped[brand].revenue += parseFloat(l.price || '0') * qty;
    }
    return Object.values(grouped).sort((a, b) => b.revenue - a.revenue);
  }, [linesRaw, catModal.cat, catTableRange]);

  // Derived weekly values
  const weekRevDelta = calcDelta(weekData.revenue, prevWeekData.revenue);
  const weekOrdDelta = calcDelta(weekData.orders, prevWeekData.orders);
  const weekAovDelta = calcDelta(weekData.aov, prevWeekData.aov);
  const promoCount = Object.keys(weekData.promoCodes).length;

  // Channel data for display
  const channelEntries = Object.entries(monthData.channelMap)
    .sort((a, b) => b[1].revenue - a[1].revenue);
  const totalMonthRevenue = channelEntries.reduce((s, [, v]) => s + v.revenue, 0);
  const topChannel = channelEntries[0]?.[0] ?? '';

  // Weekly top brands / cats
  const weekTopBrands = Object.entries(weekData.brandMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5);
  const weekTopCats = Object.entries(weekData.catMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5);

  // Promo code table sorted by uses
  const promoRows = Object.entries(weekData.promoCodes)
    .sort((a, b) => b[1].uses - a[1].uses);

  // Chart bar height for brand chart
  const brandChartHeight = Math.max(200, brandChartData.length * 28);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-8">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">週報 Weekly Review</h1>
          <p className="text-sm text-muted-foreground">
            {weekBounds.from} {fmtDow(weekBounds.from)} — {weekBounds.to} {fmtDow(weekBounds.to)}
          </p>
        </div>

        {/* ── Section 1: 銷售渠道分析（當月） ────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            銷售渠道分析 Sales Channel（當月）
          </h2>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {channelEntries.map(([ch, v]) => {
                const pct = totalMonthRevenue > 0 ? (v.revenue / totalMonthRevenue) * 100 : 0;
                const isTop = ch === topChannel;
                return (
                  <Card
                    key={ch}
                    className={`border-border/40 ${isTop ? 'border-amber-500/50 bg-amber-500/5' : ''}`}
                  >
                    <CardContent className="p-4 space-y-2">
                      <div className={`flex items-center gap-2 ${isTop ? 'text-amber-400' : 'text-muted-foreground'}`}>
                        <ChannelIcon name={ch} />
                        <span className="text-xs font-medium">{ch}</span>
                        {isTop && (
                          <Badge className="ml-auto bg-amber-500/20 text-amber-400 border-0 text-[10px] px-1.5 py-0">
                            最大
                          </Badge>
                        )}
                      </div>
                      <p className="text-lg font-semibold tabular-nums">{formatCurrency(v.revenue)}</p>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{v.orders} 單</span>
                        <span className={isTop ? 'text-amber-400 font-medium' : ''}>
                          {formatPercent(pct)}
                        </span>
                      </div>
                      {/* Bar indicator */}
                      <div className="h-1 rounded-full bg-border/40 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isTop ? 'bg-amber-500' : 'bg-primary/40'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {/* Placeholder if fewer than 4 channels */}
              {channelEntries.length === 0 && (
                <Card className="border-border/40 col-span-4">
                  <CardContent className="p-4 text-center text-muted-foreground text-sm">
                    暫無當月數據
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </section>

        {/* ── Section 2: 本週核心 KPI ─────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            本週核心 KPI
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              title="本週營收"
              subtitle="Weekly Revenue"
              value={loading ? '—' : formatCurrency(weekData.revenue)}
              icon={DollarSign}
              loading={loading}
              delta={loading ? null : weekRevDelta}
              testId="kpi-week-revenue"
            />
            <KpiCard
              title="本週訂單"
              subtitle="Weekly Orders"
              value={loading ? '—' : formatNumber(weekData.orders)}
              icon={ShoppingCart}
              loading={loading}
              delta={loading ? null : weekOrdDelta}
              testId="kpi-week-orders"
            />
            <KpiCard
              title="平均單價"
              subtitle="Avg Order Value"
              value={loading ? '—' : formatCurrency(weekData.aov)}
              icon={TrendingUp}
              loading={loading}
              delta={loading ? null : weekAovDelta}
              testId="kpi-week-aov"
            />
            {/* Clickable promo card */}
            <div
              className="cursor-pointer select-none"
              onClick={() => setPromoOpen(v => !v)}
              title="點擊展開折扣碼詳情"
            >
              <Card className={`border-border/40 transition-colors hover:border-amber-500/40 ${promoOpen ? 'border-amber-500/50 bg-amber-500/5' : ''}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1 min-w-0 flex-1">
                      <p className="text-xs font-medium text-muted-foreground truncate">
                        折扣碼數量 <span className="opacity-70">Promo Codes</span>
                      </p>
                      {loading ? (
                        <Skeleton className="h-7 w-16" />
                      ) : (
                        <p className="text-xl font-semibold tabular-nums tracking-tight">
                          {promoCount}
                        </p>
                      )}
                      <div className="flex items-center gap-1 text-xs text-amber-400">
                        {promoOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <span>{promoOpen ? '收起' : '展開詳情'}</span>
                      </div>
                    </div>
                    <div className="ml-3 p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                      <Tag className="h-4 w-4" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* ── Section 3: Promo Codes (collapsible) ─────────────────────────── */}
        {promoOpen && (
          <section>
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Tag className="h-4 w-4 text-amber-400" />
                  折扣碼使用情況 Promo Code Usage
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    {weekBounds.from} — {weekBounds.to}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {promoRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">本週無折扣碼使用記錄</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/40 text-muted-foreground">
                          <th className="text-left py-2 pr-4 font-medium">折扣碼 Code</th>
                          <th className="text-right py-2 pr-4 font-medium">使用次數 Uses</th>
                          <th className="text-right py-2 pr-4 font-medium">折扣金額 Discount</th>
                          <th className="text-right py-2 font-medium">帶來營收 Revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {promoRows.map(([code, v]) => (
                          <tr key={code} className="border-b border-border/20 hover:bg-accent/30">
                            <td className="py-2 pr-4 font-mono text-amber-400">{code}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{v.uses}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-red-400">
                              -{formatCurrency(v.discountAmt)}
                            </td>
                            <td className="py-2 text-right tabular-nums">{formatCurrency(v.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        )}

        {/* ── Section 4: Top 5 Brand / Top 5 Category ──────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            本週表現 Top Performers（本週）
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top 5 Brands */}
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium">最佳品牌 Top 5 Brands</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loading ? (
                  <div className="space-y-2">{[0,1,2,3,4].map(i => <Skeleton key={i} className="h-8" />)}</div>
                ) : weekTopBrands.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">暫無數據</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground">
                        <th className="text-left py-2 w-8 font-medium">#</th>
                        <th className="text-left py-2 font-medium">品牌 Brand</th>
                        <th className="text-right py-2 pr-3 font-medium">銷售額</th>
                        <th className="text-right py-2 font-medium">件數</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weekTopBrands.map(([brand, v], i) => (
                        <tr key={brand} className="border-b border-border/20 hover:bg-accent/30">
                          <td className="py-2 w-8">
                            <Badge
                              className={`text-[10px] px-1.5 py-0 ${
                                i === 0
                                  ? 'bg-amber-500/20 text-amber-400 border-0'
                                  : 'bg-muted/30 text-muted-foreground border-0'
                              }`}
                            >
                              {i + 1}
                            </Badge>
                          </td>
                          <td className="py-2 font-medium max-w-[120px] truncate">{brand}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(v.revenue)}</td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{v.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Top 5 Categories */}
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium">最佳類別 Top 5 Categories</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loading ? (
                  <div className="space-y-2">{[0,1,2,3,4].map(i => <Skeleton key={i} className="h-8" />)}</div>
                ) : weekTopCats.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">暫無數據</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground">
                        <th className="text-left py-2 w-8 font-medium">#</th>
                        <th className="text-left py-2 font-medium">品類 Category</th>
                        <th className="text-right py-2 pr-3 font-medium">銷售額</th>
                        <th className="text-right py-2 font-medium">件數</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weekTopCats.map(([cat, v], i) => (
                        <tr key={cat} className="border-b border-border/20 hover:bg-accent/30">
                          <td className="py-2 w-8">
                            <Badge
                              className={`text-[10px] px-1.5 py-0 ${
                                i === 0
                                  ? 'bg-amber-500/20 text-amber-400 border-0'
                                  : 'bg-muted/30 text-muted-foreground border-0'
                              }`}
                            >
                              {i + 1}
                            </Badge>
                          </td>
                          <td className="py-2 font-medium max-w-[120px] truncate">{cat}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(v.revenue)}</td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{v.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── Section 5: 品牌表現橫向圖表 ──────────────────────────────────── */}
        <section>
          <ChartCard
            title="品牌表現 Brand Performance"
            subtitle="（可調整日期範圍）"
            loading={loading}
          >
            <div className="flex justify-end mb-3">
              <DateRangePicker
                from={brandChartRange.from}
                to={brandChartRange.to}
                onChange={(f, t) => setBrandChartRange({ from: f, to: t })}
              />
            </div>
            {brandChartData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">所選日期範圍內無數據</p>
            ) : (
              <div style={{ height: brandChartHeight }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    layout="vertical"
                    data={brandChartData}
                    margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                  >
                    <CartesianGrid {...GRID_STYLE} horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={v => formatCurrency(v)}
                      tick={AXIS_STYLE}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ ...AXIS_STYLE, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      width={90}
                    />
                    <Tooltip
                      {...TOOLTIP_STYLE}
                      formatter={(value: number) => [formatCurrency(value), '銷售額']}
                    />
                    <Bar dataKey="revenue" radius={[0, 4, 4, 0]} maxBarSize={20}>
                      {brandChartData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={index === 0 ? CHART_COLORS.primary : CHART_PALETTE[index % CHART_PALETTE.length]}
                          opacity={index === 0 ? 1 : 0.7}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </ChartCard>
        </section>

        {/* ── Section 6: 品牌表現明細 + 品類表現明細 ───────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            表現明細 Performance Details
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Brand Table */}
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <CardTitle className="text-sm font-medium">品牌表現 Brand Performance</CardTitle>
                  <DateRangePicker
                    from={brandTableRange.from}
                    to={brandTableRange.to}
                    onChange={(f, t) => setBrandTableRange({ from: f, to: t })}
                  />
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loading ? (
                  <div className="space-y-2">{[0,1,2,3,4].map(i => <Skeleton key={i} className="h-8" />)}</div>
                ) : brandTableData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">所選日期範圍內無數據</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/40 text-muted-foreground">
                          <th className="text-left py-2 w-8 font-medium">排名</th>
                          <th className="text-left py-2 font-medium">品牌 Brand</th>
                          <th className="text-right py-2 pr-3 font-medium">銷售額</th>
                          <th className="text-right py-2 font-medium">件數</th>
                        </tr>
                      </thead>
                      <tbody>
                        {brandTableData.map(row => (
                          <tr
                            key={row.name}
                            className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
                            onClick={() => setBrandModal({ open: true, brand: row.name })}
                            title={`點擊查看 ${row.name} 明細`}
                          >
                            <td className="py-2 w-8">
                              <Badge
                                className={`text-[10px] px-1.5 py-0 ${
                                  row.rank === 1
                                    ? 'bg-amber-500/20 text-amber-400 border-0'
                                    : 'bg-muted/30 text-muted-foreground border-0'
                                }`}
                              >
                                {row.rank}
                              </Badge>
                            </td>
                            <td className="py-2 font-medium max-w-[120px] truncate text-amber-400/80 hover:text-amber-400">
                              {row.name}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(row.revenue)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{row.qty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Category Table */}
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <CardTitle className="text-sm font-medium">品類表現 Category Performance</CardTitle>
                  <DateRangePicker
                    from={catTableRange.from}
                    to={catTableRange.to}
                    onChange={(f, t) => setCatTableRange({ from: f, to: t })}
                  />
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {loading ? (
                  <div className="space-y-2">{[0,1,2,3,4].map(i => <Skeleton key={i} className="h-8" />)}</div>
                ) : catTableData.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">所選日期範圍內無數據</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border/40 text-muted-foreground">
                          <th className="text-left py-2 w-8 font-medium">排名</th>
                          <th className="text-left py-2 font-medium">品類 Category</th>
                          <th className="text-right py-2 pr-3 font-medium">銷售額</th>
                          <th className="text-right py-2 font-medium">件數</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catTableData.map(row => (
                          <tr
                            key={row.name}
                            className="border-b border-border/20 hover:bg-accent/30 cursor-pointer"
                            onClick={() => setCatModal({ open: true, cat: row.name })}
                            title={`點擊查看 ${row.name} 品牌拆解`}
                          >
                            <td className="py-2 w-8">
                              <Badge
                                className={`text-[10px] px-1.5 py-0 ${
                                  row.rank === 1
                                    ? 'bg-amber-500/20 text-amber-400 border-0'
                                    : 'bg-muted/30 text-muted-foreground border-0'
                                }`}
                              >
                                {row.rank}
                              </Badge>
                            </td>
                            <td className="py-2 font-medium max-w-[120px] truncate text-amber-400/80 hover:text-amber-400">
                              {row.name}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">{formatCurrency(row.revenue)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{row.qty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── Section 7: Top 5 SKU 本週最佳產品 ──────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Top 5 SKU 本週最佳產品
          </h2>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[0,1,2,3,4].map(i => <Skeleton key={i} className="h-36" />)}
            </div>
          ) : weekData.topSkus.length === 0 ? (
            <Card className="border-border/40">
              <CardContent className="p-4 text-center text-sm text-muted-foreground py-8">
                本週暫無產品銷售數據
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {weekData.topSkus.map((sku, i) => (
                <Card
                  key={sku.sku || sku.title}
                  className={`border-border/40 ${i === 0 ? 'border-amber-500/40 bg-amber-500/5' : ''}`}
                >
                  <CardContent className="p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <Badge
                        className={`text-[10px] px-1.5 py-0 font-bold ${
                          i === 0
                            ? 'bg-amber-500/20 text-amber-400 border-0'
                            : 'bg-muted/30 text-muted-foreground border-0'
                        }`}
                      >
                        #{i + 1}
                      </Badge>
                      <Package className={`h-3.5 w-3.5 ${i === 0 ? 'text-amber-400' : 'text-muted-foreground'}`} />
                    </div>
                    <p className="text-xs font-medium leading-tight line-clamp-2 min-h-[2.5rem]">
                      {sku.title}
                    </p>
                    {sku.sku && (
                      <p className="text-[10px] font-mono text-muted-foreground truncate">{sku.sku}</p>
                    )}
                    {sku.vendor && (
                      <p className="text-[10px] text-muted-foreground truncate">{sku.vendor}</p>
                    )}
                    <div className="pt-1 border-t border-border/30 space-y-0.5">
                      <p className="text-sm font-semibold tabular-nums">{formatCurrency(sku.revenue)}</p>
                      <p className="text-[10px] text-muted-foreground">{sku.qty} 件</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* ── Brand Detail Modal ──────────────────────────────────────────────── */}
      <DetailModal
        open={brandModal.open}
        onClose={() => setBrandModal({ open: false, brand: '' })}
        title={`${brandModal.brand} — 產品明細`}
      >
        {brandModalLines.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">所選日期範圍內無數據</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/40 text-muted-foreground">
                <th className="text-left py-2 font-medium">產品 Product</th>
                <th className="text-left py-2 pr-3 font-medium font-mono">SKU</th>
                <th className="text-right py-2 pr-3 font-medium">件數</th>
                <th className="text-right py-2 font-medium">銷售額</th>
              </tr>
            </thead>
            <tbody>
              {brandModalLines.map((line, i) => (
                <tr key={i} className="border-b border-border/20 hover:bg-accent/30">
                  <td className="py-2 max-w-[200px] truncate font-medium">{line.title}</td>
                  <td className="py-2 pr-3 font-mono text-muted-foreground">{line.sku || '—'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{line.qty}</td>
                  <td className="py-2 text-right tabular-nums">{formatCurrency(line.revenue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border/40 text-muted-foreground font-medium">
                <td className="py-2 text-xs" colSpan={2}>總計</td>
                <td className="py-2 pr-3 text-right tabular-nums text-xs">
                  {brandModalLines.reduce((s, l) => s + l.qty, 0)}
                </td>
                <td className="py-2 text-right tabular-nums text-xs">
                  {formatCurrency(brandModalLines.reduce((s, l) => s + l.revenue, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </DetailModal>

      {/* ── Category Detail Modal ───────────────────────────────────────────── */}
      <DetailModal
        open={catModal.open}
        onClose={() => setCatModal({ open: false, cat: '' })}
        title={`${catModal.cat} — 品牌拆解`}
      >
        {catModalLines.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">所選日期範圍內無數據</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/40 text-muted-foreground">
                <th className="text-left py-2 font-medium">品牌 Brand</th>
                <th className="text-right py-2 pr-3 font-medium">件數</th>
                <th className="text-right py-2 font-medium">銷售額</th>
              </tr>
            </thead>
            <tbody>
              {catModalLines.map((line, i) => (
                <tr key={i} className="border-b border-border/20 hover:bg-accent/30">
                  <td className="py-2 font-medium">{line.brand}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{line.qty}</td>
                  <td className="py-2 text-right tabular-nums">{formatCurrency(line.revenue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border/40 text-muted-foreground font-medium">
                <td className="py-2 text-xs">總計</td>
                <td className="py-2 pr-3 text-right tabular-nums text-xs">
                  {catModalLines.reduce((s, l) => s + l.qty, 0)}
                </td>
                <td className="py-2 text-right tabular-nums text-xs">
                  {formatCurrency(catModalLines.reduce((s, l) => s + l.revenue, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </DetailModal>
    </div>
  );
}
