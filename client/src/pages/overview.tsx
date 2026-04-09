import { useEffect, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, ShoppingCart, TrendingUp, Users, Store, Wrench, Ticket, Package, Target } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { KPI_TARGETS, kpiStatus } from '@/lib/kpi-targets';
import { getDateRanges } from '@/lib/time-intelligence';

// ─── Monthly Target Card ───────────────────────────────────────────
function MonthlyTargetCard({
  label, sublabel, value, target, unit = 'HKD', loading,
}: {
  label: string; sublabel: string; value: number; target: number;
  unit?: 'HKD' | '%' | ''; loading?: boolean;
}) {
  const status = kpiStatus(value, target);
  const fmtValue = unit === 'HKD' ? formatCurrency(value)
    : unit === '%' ? `${value.toFixed(1)}%`
    : formatNumber(value);
  const fmtTarget = unit === 'HKD' ? formatCurrency(target)
    : unit === '%' ? `${target}%`
    : formatNumber(target);

  return (
    <Card className="border-border/40" data-testid={`target-${sublabel.toLowerCase().replace(/\s/g,'-')}`}>
      <CardContent className="p-4">
        <div className="flex justify-between items-start mb-1">
          <span className="text-xs text-muted-foreground">{label} <span className="opacity-70">{sublabel}</span></span>
          <span className="text-base leading-none">{status.icon}</span>
        </div>
        {loading ? <Skeleton className="h-7 w-20 mt-1" /> : (
          <>
            <p className="text-lg font-semibold tabular-nums tracking-tight mt-1">{fmtValue}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">目標 {fmtTarget} · {status.pct}% 達成</p>
            <div className="mt-2 bg-muted/40 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-1.5 rounded-full transition-all ${status.bgColor}`}
                style={{ width: `${Math.min(100, status.pct)}%` }}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function OverviewPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [shopifyRevenue, setShopifyRevenue] = useState(0);
  const [bcCarshopRevenue, setBcCarshopRevenue] = useState(0);
  const [bcGarageRevenue, setBcGarageRevenue] = useState(0);
  const [totalOrders, setTotalOrders] = useState(0);
  const [aov, setAov] = useState(0);
  const [marselloCount, setMarselloCount] = useState(0);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [splitData, setSplitData] = useState<any[]>([]);
  const [adVsRevData, setAdVsRevData] = useState<any[]>([]);
  const [promoCodes, setPromoCodes] = useState<any[]>([]);
  const [yesterdayProducts, setYesterdayProducts] = useState<any[]>([]);

  // MTD target data
  const [mtdRevenue, setMtdRevenue] = useState(0);
  const [mtdOrders, setMtdOrders] = useState(0);
  const [mtdGrossMargin, setMtdGrossMargin] = useState<number | null>(null);
  const [newMembersThisMonth, setNewMembersThisMonth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const bcBounds = { from: '2023-01-01', to: '2099-12-31' };
        const ranges = getDateRanges();

        const [orders, carshop, garage, marsello, adData, mtdOrdersData, bcInv, marselloAll] = await Promise.all([
          queryWithDateRange('shopify_orders', 'created_at,total_price,financial_status,cancelled_at', 'created_at', bounds),
          queryWithDateRange('bc_sales_invoices', 'invoice_date,total_amount_incl_tax', 'invoice_date', bcBounds, [{ column: 'dimension1_code', op: 'eq', value: 'CARSHOP' }]),
          queryWithDateRange('bc_sales_invoices', 'invoice_date,total_amount_incl_tax', 'invoice_date', bcBounds, [{ column: 'dimension1_code', op: 'eq', value: 'GARAGE' }]),
          queryAll('marsello_customers', 'id'),
          queryWithDateRange('meta_ad_insights', 'date,spend', 'date', bounds),
          queryWithDateRange('shopify_orders', 'id,total_price,financial_status,cancelled_at', 'created_at', { from: ranges.mtd.start, to: ranges.mtd.end }),
          queryAll('bc_inventory', 'number,unit_price,unit_cost', undefined, 50000),
          queryAll('marsello_customers', 'id,created_at', undefined, 50000),
        ]);

        if (cancelled) return;

        const validOrders = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const rev = validOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
        const count = validOrders.length;

        setShopifyRevenue(rev);
        setTotalOrders(count);
        setAov(count > 0 ? rev / count : 0);

        const carRev = carshop.reduce((s: number, o: any) => s + (parseFloat(o.total_amount_incl_tax) || 0), 0);
        setBcCarshopRevenue(carRev);

        const garRev = garage.reduce((s: number, o: any) => s + (parseFloat(o.total_amount_incl_tax) || 0), 0);
        setBcGarageRevenue(garRev);

        setMarselloCount(marsello.length);

        // MTD revenue
        const mtdValid = mtdOrdersData.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const mtdRev = mtdValid.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
        setMtdRevenue(mtdRev);
        setMtdOrders(mtdValid.length);

        // Gross margin from BC inventory (average unit margin)
        const costItems = bcInv.filter((i: any) => parseFloat(i.unit_price) > 0 && parseFloat(i.unit_cost) > 0);
        if (costItems.length > 0) {
          const totalPrice = costItems.reduce((s: number, i: any) => s + (parseFloat(i.unit_price) || 0), 0);
          const totalCost = costItems.reduce((s: number, i: any) => s + (parseFloat(i.unit_cost) || 0), 0);
          setMtdGrossMargin(totalPrice > 0 ? ((totalPrice - totalCost) / totalPrice) * 100 : null);
        }

        // New members this month
        const monthStart = ranges.mtd.start;
        const newMembers = marselloAll.filter((m: any) => m.created_at && m.created_at >= monthStart);
        setNewMembersThisMonth(newMembers.length);

        // Revenue trend by day
        const dayMap: Record<string, { shopify: number; bc: number }> = {};
        validOrders.forEach((o: any) => {
          const day = o.created_at?.slice(0, 10);
          if (!day) return;
          if (!dayMap[day]) dayMap[day] = { shopify: 0, bc: 0 };
          dayMap[day].shopify += parseFloat(o.total_price) || 0;
        });
        [...carshop, ...garage].forEach((o: any) => {
          const day = o.invoice_date?.slice(0, 10);
          if (!day) return;
          if (!dayMap[day]) dayMap[day] = { shopify: 0, bc: 0 };
          dayMap[day].bc += parseFloat(o.total_amount_incl_tax) || 0;
        });
        setTrendData(
          Object.entries(dayMap)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, val]) => ({ date: date.slice(5), shopify: val.shopify, bc: val.bc, total: val.shopify + val.bc }))
        );

        setSplitData([
          { name: '零售 Retail', value: rev + carRev },
          { name: '車房 Garage', value: garRev },
        ]);

        // Ad spend vs revenue
        const adMap: Record<string, number> = {};
        adData.forEach((a: any) => {
          const day = a.date?.slice(0, 10);
          if (day) adMap[day] = (adMap[day] || 0) + (parseFloat(a.spend) || 0);
        });
        const allDays = new Set([...Object.keys(dayMap), ...Object.keys(adMap)]);
        setAdVsRevData(
          Array.from(allDays).sort().map((d) => ({
            date: d.slice(5),
            revenue: dayMap[d]?.shopify || 0,
            spend: adMap[d] || 0,
          }))
        );

        // Promo codes
        const thirtyAgo = new Date();
        thirtyAgo.setDate(thirtyAgo.getDate() - 30);
        const promoOrders = await queryWithDateRange('shopify_orders', 'id,total_price,discount_codes,financial_status,cancelled_at', 'created_at', { from: thirtyAgo.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
        const validPromoOrders = promoOrders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at && o.discount_codes);
        const codeMap: Record<string, { code: string; type: string; uses: number; totalDiscount: number; totalRevenue: number }> = {};
        validPromoOrders.forEach((o: any) => {
          let codes: any[] = [];
          try {
            codes = typeof o.discount_codes === 'string' ? JSON.parse(o.discount_codes) : (o.discount_codes || []);
          } catch { return; }
          if (!Array.isArray(codes) || codes.length === 0) return;
          codes.forEach((dc: any) => {
            const name = (dc.code || '').toUpperCase();
            if (!name) return;
            if (!codeMap[name]) codeMap[name] = { code: name, type: dc.type || '—', uses: 0, totalDiscount: 0, totalRevenue: 0 };
            codeMap[name].uses++;
            codeMap[name].totalDiscount += parseFloat(dc.amount) || 0;
            codeMap[name].totalRevenue += parseFloat(o.total_price) || 0;
          });
        });
        setPromoCodes(Object.values(codeMap).sort((a, b) => b.uses - a.uses));

        // Yesterday's products
        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000;
        const hkt = new Date(utc + 8 * 3600000);
        hkt.setDate(hkt.getDate() - 1);
        const yesterdayStr = hkt.toISOString().slice(0, 10);
        const yOrders = await queryWithDateRange('shopify_orders', 'id,financial_status,cancelled_at,created_at', 'created_at', { from: yesterdayStr, to: yesterdayStr });
        const yValidIds = new Set(yOrders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at).map((o: any) => o.id));
        const allLines = await queryAll('shopify_order_lines', 'order_id,product_id,title,vendor,quantity,price', undefined, 50000);
        const yLines = allLines.filter((l: any) => yValidIds.has(l.order_id));
        const prodMap: Record<string, { title: string; vendor: string; qty: number; revenue: number }> = {};
        yLines.forEach((l: any) => {
          const key = (l.product_id || '') + '|' + (l.title || '');
          if (!prodMap[key]) prodMap[key] = { title: l.title, vendor: l.vendor || '', qty: 0, revenue: 0 };
          prodMap[key].qty += l.quantity || 0;
          prodMap[key].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
        });
        setYesterdayProducts(Object.values(prodMap).sort((a, b) => b.qty - a.qty).slice(0, 20));
      } catch (e) {
        console.error('Overview load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  const mtdAov = mtdOrders > 0 ? mtdRevenue / mtdOrders : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="Shopify 營收" subtitle="Revenue" value={formatCurrency(shopifyRevenue)} icon={DollarSign} loading={loading} testId="kpi-shopify-rev" />
        <KpiCard title="BC 門店" subtitle="CARSHOP" value={formatCurrency(bcCarshopRevenue)} icon={Store} loading={loading} testId="kpi-carshop-rev" />
        <KpiCard title="BC 車房" subtitle="GARAGE" value={formatCurrency(bcGarageRevenue)} icon={Wrench} loading={loading} testId="kpi-garage-rev" />
        <KpiCard title="總訂單" subtitle="Orders" value={formatNumber(totalOrders)} icon={ShoppingCart} loading={loading} testId="kpi-orders" />
        <KpiCard title="平均單價" subtitle="AOV" value={formatCurrency(aov)} icon={TrendingUp} loading={loading} testId="kpi-aov" />
        <KpiCard title="Marsello 會員" subtitle="Members" value={formatNumber(marselloCount)} icon={Users} loading={loading} testId="kpi-marsello" />
      </div>

      {/* ── Monthly Targets 2×2 Grid ── */}
      <Card className="border-border/40 border-amber-500/20" data-testid="monthly-targets">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Target className="h-4 w-4 text-amber-400" />
            月度目標 <span className="text-xs font-normal text-muted-foreground">Monthly Targets</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <MonthlyTargetCard label="月銷售進度" sublabel="MTD Revenue" value={mtdRevenue} target={KPI_TARGETS.monthlyRevenue} unit="HKD" loading={loading} />
            <MonthlyTargetCard label="平均訂單" sublabel="AOV" value={mtdAov} target={KPI_TARGETS.aov} unit="HKD" loading={loading} />
            <MonthlyTargetCard label="毛利率" sublabel="Gross Margin %" value={mtdGrossMargin ?? 0} target={KPI_TARGETS.grossMarginPct} unit="%" loading={loading} />
            <MonthlyTargetCard label="新會員" sublabel="New Members" value={newMembersThisMonth} target={KPI_TARGETS.newMembersMonth} unit="" loading={loading} />
          </div>
        </CardContent>
      </Card>

      <ChartCard title="綜合營收趨勢" subtitle="Combined Revenue Trend" loading={loading}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={trendData}>
            <CartesianGrid {...GRID_STYLE} />
            <XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
            <Line type="monotone" dataKey="shopify" name="Shopify" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="bc" name="BC" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="total" name="Total" stroke={CHART_COLORS.tertiary} strokeWidth={2} dot={false} strokeDasharray="5 5" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="零售 vs 車房" subtitle="Retail vs Garage Split" loading={loading}>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={splitData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} dataKey="value" nameKey="name" paddingAngle={2}>
                {splitData.map((_, i) => <Cell key={i} fill={DONUT_PALETTE[i]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="廣告支出 vs 營收" subtitle="Meta Spend vs Shopify Revenue" loading={loading}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={adVsRevData}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="date" tick={AXIS_STYLE} />
              <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => name === 'spend' ? `HK$${v.toFixed(0)}` : formatCurrency(v)} />
              <Line yAxisId="left" type="monotone" dataKey="revenue" name="Revenue" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="spend" name="Ad Spend" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      {/* Active Promo Codes */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            活躍促銷碼 <span className="text-xs font-normal text-muted-foreground">Active Promo Codes (30 days)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[200px] w-full" /> : promoCodes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">近30日無促銷碼使用</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-promo-codes">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium">促銷碼 Code</th>
                    <th className="py-2 text-left font-medium">類型 Type</th>
                    <th className="py-2 text-right font-medium">使用次數 Uses</th>
                    <th className="py-2 text-right font-medium">折扣總額 Discount</th>
                    <th className="py-2 text-right font-medium">營收 Revenue</th>
                    <th className="py-2 text-right font-medium">均價 AOV</th>
                  </tr>
                </thead>
                <tbody>
                  {promoCodes.map((p) => (
                    <tr key={p.code} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 font-mono font-medium">{p.code}</td>
                      <td className="py-2"><Badge variant="secondary" className="text-[10px]">{p.type}</Badge></td>
                      <td className="py-2 text-right tabular-nums">{p.uses}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(p.totalDiscount)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(p.totalRevenue)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(p.uses > 0 ? p.totalRevenue / p.uses : 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Yesterday's Products */}
      <Card className="border-border/40">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-medium">
            昨日出售產品 <span className="text-xs font-normal text-muted-foreground">Yesterday's Products</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {loading ? <Skeleton className="h-[200px] w-full" /> : yesterdayProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">昨日無銷售數據</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-yesterday-products">
                <thead>
                  <tr className="border-b border-border/50 text-muted-foreground">
                    <th className="py-2 text-left font-medium w-8">#</th>
                    <th className="py-2 text-left font-medium">產品 Product</th>
                    <th className="py-2 text-left font-medium">品牌 Vendor</th>
                    <th className="py-2 text-right font-medium">數量 Qty</th>
                    <th className="py-2 text-right font-medium">營收 Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {yesterdayProducts.map((p, i) => (
                    <tr key={i} className="border-b border-border/20 hover:bg-accent/30 transition-colors">
                      <td className="py-2 text-muted-foreground">{i + 1}</td>
                      <td className="py-2 max-w-[250px] truncate">{p.title}</td>
                      <td className="py-2 text-muted-foreground">{p.vendor || '—'}</td>
                      <td className="py-2 text-right tabular-nums font-medium">{p.qty}</td>
                      <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
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
