import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAll, queryAllPages } from '@/lib/query-helpers';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import {
  DollarSign, ShoppingCart, TrendingUp, Calendar, Trophy, Package,
  ChevronDown, ChevronRight, AlertTriangle, Tag, Zap, Percent, Award,
  Monitor, Store, Bike, Cloud, Thermometer, Droplets, Wind, Users, ArrowUp, ArrowDown,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FoorirLogin } from '@/components/foorir-login';
import { getFoorirToken, getKPI, type FoorirKPI, type FoorirPeriod } from '@/lib/foorir';
import { PromoPerformance } from '@/components/promo-performance';
import { BrandMonthlySales } from '@/components/brand-monthly-sales';

// ── Types ─────────────────────────────────────────────────────
type ViewMode = 'yesterday' | 'this_week' | 'last_week';
type StockRisk = 'critical' | 'warning' | 'ok' | 'unknown';

interface EnrichedProduct {
  key: string;
  title: string;
  sku: string;
  vendor: string;
  productType: string;
  qty: number;
  revenue: number;
  stock: number | null;
  velocity: number;        // units per day (60-day avg)
  daysToStockout: number | null;
  risk: StockRisk;
}

interface CategorySummary {
  type: string;
  qty: number;
  revenue: number;
  brands: string[];
  products: EnrichedProduct[];
  criticalCount: number;
  warningCount: number;
}

// ── Date Helpers ──────────────────────────────────────────────
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
function getYesterday(): string {
  const hkt = getHKNow(); hkt.setDate(hkt.getDate() - 1); return toDateStr(hkt);
}
function getSameDayLastWeek(): string {
  const hkt = getHKNow(); hkt.setDate(hkt.getDate() - 8); return toDateStr(hkt);
}
function getThisWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const diff = hkt.getDay() === 0 ? 6 : hkt.getDay() - 1;
  const monday = new Date(hkt); monday.setDate(hkt.getDate() - diff);
  return { from: toDateStr(monday), to: toDateStr(getHKNow()) };
}
function getLastWeekBounds(): { from: string; to: string } {
  const hkt = getHKNow();
  const diff = hkt.getDay() === 0 ? 6 : hkt.getDay() - 1;
  const thisMonday = new Date(hkt); thisMonday.setDate(hkt.getDate() - diff);
  const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1);
  const lastMonday = new Date(lastSunday); lastMonday.setDate(lastSunday.getDate() - 6);
  return { from: toDateStr(lastMonday), to: toDateStr(lastSunday) };
}
function toHKTimeString(isoStr: string): string {
  const d = new Date(isoStr);
  const hkt = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${String(hkt.getHours()).padStart(2, '0')}:${String(hkt.getMinutes()).padStart(2, '0')}`;
}
function toHKDateStr(isoStr: string): string {
  const d = new Date(isoStr);
  const hk = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return toDateStr(hk);
}

// ── Stock Risk ────────────────────────────────────────────────
function computeRisk(stock: number | null, velocity: number): { risk: StockRisk; days: number | null } {
  if (stock === null) return { risk: 'unknown', days: null };
  if (stock === 0) return { risk: 'critical', days: 0 };
  if (velocity < 0.005) return { risk: 'unknown', days: null };
  const days = Math.floor(stock / velocity);
  if (days <= 7) return { risk: 'critical', days };
  if (days <= 21) return { risk: 'warning', days };
  return { risk: 'ok', days };
}

function RiskBadge({ risk, days }: { risk: StockRisk; days: number | null }) {
  if (risk === 'critical')
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 whitespace-nowrap">
        🔴 {days === 0 ? '缺貨' : `${days}天`}
      </span>
    );
  if (risk === 'warning')
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-500/20 text-yellow-400 whitespace-nowrap">
        🟡 {days}天
      </span>
    );
  if (risk === 'ok')
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/20 text-green-400 whitespace-nowrap">
        🟢 充足
      </span>
    );
  return <span className="text-[10px] text-muted-foreground/40">—</span>;
}

// ── Category Style ────────────────────────────────────────────
const CAT_GROUPS: Array<[string, { color: string; border: string; bg: string }]> = [
  ['HELMET',          { color: 'text-amber-400',   border: 'border-amber-500/30',   bg: 'bg-amber-500/5'   }],
  ['RIDER GEARS',     { color: 'text-blue-400',    border: 'border-blue-500/30',    bg: 'bg-blue-500/5'    }],
  ['ACCESSORIES',     { color: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' }],
  ['MOTORCYCLE PARTS',{ color: 'text-purple-400',  border: 'border-purple-500/30',  bg: 'bg-purple-500/5'  }],
];
function getCatStyle(type: string) {
  for (const [prefix, cfg] of CAT_GROUPS) {
    if (type.startsWith(prefix)) return cfg;
  }
  return { color: 'text-muted-foreground', border: 'border-gray-500/30', bg: 'bg-gray-500/5' };
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Pre-loaded staff roster — pick from this list when assigning names to user_ids
const STAFF_ROSTER = [
  'Bean Tang',
  'Dicky Leung',
  'Kenny Chu',
  'Part Time',
  'SLIVER Chong',
  'Tammy Tam',
  'Zoe Lau',
];

// ── HK Public Holidays 2025–2026 ─────────────────────────────
const HK_HOLIDAYS: Record<string, string> = {
  '2025-01-01': '元旦 New Year\'s Day',
  '2025-01-29': '農曆新年初一 CNY Day 1',
  '2025-01-30': '農曆新年初二 CNY Day 2',
  '2025-01-31': '農曆新年初三 CNY Day 3',
  '2025-04-04': '清明節 Ching Ming',
  '2025-04-18': '耶穌受難節 Good Friday',
  '2025-04-19': '受難節翌日 Day after Good Friday',
  '2025-04-21': '復活節星期一 Easter Monday',
  '2025-05-01': '勞動節 Labour Day',
  '2025-05-05': '佛誕 Buddha\'s Birthday',
  '2025-06-02': '端午節 Tuen Ng Festival',
  '2025-07-01': '香港回歸紀念日 HKSAR Establishment Day',
  '2025-09-07': '中秋節翌日 Day after Mid-Autumn',
  '2025-10-01': '國慶日 National Day',
  '2025-10-02': '國慶日翌日 Day after National Day',
  '2025-10-07': '重陽節 Chung Yeung Festival',
  '2025-12-25': '聖誕節 Christmas Day',
  '2025-12-26': '聖誕節後第一個周日 Boxing Day',
  '2026-01-01': '元旦 New Year\'s Day',
  '2026-02-17': '農曆新年初一 CNY Day 1',
  '2026-02-18': '農曆新年初二 CNY Day 2',
  '2026-02-19': '農曆新年初三 CNY Day 3',
  '2026-04-03': '耶穌受難節 Good Friday',
  '2026-04-04': '受難節翌日 / 清明節 Day after GF / Ching Ming',
  '2026-04-06': '復活節星期一 Easter Monday',
  '2026-05-01': '勞動節 Labour Day',
  '2026-05-25': '佛誕 Buddha\'s Birthday',
  '2026-06-19': '端午節 Tuen Ng Festival',
  '2026-07-01': '香港回歸紀念日 HKSAR Establishment Day',
  '2026-10-01': '國慶日 National Day',
  '2026-10-04': '中秋節翌日 Day after Mid-Autumn',
  '2026-10-26': '重陽節 Chung Yeung Festival',
  '2026-12-25': '聖誕節 Christmas Day',
  '2026-12-26': '聖誕節後第一個周日 Boxing Day',
};

// HK Observatory weather icon → emoji + label
function weatherLabel(icon: number | null): { emoji: string; label: string } {
  if (!icon) return { emoji: '🌡', label: '—' };
  if (icon === 50) return { emoji: '☁️', label: '多雲 Cloudy' };
  if (icon === 51) return { emoji: '☀️', label: '天晴 Fine' };
  if (icon === 52) return { emoji: '🌤', label: '間晴 Sunny Intervals' };
  if (icon === 53) return { emoji: '🌦', label: '間晴有驟雨 Sunny, Showers' };
  if (icon === 54) return { emoji: '⛈', label: '間晴有雷暴 Sunny, Thunderstorms' };
  if ([55, 56].includes(icon)) return { emoji: '🌦', label: '多雲有驟雨 Cloudy, Showers' };
  if (icon === 60) return { emoji: '☁️', label: '多雲 Overcast' };
  if (icon === 61) return { emoji: '🌫', label: '密雲 Dense Cloud' };
  if ([62, 63].includes(icon)) return { emoji: '🌧', label: '密雲有微雨 Overcast, Drizzle' };
  if ([64, 65].includes(icon)) return { emoji: '🌧', label: '有雨 Rain' };
  if ([66, 67].includes(icon)) return { emoji: '🌧', label: '大雨 Heavy Rain' };
  if (icon >= 70 && icon <= 76) return { emoji: '🌧', label: '大雨 Rainstorm' };
  if (icon === 80) return { emoji: '🌀', label: '熱帶氣旋 Tropical Cyclone' };
  if (icon >= 81 && icon <= 84) return { emoji: '⛈', label: '雷暴 Thunderstorm' };
  if ([90, 91].includes(icon)) return { emoji: '🌫', label: '霧 Fog/Mist' };
  if (icon === 93) return { emoji: '🔆', label: '酷熱 Very Hot' };
  return { emoji: '🌡', label: `Icon ${icon}` };
}

// ── Main Component ────────────────────────────────────────────
export default function DailyWeeklyPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('yesterday');
  const [loading, setLoading] = useState(true);
  const [allOrders, setAllOrders] = useState<any[]>([]);
  const [allOrderLines, setAllOrderLines] = useState<any[]>([]);
  const [lastYearOrders, setLastYearOrders] = useState<any[]>([]);
  const [inventoryMap, setInventoryMap] = useState<Record<string, number>>({});
  const [productTypeMap, setProductTypeMap] = useState<Record<string, string>>({});
  const [expandedCats, setExpandedCats] = useState<Set<string> | 'all'>('all');
  const [foorirData, setFoorirData] = useState<FoorirKPI | null>(null);
  const [foorirConnected, setFoorirConnected] = useState(false);
  const [weather, setWeather] = useState<{
    temp: number | null;
    humidity: number | null;
    icon: number | null;
    warning: string;
    updateTime: string;
    forecast: Array<{ date: string; maxTemp: number; minTemp: number; desc: string; icon: number; psr: string }>;
  }>({
    temp: null, humidity: null, icon: null, warning: '', updateTime: '', forecast: [],
  });

  // ── Staff name mapping (localStorage) ──────────────────
  const [staffNames, setStaffNames] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('hk_staff_names') || '{}'); } catch { return {}; }
  });
  const [editingUid, setEditingUid] = useState<string | null>(null);
  const [editName, setEditName]     = useState('');

  function saveStaffName(uid: string, name: string) {
    const updated = { ...staffNames, [uid]: name.trim() };
    setStaffNames(updated);
    localStorage.setItem('hk_staff_names', JSON.stringify(updated));
    setEditingUid(null);
  }
  function getStaffName(uid: string) {
    return staffNames[uid] || `Staff ···${uid.slice(-4)}`;
  }

  // ── Weather: HK Observatory API ─────────────────────────
  useEffect(() => {
    async function fetchWeather() {
      try {
        const [curr, fnd] = await Promise.all([
          fetch('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en').then(r => r.json()),
          fetch('https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en').then(r => r.json()),
        ]);
        const tempArr = curr?.temperature?.data || [];
        const hkoTemp = tempArr.find((t: any) => t.place?.includes('Observatory'))?.value ?? tempArr[0]?.value ?? null;
        const humidity = curr?.humidity?.data?.[0]?.value ?? null;
        const icon     = (curr?.icon?.[0]) ?? null;
        const warning  = curr?.warningMessage ?? '';
        const updateTime = curr?.updateTime ?? '';
        const forecast = (fnd?.weatherForecast || []).slice(0, 7).map((f: any) => ({
          date:    String(f.forecastDate),
          maxTemp: f.forecastMaxtemp?.value,
          minTemp: f.forecastMintemp?.value,
          desc:    f.forecastWeather,
          icon:    f.ForecastIcon,
          psr:     f.PSR,
        }));
        setWeather({ temp: hkoTemp, humidity, icon, warning, updateTime, forecast });
      } catch (e) {
        console.warn('Weather fetch failed:', e);
      }
    }
    fetchWeather();
  }, []);

  // ── Data Loading ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // Load from 1st of current month OR 45 days ago, whichever is earlier
        // (ensures full MTD coverage even in late month)
        const hktNow    = getHKNow();
        const firstOfMo = new Date(hktNow.getFullYear(), hktNow.getMonth(), 1);
        const fortyFiveAgo = new Date(hktNow); fortyFiveAgo.setDate(hktNow.getDate() - 45);
        const fromDate  = toDateStr(firstOfMo < fortyFiveAgo ? fortyFiveAgo : firstOfMo);

        // Phase 1: parallel
        const [ordersRaw, orderLines, productsData] = await Promise.all([
          (async () => {
            const { data } = await supabase
              .from('shopify_orders')
              .select('id,order_number,created_at,total_price,financial_status,cancelled_at,customer_name,customer_id,discount_codes,source_name,user_id')
              .gte('created_at', fromDate)
              .limit(5000);
            return (data || []) as any[];
          })(),
          queryAllPages(
            'shopify_order_lines',
            'order_id,product_id,title,sku,vendor,quantity,price,product_type,created_at'
          ) as Promise<any[]>,
          queryAllPages('shopify_products', 'id,product_type') as Promise<any[]>,
        ]);

        if (cancelled) return;

        setAllOrders(ordersRaw.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at));
        setAllOrderLines(orderLines);

        // Build product_id → product_type lookup
        const ptMap: Record<string, string> = {};
        productsData.forEach((p: any) => {
          if (p.id && p.product_type) ptMap[String(p.id)] = p.product_type;
        });
        setProductTypeMap(ptMap);

        // Phase 2: batch inventory for sold SKUs
        const skuList = [...new Set(orderLines.map((l: any) => l.sku).filter(Boolean))] as string[];
        const invMap: Record<string, number> = {};
        const BATCH = 100;
        for (let i = 0; i < skuList.length; i += BATCH) {
          if (cancelled) break;
          const { data: invData } = await supabase
            .from('shopify_inventory')
            .select('sku,inventory_quantity')
            .in('sku', skuList.slice(i, i + BATCH));
          (invData || []).forEach((r: any) => {
            if (r.sku) invMap[r.sku] = Math.max(0, r.inventory_quantity || 0);
          });
        }
        if (!cancelled) setInventoryMap(invMap);

        // Phase 3: fetch last year same-period orders for weekly comparison chart
        // Get this week Mon & last week Mon, then compute the same dates last year
        const twBounds = getThisWeekBounds();
        const lwBounds = getLastWeekBounds();
        const lyThisMonday = new Date(twBounds.from + 'T00:00:00');
        lyThisMonday.setFullYear(lyThisMonday.getFullYear() - 1);
        const lyLastMonday = new Date(lwBounds.from + 'T00:00:00');
        lyLastMonday.setFullYear(lyLastMonday.getFullYear() - 1);
        const lyFrom = toDateStr(lyLastMonday < lyThisMonday ? lyLastMonday : lyThisMonday);
        const lySunday = new Date(lyThisMonday);
        lySunday.setDate(lyThisMonday.getDate() + 6);
        const lyTo = toDateStr(lySunday);

        const { data: lyData } = await supabase
          .from('shopify_orders')
          .select('id,order_number,created_at,total_price,financial_status,cancelled_at')
          .gte('created_at', lyFrom)
          .lte('created_at', lyTo + 'T23:59:59')
          .limit(5000);
        if (!cancelled) {
          setLastYearOrders(
            (lyData || []).filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at)
          );
        }
      } catch (e) {
        console.error('Daily/Weekly load error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Static date values ────────────────────────────────────
  const yesterday     = useMemo(() => getYesterday(), []);
  const sameDayLW     = useMemo(() => getSameDayLastWeek(), []);
  const thisWeek      = useMemo(() => getThisWeekBounds(), []);
  const lastWeek      = useMemo(() => getLastWeekBounds(), []);

  const filterOrders = useCallback(
    (orders: any[], from: string, to: string) =>
      orders.filter((o: any) => { const d = toHKDateStr(o.created_at); return d >= from && d <= to; }),
    []
  );

  // ── Velocity: units per day over last 60 days ─────────────
  const velocityMap = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString();
    const qMap: Record<string, number> = {};
    allOrderLines.forEach((l: any) => {
      if (l.created_at >= cutoffStr && l.sku)
        qMap[l.sku] = (qMap[l.sku] || 0) + (l.quantity || 0);
    });
    const vMap: Record<string, number> = {};
    Object.entries(qMap).forEach(([k, v]) => { vMap[k] = v / 60; });
    return vMap;
  }, [allOrderLines]);

  // ── Yesterday orders ──────────────────────────────────────
  const yOrders  = useMemo(() => filterOrders(allOrders, yesterday, yesterday),  [allOrders, yesterday, filterOrders]);
  const lwOrders = useMemo(() => filterOrders(allOrders, sameDayLW, sameDayLW),  [allOrders, sameDayLW,  filterOrders]);
  const yRevenue  = useMemo(() => yOrders.reduce( (s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [yOrders]);
  const lwRevenue = useMemo(() => lwOrders.reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [lwOrders]);
  const yAov  = yOrders.length  > 0 ? yRevenue  / yOrders.length  : 0;
  const lwAov = lwOrders.length > 0 ? lwRevenue / lwOrders.length : 0;
  const calcDelta = (curr: number, prev: number) => prev === 0 ? null : ((curr - prev) / prev) * 100;

  // ── Channel breakdown (from shopify source_name) ───────────
  const channelBreakdown = useMemo(() => {
    const groups: Record<string, any[]> = { pos: [], web: [], referral: [], other: [] };
    yOrders.forEach((o: any) => {
      const src = (o.source_name || '').toLowerCase();
      if (src === 'pos' || /^\d+$/.test(src)) groups.pos.push(o);
      else if (src === 'web' || src === 'mobile_web' || src === 'online_store') groups.web.push(o);
      else if (src.startsWith('http')) groups.referral.push(o);
      else if (src) groups.other.push(o);
      else groups.other.push(o);
    });
    const calc = (list: any[]) => ({
      count: list.length,
      revenue: list.reduce((s, o) => s + (parseFloat(o.total_price) || 0), 0),
      aov: list.length > 0 ? list.reduce((s, o) => s + (parseFloat(o.total_price) || 0), 0) / list.length : 0,
    });
    // Referral domains
    const refDomains: Record<string, number> = {};
    groups.referral.forEach((o: any) => {
      try { const host = new URL(o.source_name).hostname.replace('www.',''); refDomains[host] = (refDomains[host]||0)+1; } catch {}
    });
    return {
      pos:      calc(groups.pos),
      web:      calc(groups.web),
      referral: { ...calc(groups.referral), domains: refDomains },
      other:    calc(groups.other),
    };
  }, [yOrders]);

  // ── Staff performance ─────────────────────────────────────
  const [staffTab, setStaffTab] = useState<'yesterday' | 'this_week' | 'this_month'>('yesterday');

  const staffPerformance = useMemo(() => {
    const hktNow  = getHKNow();
    const mtdStart = toDateStr(new Date(hktNow.getFullYear(), hktNow.getMonth(), 1));
    const wkStart  = thisWeek.from;
    const wkEnd    = toDateStr(hktNow);

    const toMap = (orders: any[]) => {
      const m: Record<string, { rev: number; cnt: number }> = {};
      orders.filter((o: any) => o.user_id).forEach((o: any) => {
        const uid = String(o.user_id);
        if (!m[uid]) m[uid] = { rev: 0, cnt: 0 };
        m[uid].rev += parseFloat(o.total_price) || 0;
        m[uid].cnt++;
      });
      return m;
    };

    const dayMap  = toMap(yOrders);
    const wkMap   = toMap(filterOrders(allOrders, wkStart, wkEnd));
    const mtdMap  = toMap(filterOrders(allOrders, mtdStart, toDateStr(hktNow)));

    const allUids = [...new Set([
      ...Object.keys(dayMap),
      ...Object.keys(wkMap),
      ...Object.keys(mtdMap),
    ])];

    const rows = allUids.map(uid => ({
      uid,
      dayRev: dayMap[uid]?.rev  || 0,  dayCnt: dayMap[uid]?.cnt  || 0,
      wkRev:  wkMap[uid]?.rev   || 0,  wkCnt:  wkMap[uid]?.cnt   || 0,
      mtdRev: mtdMap[uid]?.rev  || 0,  mtdCnt: mtdMap[uid]?.cnt  || 0,
    }));

    // Sort by the currently active tab
    return rows.sort((a, b) =>
      staffTab === 'yesterday' ? b.dayRev - a.dayRev :
      staffTab === 'this_week' ? b.wkRev  - a.wkRev  :
      b.mtdRev - a.mtdRev
    );
  }, [allOrders, yOrders, thisWeek, filterOrders, staffTab]);

  // ── Yesterday holiday / upcoming holidays ──────────────
  const yesterdayHoliday = HK_HOLIDAYS[yesterday] || null;
  const upcomingHolidays = useMemo(() => {
    const today   = toDateStr(getHKNow());
    const cutoff  = new Date(today); cutoff.setDate(cutoff.getDate() + 14);
    const cutStr  = toDateStr(cutoff);
    return Object.entries(HK_HOLIDAYS)
      .filter(([d]) => d >= today && d <= cutStr)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 3);
  }, [yesterday]);

  // ── Enrich product entry ──────────────────────────────────
  const enrichProduct = useCallback(
    (key: string, base: { title: string; sku: string; vendor: string; productType: string; qty: number; revenue: number }): EnrichedProduct => {
      const stock    = base.sku && base.sku in inventoryMap ? inventoryMap[base.sku] : null;
      const velocity = base.sku ? (velocityMap[base.sku] || 0) : 0;
      const { risk, days } = computeRisk(stock, velocity);
      return { key, ...base, stock, velocity, daysToStockout: days, risk };
    },
    [inventoryMap, velocityMap]
  );

  // ── Yesterday products (enriched) ────────────────────────
  const yProducts = useMemo((): EnrichedProduct[] => {
    const orderIds = new Set(yOrders.map((o: any) => String(o.id)));
    const lines = allOrderLines.filter((l: any) => orderIds.has(String(l.order_id)));
    const map: Record<string, { title: string; sku: string; vendor: string; productType: string; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => {
      const k = l.product_id ? String(l.product_id) : (l.title || 'unknown');
      const pt = l.product_type || productTypeMap[String(l.product_id)] || 'Other';
      if (!map[k]) {
        map[k] = { title: l.title || '', sku: l.sku || '', vendor: l.vendor || '', productType: pt, qty: 0, revenue: 0 };
      }
      map[k].qty     += l.quantity || 0;
      map[k].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
      if (!map[k].sku && l.sku) map[k].sku = l.sku;
      if ((!map[k].productType || map[k].productType === 'Other') && pt !== 'Other') map[k].productType = pt;
    });
    return Object.entries(map)
      .map(([k, v]) => enrichProduct(k, v))
      .sort((a, b) => b.qty - a.qty);
  }, [yOrders, allOrderLines, productTypeMap, enrichProduct]);

  // ── Category breakdown for yesterday ─────────────────────
  const catBreakdown = useMemo((): CategorySummary[] => {
    const catMap: Record<string, CategorySummary> = {};
    yProducts.forEach(p => {
      const type = p.productType || 'Other';
      if (!catMap[type]) catMap[type] = { type, qty: 0, revenue: 0, brands: [], products: [], criticalCount: 0, warningCount: 0 };
      catMap[type].qty     += p.qty;
      catMap[type].revenue += p.revenue;
      catMap[type].products.push(p);
      if (p.vendor && !catMap[type].brands.includes(p.vendor)) catMap[type].brands.push(p.vendor);
      if (p.risk === 'critical') catMap[type].criticalCount++;
      else if (p.risk === 'warning') catMap[type].warningCount++;
    });
    return Object.values(catMap).sort((a, b) => b.revenue - a.revenue);
  }, [yProducts]);



  // ── Week data ─────────────────────────────────────────────
  const isWeekView = viewMode !== 'yesterday';
  const wkBounds = useMemo(() => viewMode === 'last_week' ? lastWeek : thisWeek, [viewMode, lastWeek, thisWeek]);
  const prevWkBounds = useMemo(() => {
    if (viewMode === 'last_week') {
      const d1 = new Date(lastWeek.from); d1.setDate(d1.getDate() - 7);
      const d2 = new Date(lastWeek.to);   d2.setDate(d2.getDate() - 7);
      return { from: toDateStr(d1), to: toDateStr(d2) };
    }
    return lastWeek;
  }, [viewMode, lastWeek]);

  const weekOrders    = useMemo(() => filterOrders(allOrders, wkBounds.from, wkBounds.to),       [allOrders, wkBounds,    filterOrders]);
  const prevWkOrders  = useMemo(() => filterOrders(allOrders, prevWkBounds.from, prevWkBounds.to),[allOrders, prevWkBounds, filterOrders]);
  const wRevenue  = useMemo(() => weekOrders.reduce(   (s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [weekOrders]);
  const pwRevenue = useMemo(() => prevWkOrders.reduce( (s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0), [prevWkOrders]);

  const bestDay = useMemo(() => {
    const dm: Record<string, number> = {};
    weekOrders.forEach((o: any) => {
      const d = toHKDateStr(o.created_at);
      dm[d] = (dm[d] || 0) + (parseFloat(o.total_price) || 0);
    });
    const entries = Object.entries(dm).sort((a, b) => b[1] - a[1]);
    return entries[0] ? { date: entries[0][0], revenue: entries[0][1] } : { date: '', revenue: 0 };
  }, [weekOrders]);

  const bestProduct = useMemo(() => {
    const ids = new Set(weekOrders.map((o: any) => String(o.id)));
    const lines = allOrderLines.filter((l: any) => ids.has(String(l.order_id)));
    const pm: Record<string, { title: string; qty: number }> = {};
    lines.forEach((l: any) => {
      const k = l.title || String(l.product_id);
      if (!pm[k]) pm[k] = { title: l.title || k, qty: 0 };
      pm[k].qty += l.quantity || 0;
    });
    return Object.values(pm).sort((a, b) => b.qty - a.qty)[0] || { title: '—', qty: 0 };
  }, [weekOrders, allOrderLines]);

  const weeklyBarData = useMemo(() => {
    const start = new Date(wkBounds.from + 'T00:00:00');
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = toDateStr(d);
      const rev = filterOrders(allOrders, ds, ds).reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);
      return { day: DAY_NAMES[i], revenue: rev };
    });
  }, [allOrders, wkBounds, filterOrders]);

  // ── Weekly comparison: this week vs last week vs last year same week ──
  const weekComparisonData = useMemo(() => {
    // Current week Mon-Sun
    const twStart = new Date(wkBounds.from + 'T00:00:00');
    // Previous week bounds
    const pwStart = new Date(prevWkBounds.from + 'T00:00:00');
    // Last year same week (aligned by day of week, not exact date)
    const lyStart = new Date(twStart);
    lyStart.setFullYear(lyStart.getFullYear() - 1);

    // Helper: sum revenue for orders on a given HK date string
    const revForDate = (orders: any[], dateStr: string) =>
      orders.filter((o: any) => toHKDateStr(o.created_at) === dateStr)
        .reduce((s: number, o: any) => s + (parseFloat(o.total_price) || 0), 0);

    return Array.from({ length: 7 }, (_, i) => {
      const twDate = new Date(twStart); twDate.setDate(twStart.getDate() + i);
      const pwDate = new Date(pwStart); pwDate.setDate(pwStart.getDate() + i);
      const lyDate = new Date(lyStart); lyDate.setDate(lyStart.getDate() + i);

      const twStr = toDateStr(twDate);
      const pwStr = toDateStr(pwDate);
      const lyStr = toDateStr(lyDate);

      return {
        day: DAY_NAMES[i],
        thisWeek: revForDate(allOrders, twStr),
        lastWeek: revForDate(allOrders, pwStr),
        lastYear: revForDate(lastYearOrders, lyStr),
      };
    });
  }, [allOrders, lastYearOrders, wkBounds, prevWkBounds]);

  const weekTopProducts = useMemo(() => {
    const ids = new Set(weekOrders.map((o: any) => String(o.id)));
    const lines = allOrderLines.filter((l: any) => ids.has(String(l.order_id)));
    const pm: Record<string, { title: string; qty: number; revenue: number }> = {};
    lines.forEach((l: any) => {
      const k = l.title || String(l.product_id);
      if (!pm[k]) pm[k] = { title: l.title || k, qty: 0, revenue: 0 };
      pm[k].qty     += l.quantity || 0;
      pm[k].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.values(pm).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [weekOrders, allOrderLines]);

  // Week category breakdown (for table) — with per-product items for expand
  const weekCatBreakdown = useMemo(() => {
    const ids = new Set(weekOrders.map((o: any) => String(o.id)));
    const lines = allOrderLines.filter((l: any) => ids.has(String(l.order_id)));
    const cm: Record<string, { type: string; qty: number; revenue: number; brands: Set<string>; skus: number; items: Record<string, { title: string; vendor: string; qty: number; revenue: number }> }> = {};
    lines.forEach((l: any) => {
      const type = l.product_type || productTypeMap[String(l.product_id)] || 'Other';
      if (!cm[type]) cm[type] = { type, qty: 0, revenue: 0, brands: new Set(), skus: 0, items: {} };
      cm[type].qty     += l.quantity || 0;
      cm[type].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
      if (l.vendor) cm[type].brands.add(l.vendor);
      cm[type].skus++;
      // Track per-product items
      const itemKey = l.title || String(l.product_id) || 'unknown';
      if (!cm[type].items[itemKey]) cm[type].items[itemKey] = { title: l.title || itemKey, vendor: l.vendor || '', qty: 0, revenue: 0 };
      cm[type].items[itemKey].qty += l.quantity || 0;
      cm[type].items[itemKey].revenue += (parseFloat(l.price) || 0) * (l.quantity || 0);
    });
    return Object.values(cm)
      .map(c => ({ ...c, brands: [...c.brands], itemList: Object.values(c.items).sort((a, b) => b.revenue - a.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [weekOrders, allOrderLines, productTypeMap]);
  const [expandedWeekCats, setExpandedWeekCats] = useState<Set<string>>(new Set());

  const toggleCat = useCallback((type: string) => {
    setExpandedCats(prev => {
      if (prev === 'all') {
        // First click from 'all' state: collapse this one category
        const allTypes = catBreakdown.map(c => c.type);
        const next = new Set(allTypes);
        next.delete(type);
        return next;
      }
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, [catBreakdown]);

  // ── Active Promotions (discount codes with ongoing usage) ──
  const activePromotions = useMemo(() => {
    // Look at last 30 days of orders with discount codes
    const hkt = getHKNow();
    const thirtyAgo = new Date(hkt); thirtyAgo.setDate(hkt.getDate() - 30);
    const thirtyStr = toDateStr(thirtyAgo);
    const recentOrders = allOrders.filter((o: any) => toHKDateStr(o.created_at) >= thirtyStr && o.discount_codes);

    const codeMap: Record<string, { code: string; uses: number; totalDiscount: number; totalSales: number; firstUse: string; lastUse: string; yesterdayUses: number; yesterdaySales: number }> = {};
    recentOrders.forEach((o: any) => {
      try {
        const codes = typeof o.discount_codes === 'string' ? JSON.parse(o.discount_codes) : o.discount_codes;
        if (!Array.isArray(codes)) return;
        const orderDate = toHKDateStr(o.created_at);
        codes.forEach((c: any) => {
          const code = (c.code || '').trim();
          if (!code) return;
          // Skip random loyalty codes (pattern: single letter + 7 digits)
          if (/^[A-Z]\d{7}$/.test(code)) return;
          const amt = parseFloat(c.amount || '0');
          if (!codeMap[code]) codeMap[code] = { code, uses: 0, totalDiscount: 0, totalSales: 0, firstUse: orderDate, lastUse: orderDate, yesterdayUses: 0, yesterdaySales: 0 };
          codeMap[code].uses++;
          codeMap[code].totalDiscount += amt;
          codeMap[code].totalSales += parseFloat(o.total_price) || 0;
          if (orderDate < codeMap[code].firstUse) codeMap[code].firstUse = orderDate;
          if (orderDate > codeMap[code].lastUse) codeMap[code].lastUse = orderDate;
          if (orderDate === yesterday) {
            codeMap[code].yesterdayUses++;
            codeMap[code].yesterdaySales += parseFloat(o.total_price) || 0;
          }
        });
      } catch {}
    });
    // Only show codes used 2+ times or used yesterday
    return Object.values(codeMap)
      .filter(c => c.uses >= 2 || c.yesterdayUses > 0)
      .sort((a, b) => b.uses - a.uses);
  }, [allOrders, yesterday]);

  // ── Brand Sales: Yesterday vs Day Before ──────────────────
  const [expandedBrands, setExpandedBrands] = useState<Set<string>>(new Set());
  const brandComparison = useMemo(() => {
    const dayBefore = (() => { const d = new Date(yesterday + 'T00:00:00'); d.setDate(d.getDate() - 1); return toDateStr(d); })();
    const yOrderIds = new Set(yOrders.map((o: any) => String(o.id)));
    const dbOrders = filterOrders(allOrders, dayBefore, dayBefore);
    const dbOrderIds = new Set(dbOrders.map((o: any) => String(o.id)));

    type ItemDetail = { title: string; qty: number; revenue: number };
    const yBrands: Record<string, { qty: number; revenue: number; items: Record<string, ItemDetail> }> = {};
    const dbBrands: Record<string, { qty: number; revenue: number; items: Record<string, ItemDetail> }> = {};

    allOrderLines.forEach((l: any) => {
      const vendor = l.vendor || 'Other';
      const qty = l.quantity || 0;
      const rev = (parseFloat(l.price) || 0) * qty;
      const title = l.title || 'unknown';
      if (yOrderIds.has(String(l.order_id))) {
        if (!yBrands[vendor]) yBrands[vendor] = { qty: 0, revenue: 0, items: {} };
        yBrands[vendor].qty += qty;
        yBrands[vendor].revenue += rev;
        if (!yBrands[vendor].items[title]) yBrands[vendor].items[title] = { title, qty: 0, revenue: 0 };
        yBrands[vendor].items[title].qty += qty;
        yBrands[vendor].items[title].revenue += rev;
      }
      if (dbOrderIds.has(String(l.order_id))) {
        if (!dbBrands[vendor]) dbBrands[vendor] = { qty: 0, revenue: 0, items: {} };
        dbBrands[vendor].qty += qty;
        dbBrands[vendor].revenue += rev;
        if (!dbBrands[vendor].items[title]) dbBrands[vendor].items[title] = { title, qty: 0, revenue: 0 };
        dbBrands[vendor].items[title].qty += qty;
        dbBrands[vendor].items[title].revenue += rev;
      }
    });

    const allVendors = [...new Set([...Object.keys(yBrands), ...Object.keys(dbBrands)])];
    return allVendors.map(v => ({
      vendor: v,
      yQty: yBrands[v]?.qty || 0,
      yRevenue: yBrands[v]?.revenue || 0,
      dbQty: dbBrands[v]?.qty || 0,
      dbRevenue: dbBrands[v]?.revenue || 0,
      qtyDelta: (yBrands[v]?.qty || 0) - (dbBrands[v]?.qty || 0),
      revDelta: (yBrands[v]?.revenue || 0) - (dbBrands[v]?.revenue || 0),
      yItems: Object.values(yBrands[v]?.items || {}).sort((a, b) => b.revenue - a.revenue),
      dbItems: Object.values(dbBrands[v]?.items || {}).sort((a, b) => b.revenue - a.revenue),
    })).sort((a, b) => b.yRevenue - a.yRevenue);
  }, [yOrders, allOrders, allOrderLines, yesterday, filterOrders]);

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* View Toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['yesterday', 'this_week', 'last_week'] as ViewMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            data-testid={`btn-view-${mode}`}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              viewMode === mode
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent/50 text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            {mode === 'yesterday' ? '昨日 Yesterday' : mode === 'this_week' ? '本週 This Week' : '上週 Last Week'}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">
          {viewMode === 'yesterday' ? yesterday : `${wkBounds.from} → ${wkBounds.to}`}
        </span>
      </div>

      {/* ═══════════════════════════ YESTERDAY VIEW ════════════════════════════ */}
      {viewMode === 'yesterday' && (
        <>
          {/* ── Weather + Holiday Card ──────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Weather */}
            <Card className="border-border/40">
              <CardHeader className="pb-1 pt-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Cloud className="h-3.5 w-3.5 text-blue-400" />
                  昨日天氣 <span className="text-xs font-normal text-muted-foreground">HK Weather (Observatory)</span>
                  {weather.warning && (
                    <span className="ml-auto text-[10px] font-semibold text-red-400 px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/30">
                      ⚠️ {weather.warning}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                {weather.temp === null ? (
                  <p className="text-xs text-muted-foreground">載入中...</p>
                ) : (
                  <>
                    {/* Current conditions */}
                    <div className="flex items-center gap-4 mb-3">
                      <span className="text-4xl">{weatherLabel(weather.icon).emoji}</span>
                      <div>
                        <p className="text-2xl font-bold tabular-nums">{weather.temp}°C</p>
                        <p className="text-xs text-muted-foreground">{weatherLabel(weather.icon).label}</p>
                        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                          <span className="flex items-center gap-1"><Droplets className="h-3 w-3" />{weather.humidity}%</span>
                          <span className="text-muted-foreground/40">天文台 {weather.updateTime?.slice(11,16)} HKT</span>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Holidays + Context */}
            <Card className="border-border/40">
              <CardHeader className="pb-1 pt-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5 text-red-400" />
                  假期 / 人流影響 <span className="text-xs font-normal text-muted-foreground">HK Holidays & Foot Traffic</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                {/* Yesterday holiday status */}
                <div className={`rounded-lg p-3 mb-3 ${ yesterdayHoliday ? 'bg-red-500/10 border border-red-500/20' : 'bg-green-500/5 border border-green-500/15' }`}>
                  <p className="text-xs font-semibold mb-0.5">
                    {yesterdayHoliday ? '🔴 昨日為公眾假期' : '🟢 昨日非假期'}
                  </p>
                  {yesterdayHoliday ? (
                    <p className="text-[11px] text-red-300">{yesterdayHoliday}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">普通工作日 / 周末，人流屬正常水平</p>
                  )}
                </div>
                {/* Upcoming holidays */}
                {upcomingHolidays.length > 0 && (
                  <div>
                    <p className="text-[11px] text-muted-foreground font-medium mb-1.5">未來 14 日假期 Upcoming:</p>
                    <div className="space-y-1">
                      {upcomingHolidays.map(([date, name]) => {
                        const days = Math.round((new Date(date).getTime() - new Date(toDateStr(getHKNow())).getTime()) / 86400000);
                        return (
                          <div key={date} className="flex items-center justify-between text-[11px] bg-amber-500/5 border border-amber-500/15 rounded px-2 py-1">
                            <span className="text-amber-300 font-medium">{date}</span>
                            <span className="text-muted-foreground truncate mx-2 flex-1">{name}</span>
                            <span className="text-amber-400 shrink-0">{days === 0 ? '今日' : days === 1 ? '明日' : `${days}日後`}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {upcomingHolidays.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">未來 14 日無公眾假期</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Sales Channel Breakdown ───────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Store className="h-3.5 w-3.5 text-primary" />
                銷售渠道分析
                <span className="text-xs font-normal text-muted-foreground">Sales Channel Breakdown — {yesterday}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[1,2,3,4].map(i => <Skeleton key={i} className="h-20" />)}
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Channel cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { key: 'pos',      label: '門市 POS',          icon: Store,   color: 'text-amber-400',  border: 'border-amber-500/20',  bg: 'bg-amber-500/5',   data: channelBreakdown.pos },
                      { key: 'web',      label: '網店 Online',        icon: Monitor, color: 'text-blue-400',   border: 'border-blue-500/20',   bg: 'bg-blue-500/5',    data: channelBreakdown.web },
                      { key: 'referral', label: '轉介 Referral',      icon: Bike,    color: 'text-green-400',  border: 'border-green-500/20',  bg: 'bg-green-500/5',   data: channelBreakdown.referral },
                      { key: 'other',    label: '其他 Other',         icon: Zap,     color: 'text-muted-foreground',   border: 'border-gray-500/20',   bg: 'bg-gray-500/5',    data: channelBreakdown.other },
                    ].map(ch => (
                      <div key={ch.key} className={`rounded-lg border ${ch.border} ${ch.bg} p-3`}>
                        <div className="flex items-center gap-1.5 mb-2">
                          <ch.icon className={`h-3.5 w-3.5 ${ch.color}`} />
                          <span className={`text-[11px] font-semibold ${ch.color}`}>{ch.label}</span>
                        </div>
                        <p className="text-lg font-bold tabular-nums">{formatCurrency(ch.data.revenue)}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                          <span>{ch.data.count} 單</span>
                          {ch.data.count > 0 && <span>AOV {formatCurrency(ch.data.aov)}</span>}
                        </div>
                        {'domains' in ch.data && Object.keys(ch.data.domains).length > 0 && (
                          <div className="mt-1.5">
                            {Object.entries(ch.data.domains as Record<string,number>).slice(0,2).map(([d,n]) => (
                              <p key={d} className="text-[10px] text-muted-foreground/70 truncate">{d} ×{n}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="昨日營收" subtitle="Revenue"       value={formatCurrency(yRevenue)}       icon={DollarSign}  loading={loading} delta={calcDelta(yRevenue,      lwRevenue)}      testId="kpi-y-rev" />
            <KpiCard title="昨日訂單" subtitle="Orders"        value={formatNumber(yOrders.length)}   icon={ShoppingCart} loading={loading} delta={calcDelta(yOrders.length, lwOrders.length)} testId="kpi-y-orders" />
            <KpiCard title="昨日均價" subtitle="AOV"           value={formatCurrency(yAov)}           icon={TrendingUp}  loading={loading} delta={calcDelta(yAov,          lwAov)}           testId="kpi-y-aov" />
            <KpiCard title="上週同日" subtitle="Same Day LW"   value={formatCurrency(lwRevenue)}      icon={Calendar}    loading={loading}                                                    testId="kpi-y-lw" />
          </div>

          {/* ── Foot Traffic (Foorir) ────────────────────────── */}
          <FoorirLogin
            compact
            onSuccess={async () => {
              setFoorirConnected(true);
              const data = await getKPI('yesterday');
              if (data) setFoorirData(data);
            }}
          />
          {foorirConnected && foorirData && (
            <Card className="border-border/40">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-cyan-400" />
                  昨日客流
                  <span className="text-xs font-normal text-muted-foreground">Foot Traffic — {yesterday}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: '進店人數', sublabel: 'Entered', value: foorirData.flowIn, color: 'text-cyan-400' },
                    { label: '路過人數', sublabel: 'Passerby', value: foorirData.flowPassby, color: 'text-blue-400' },
                    { label: '團體客', sublabel: 'Groups', value: foorirData.batch, color: 'text-purple-400' },
                    {
                      label: '轉化率',
                      sublabel: 'Conversion',
                      value: foorirData.flowIn > 0 ? ((yOrders.length / foorirData.flowIn) * 100) : 0,
                      color: 'text-green-400',
                      isPercent: true,
                    },
                  ].map((m, i) => (
                    <div key={i} className="rounded-lg border border-border/30 bg-accent/20 p-3">
                      <p className={`text-[11px] font-medium ${m.color}`}>{m.label}</p>
                      <p className="text-xs text-muted-foreground mb-1">{m.sublabel}</p>
                      <p className="text-lg font-bold tabular-nums">
                        {'isPercent' in m && m.isPercent
                          ? `${(m.value as number).toFixed(1)}%`
                          : formatNumber(m.value)}
                      </p>
                    </div>
                  ))}
                </div>
                {foorirData.flowIn > 0 && (
                  <div className="mt-3 grid grid-cols-3 gap-3 text-[11px]">
                    <div className="rounded border border-border/20 p-2 text-center">
                      <p className="text-muted-foreground">每客消費</p>
                      <p className="font-semibold tabular-nums">{formatCurrency(yRevenue / foorirData.flowIn)}</p>
                    </div>
                    <div className="rounded border border-border/20 p-2 text-center">
                      <p className="text-muted-foreground">成人</p>
                      <p className="font-semibold tabular-nums">{formatNumber(foorirData.adult)}</p>
                    </div>
                    <div className="rounded border border-border/20 p-2 text-center">
                      <p className="text-muted-foreground">平均停留</p>
                      <p className="font-semibold tabular-nums">{foorirData.averageDwellTime > 0 ? `${Math.round(foorirData.averageDwellTime)}分` : '—'}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Brand Monthly Sales (MTD) ─────────────────────── */}
          <BrandMonthlySales
            allOrders={allOrders}
            allOrderLines={allOrderLines}
            loading={loading}
          />

          {/* ── Active Promotions ─────────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Percent className="h-3.5 w-3.5 text-primary shrink-0" />
                生效中 Promotions
                <span className="text-xs font-normal text-muted-foreground">Active Discount Codes (30 Days)</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-24 w-full" />
              ) : activePromotions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">近 30 天無活躍折扣碼</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-active-promotions">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">折扣碼 Code</th>
                        <th className="py-2 text-right font-medium">30天使用次數</th>
                        <th className="py-2 text-right font-medium">30天帶動銷售</th>
                        <th className="py-2 text-right font-medium">30天折扣額</th>
                        <th className="py-2 text-right font-medium">昨日使用</th>
                        <th className="py-2 text-right font-medium">昨日銷售</th>
                        <th className="py-2 text-left font-medium pl-3">活躍期間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePromotions.map(p => (
                        <tr key={p.code} className={`border-b border-border/20 transition-colors ${
                          p.yesterdayUses > 0 ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-accent/30'
                        }`}>
                          <td className="py-2 font-mono font-semibold text-primary">{p.code}</td>
                          <td className="py-2 text-right tabular-nums">{p.uses}</td>
                          <td className="py-2 text-right tabular-nums font-semibold">{formatCurrency(p.totalSales)}</td>
                          <td className="py-2 text-right tabular-nums text-red-400">-{formatCurrency(p.totalDiscount)}</td>
                          <td className="py-2 text-right tabular-nums">
                            {p.yesterdayUses > 0
                              ? <span className="font-bold text-primary">{p.yesterdayUses}</span>
                              : <span className="text-muted-foreground/40">0</span>
                            }
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {p.yesterdaySales > 0
                              ? <span className="font-semibold">{formatCurrency(p.yesterdaySales)}</span>
                              : <span className="text-muted-foreground/40">—</span>
                            }
                          </td>
                          <td className="py-2 pl-3 text-muted-foreground text-[10px]">
                            {p.firstUse === p.lastUse ? p.firstUse : `${p.firstUse} ~ ${p.lastUse}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Promo Code Performance (Yesterday) ─────────── */}
          <PromoPerformance
            allOrders={allOrders}
            allOrderLines={allOrderLines}
            dateStr={yesterday}
            dateLabel="昨日"
            loading={loading}
          />

          {/* ── Brand Sales vs Previous Day ────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Award className="h-3.5 w-3.5 text-primary shrink-0" />
                品牌銷售對比
                <span className="text-xs font-normal text-muted-foreground">Brand Sales — Yesterday vs Day Before　點擊展開明細</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-48 w-full" />
              ) : brandComparison.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">無品牌銷售數據</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-brand-comparison">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">品牌 Brand</th>
                        <th className="py-2 text-right font-medium">昨日件數</th>
                        <th className="py-2 text-right font-medium">昨日營收</th>
                        <th className="py-2 text-right font-medium">前日件數</th>
                        <th className="py-2 text-right font-medium">前日營收</th>
                        <th className="py-2 text-right font-medium">件數變化</th>
                        <th className="py-2 text-right font-medium">營收變化</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brandComparison.filter(b => b.yQty > 0 || b.dbQty > 0).map(b => {
                        const bExp = expandedBrands.has(b.vendor);
                        return (
                          <React.Fragment key={b.vendor}>
                            <tr
                              className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer"
                              onClick={() => setExpandedBrands(prev => { const n = new Set(prev); n.has(b.vendor) ? n.delete(b.vendor) : n.add(b.vendor); return n; })}
                            >
                              <td className="py-2 font-medium">
                                <span className="inline-flex items-center gap-1">
                                  {bExp ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                                  {b.vendor}
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums font-bold">{b.yQty}</td>
                              <td className="py-2 text-right tabular-nums font-semibold">{formatCurrency(b.yRevenue)}</td>
                              <td className="py-2 text-right tabular-nums text-muted-foreground">{b.dbQty}</td>
                              <td className="py-2 text-right tabular-nums text-muted-foreground">{formatCurrency(b.dbRevenue)}</td>
                              <td className={`py-2 text-right tabular-nums font-semibold ${
                                b.qtyDelta > 0 ? 'text-green-400' : b.qtyDelta < 0 ? 'text-red-400' : 'text-muted-foreground/40'
                              }`}>
                                {b.qtyDelta > 0 ? <span className="inline-flex items-center gap-0.5"><ArrowUp className="h-3 w-3" />{b.qtyDelta}</span>
                                 : b.qtyDelta < 0 ? <span className="inline-flex items-center gap-0.5"><ArrowDown className="h-3 w-3" />{Math.abs(b.qtyDelta)}</span>
                                 : '—'}
                              </td>
                              <td className={`py-2 text-right tabular-nums font-semibold ${
                                b.revDelta > 0 ? 'text-green-400' : b.revDelta < 0 ? 'text-red-400' : 'text-muted-foreground/40'
                              }`}>
                                {b.revDelta > 0 ? <span className="inline-flex items-center gap-0.5"><ArrowUp className="h-3 w-3" />{formatCurrency(b.revDelta)}</span>
                                 : b.revDelta < 0 ? <span className="inline-flex items-center gap-0.5"><ArrowDown className="h-3 w-3" />{formatCurrency(Math.abs(b.revDelta))}</span>
                                 : '—'}
                              </td>
                            </tr>
                            {bExp && (
                              <tr>
                                <td colSpan={7} className="p-0">
                                  <div className="grid grid-cols-2 gap-3 bg-accent/10 px-4 py-3 border-b border-border/20">
                                    <div>
                                      <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">昨日售出 Yesterday</p>
                                      {b.yItems.length === 0 ? (
                                        <p className="text-[10px] text-muted-foreground/50">無銷售</p>
                                      ) : b.yItems.map((item, ii) => (
                                        <div key={ii} className="flex items-center justify-between text-[11px] py-0.5 border-b border-border/10 last:border-0">
                                          <span className="truncate max-w-[220px]">{item.title}</span>
                                          <span className="tabular-nums text-muted-foreground ml-2 shrink-0">×{item.qty} {formatCurrency(item.revenue)}</span>
                                        </div>
                                      ))}
                                    </div>
                                    <div>
                                      <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">前日售出 Day Before</p>
                                      {b.dbItems.length === 0 ? (
                                        <p className="text-[10px] text-muted-foreground/50">無銷售</p>
                                      ) : b.dbItems.map((item, ii) => (
                                        <div key={ii} className="flex items-center justify-between text-[11px] py-0.5 border-b border-border/10 last:border-0">
                                          <span className="truncate max-w-[220px]">{item.title}</span>
                                          <span className="tabular-nums text-muted-foreground ml-2 shrink-0">×{item.qty} {formatCurrency(item.revenue)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Category Breakdown ───────────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
                <Tag className="h-3.5 w-3.5 text-primary shrink-0" />
                按類別分析
                <span className="text-xs font-normal text-muted-foreground">Category Breakdown — {yesterday}</span>
                {catBreakdown.some(c => c.criticalCount > 0) && (
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-red-400 shrink-0">
                    <AlertTriangle className="h-3 w-3" /> 有庫存緊張貨品
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
                </div>
              ) : catBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">昨日無銷售數據</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {catBreakdown.map(cat => {
                    const style    = getCatStyle(cat.type);
                    const expanded = expandedCats === 'all' || expandedCats.has(cat.type);
                    return (
                      <div key={cat.type} className={`rounded-lg border ${style.border} overflow-hidden`}>
                        {/* Card Header (always visible, clickable) */}
                        <button
                          className={`w-full px-3 py-2.5 text-left ${style.bg} hover:brightness-110 transition-all`}
                          onClick={() => toggleCat(cat.type)}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className={`text-[11px] font-semibold ${style.color} truncate flex-1 text-left`}>
                              {cat.type}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {cat.criticalCount > 0 && (
                                <span className="text-[10px] bg-red-500/20 text-red-400 px-1 py-0.5 rounded">🔴{cat.criticalCount}</span>
                              )}
                              {cat.warningCount > 0 && (
                                <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-1 py-0.5 rounded">🟡{cat.warningCount}</span>
                              )}
                              {expanded
                                ? <ChevronDown  className="h-3.5 w-3.5 text-muted-foreground" />
                                : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              }
                            </div>
                          </div>
                          {/* Revenue + Qty */}
                          <div className="flex items-baseline gap-2 mt-1">
                            <span className="text-sm font-bold tabular-nums">{formatCurrency(cat.revenue)}</span>
                            <span className="text-xs text-muted-foreground">{cat.qty}件</span>
                          </div>
                          {/* Brand tags */}
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {cat.brands.slice(0, 5).map(b => (
                              <span key={b} className="text-[10px] bg-background/60 border border-border/30 text-muted-foreground px-1.5 py-0.5 rounded">
                                {b}
                              </span>
                            ))}
                            {cat.brands.length > 5 && (
                              <span className="text-[10px] text-muted-foreground/50">+{cat.brands.length - 5}品牌</span>
                            )}
                          </div>
                        </button>

                        {/* Expanded: Product breakdown with stock + velocity */}
                        {expanded && (
                          <div className="border-t border-border/30 bg-background/40">
                            {/* Column headers */}
                            <div className="px-3 py-1.5 grid grid-cols-[1fr_28px_36px_48px_60px] gap-x-2 text-[10px] text-muted-foreground/60 border-b border-border/20">
                              <span>產品</span>
                              <span className="text-right">售</span>
                              <span className="text-right">庫存</span>
                              <span className="text-right">速率/日</span>
                              <span className="text-right">預測</span>
                            </div>
                            {cat.products.map((p, idx) => (
                              <div
                                key={idx}
                                className={`px-3 py-1.5 grid grid-cols-[1fr_28px_36px_48px_60px] gap-x-2 items-center text-[11px] border-b border-border/10 last:border-0 ${
                                  p.risk === 'critical' ? 'bg-red-500/5' :
                                  p.risk === 'warning'  ? 'bg-yellow-500/5' : ''
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-medium leading-tight">{p.title}</div>
                                  <div className="text-[10px] text-muted-foreground/50 truncate">{p.vendor}</div>
                                </div>
                                <span className="text-right tabular-nums font-semibold">{p.qty}</span>
                                <span className={`text-right tabular-nums font-semibold ${
                                  p.stock === 0          ? 'text-red-400' :
                                  p.stock !== null && p.stock <= 5 ? 'text-yellow-400' : ''
                                }`}>
                                  {p.stock !== null ? p.stock : '—'}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {p.velocity >= 0.01 ? p.velocity.toFixed(2) : p.velocity > 0 ? '<0.01' : '—'}
                                </span>
                                <span className="text-right">
                                  <RiskBadge risk={p.risk} days={p.daysToStockout} />
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Staff Performance Table ─────────────────────────── */}
          {staffPerformance.length > 0 && (() => {
            const tabRev  = (r: typeof staffPerformance[0]) => staffTab === 'yesterday' ? r.dayRev : staffTab === 'this_week' ? r.wkRev : r.mtdRev;
            const tabCnt  = (r: typeof staffPerformance[0]) => staffTab === 'yesterday' ? r.dayCnt : staffTab === 'this_week' ? r.wkCnt : r.mtdCnt;
            const tabLabel = staffTab === 'yesterday' ? '昨日' : staffTab === 'this_week' ? '本週' : '本月MTD';
            const totalRev = staffPerformance.reduce((s, r) => s + tabRev(r), 0);
            const totalCnt = staffPerformance.reduce((s, r) => s + tabCnt(r), 0);
            return (
              <Card className="border-border/40">
                <CardHeader className="pb-0 pt-3 px-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Users className="h-3.5 w-3.5 text-primary" />
                      員工表現
                      <span className="text-xs font-normal text-muted-foreground">POS Staff Performance</span>
                    </CardTitle>
                    {/* Tab switcher */}
                    <div className="flex items-center gap-1 bg-accent/30 rounded p-0.5 ml-auto">
                      {([
                        { key: 'yesterday',  label: '昨日' },
                        { key: 'this_week',  label: '本週' },
                        { key: 'this_month', label: '本月' },
                      ] as const).map(t => (
                        <button
                          key={t.key}
                          onClick={() => setStaffTab(t.key)}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                            staffTab === t.key
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <span className="text-[10px] text-muted-foreground/60 hidden sm:block">點擊姓名可設定</span>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4 pt-3">
                  {loading ? (
                    <Skeleton className="h-32 w-full" />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border/50 text-muted-foreground">
                            <th className="py-2 text-left font-medium">姓名 Staff</th>
                            <th className="py-2 text-right font-medium">{tabLabel}訂單</th>
                            <th className="py-2 text-right font-medium">{tabLabel}物餅</th>
                            <th className="py-2 text-right font-medium">{tabLabel}均偕</th>
                            <th className="py-2 text-right font-medium">占比</th>
                          </tr>
                        </thead>
                        <tbody>
                          {staffPerformance.map((s, i) => {
                            const rev = tabRev(s);
                            const cnt = tabCnt(s);
                            const pct = totalRev > 0 ? (rev / totalRev) * 100 : 0;
                            return (
                              <tr key={s.uid} className={`border-b border-border/20 hover:bg-accent/30 transition-colors ${
                                i === 0 && rev > 0 ? 'bg-amber-500/5' : ''
                              }`}>
                                <td className="py-2">
                                  {editingUid === s.uid ? (
                                    <div className="space-y-1">
                                      <div className="flex flex-wrap gap-1">
                                        {STAFF_ROSTER.map(name => (
                                          <button
                                            key={name}
                                            onClick={() => saveStaffName(s.uid, name)}
                                            className="text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary border border-primary/30 rounded hover:bg-primary/30 transition-colors"
                                          >
                                            {name}
                                          </button>
                                        ))}
                                      </div>
                                      <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); saveStaffName(s.uid, editName); }}>
                                        <input autoFocus value={editName} onChange={e => setEditName(e.target.value)} placeholder="自行輸入..."
                                          className="w-24 px-1.5 py-0.5 text-xs bg-muted border border-border rounded text-foreground focus:outline-none focus:border-primary" />
                                        <button type="submit" className="text-[10px] px-1.5 py-0.5 bg-primary/80 text-primary-foreground rounded">存</button>
                                        <button type="button" onClick={() => setEditingUid(null)} className="text-[10px] px-1 text-muted-foreground">取</button>
                                      </form>
                                    </div>
                                  ) : (
                                    <button onClick={() => { setEditingUid(s.uid); setEditName(staffNames[s.uid] || ''); }}
                                      className="flex items-center gap-1.5 group">
                                      {i === 0 && rev > 0 && <span className="text-amber-400">🥇</span>}
                                      {i === 1 && rev > 0 && <span className="text-foreground">🥈</span>}
                                      {i === 2 && rev > 0 && <span className="text-amber-700">🥉</span>}
                                      <span className={`font-medium ${staffNames[s.uid] ? '' : 'text-muted-foreground italic'}`}>
                                        {getStaffName(s.uid)}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity">✏️</span>
                                    </button>
                                  )}
                                </td>
                                <td className="py-2 text-right tabular-nums text-muted-foreground">
                                  {cnt > 0 ? cnt : <span className="opacity-30">—</span>}
                                </td>
                                <td className={`py-2 text-right tabular-nums font-semibold ${rev > 0 ? '' : 'text-muted-foreground/30'}`}>
                                  {rev > 0 ? formatCurrency(rev) : '—'}
                                </td>
                                <td className="py-2 text-right tabular-nums text-muted-foreground">
                                  {cnt > 0 ? formatCurrency(rev / cnt) : '—'}
                                </td>
                                <td className="py-2 text-right">
                                  {pct > 0 ? (
                                    <div className="flex items-center justify-end gap-1.5">
                                      <div className="w-12 h-1.5 bg-border/40 rounded-full overflow-hidden">
                                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                                      </div>
                                      <span className="text-[10px] tabular-nums text-muted-foreground w-6 text-right">{pct.toFixed(0)}%</span>
                                    </div>
                                  ) : <span className="opacity-30">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-border/40 bg-muted/10">
                            <td className="py-2 text-xs font-semibold text-muted-foreground">小計</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground text-xs">{totalCnt}</td>
                            <td className="py-2 text-right tabular-nums font-bold text-xs">{formatCurrency(totalRev)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground text-xs">
                              {totalCnt > 0 ? formatCurrency(totalRev / totalCnt) : '—'}
                            </td>
                            <td className="py-2 text-right text-[10px] text-muted-foreground/60">100%</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* ── Products Table (enhanced with stock + velocity) ── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-medium">
                  昨日產品明細
                  <span className="text-xs font-normal text-muted-foreground ml-1">Yesterday's Products</span>
                </CardTitle>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> 缺貨/≤7天</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" /> 注意 ≤21天</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> 充足</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-[300px] w-full" />
              ) : yProducts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">昨日無銷售數據</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-yesterday-products">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium w-6">#</th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium hidden md:table-cell">類別 Category</th>
                        <th className="py-2 text-left font-medium">品牌</th>
                        <th className="py-2 text-right font-medium">售出</th>
                        <th className="py-2 text-right font-medium">營收</th>
                        <th className="py-2 text-right font-medium">剩餘庫存</th>
                        <th className="py-2 text-right font-medium hidden lg:table-cell">銷售速率</th>
                        <th className="py-2 text-right font-medium">預計缺貨</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yProducts.map((p, i) => (
                        <tr
                          key={p.key}
                          className={`border-b border-border/20 transition-colors ${
                            p.risk === 'critical' ? 'bg-red-500/5 hover:bg-red-500/10' :
                            p.risk === 'warning'  ? 'bg-yellow-500/5 hover:bg-yellow-500/10' :
                            'hover:bg-accent/30'
                          }`}
                        >
                          <td className="py-2 text-muted-foreground tabular-nums">{i + 1}</td>
                          <td className="py-2 max-w-[160px]">
                            <div className="truncate font-medium">{p.title}</div>
                            {p.sku && <div className="text-[10px] font-mono text-muted-foreground/50">{p.sku}</div>}
                          </td>
                          <td className="py-2 hidden md:table-cell">
                            <span className={`text-[10px] ${getCatStyle(p.productType).color}`}>{p.productType}</span>
                          </td>
                          <td className="py-2 text-muted-foreground text-[11px]">{p.vendor || '—'}</td>
                          <td className="py-2 text-right tabular-nums font-bold">{p.qty}</td>
                          <td className="py-2 text-right tabular-nums">{formatCurrency(p.revenue)}</td>
                          <td className={`py-2 text-right tabular-nums font-semibold ${
                            p.stock === null         ? 'text-muted-foreground/40' :
                            p.stock === 0            ? 'text-red-400 font-bold'  :
                            p.stock <= 3             ? 'text-yellow-400'          :
                            p.stock <= 10            ? 'text-amber-400'           : ''
                          }`}>
                            {p.stock !== null ? p.stock : '—'}
                          </td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground hidden lg:table-cell">
                            {p.velocity >= 0.01
                              ? `${p.velocity.toFixed(2)}/日`
                              : p.velocity > 0 ? '<0.01/日'
                              : '—'
                            }
                          </td>
                          <td className="py-2 text-right">
                            <RiskBadge risk={p.risk} days={p.daysToStockout} />
                          </td>
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

      {/* ═══════════════════════════ WEEK VIEW ═════════════════════════════════ */}
      {isWeekView && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="週營收"   subtitle="Week Revenue"  value={formatCurrency(wRevenue)}       icon={DollarSign}   loading={loading} delta={calcDelta(wRevenue, pwRevenue)}                          testId="kpi-w-rev" />
            <KpiCard title="週訂單"   subtitle="Week Orders"   value={formatNumber(weekOrders.length)} icon={ShoppingCart} loading={loading} delta={calcDelta(weekOrders.length, prevWkOrders.length)}       testId="kpi-w-orders" />
            <KpiCard title="最佳日"   subtitle="Best Day"      value={bestDay.date ? `${bestDay.date.slice(5)} ${formatCurrency(bestDay.revenue)}` : '—'} icon={Trophy} loading={loading}                  testId="kpi-w-bestday" />
            <KpiCard title="最暢銷"   subtitle="Best Product"  value={bestProduct.title.length > 20 ? bestProduct.title.slice(0, 20) + '…' : bestProduct.title} icon={Package} loading={loading}           testId="kpi-w-bestprod" />
          </div>

          {/* Daily Revenue Chart */}
          <ChartCard title="每日營收" subtitle={`Weekly Revenue (${viewMode === 'last_week' ? 'Last Week' : 'This Week'})`} loading={loading}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={weeklyBarData}>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="day" tick={AXIS_STYLE} />
                <YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCurrency(v)} />
                <Bar dataKey="revenue" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ── Weekly Comparison Line Chart ──────────────────────── */}
          <ChartCard
            title="每週銷售對比"
            subtitle={`本週 vs 上週 vs 去年同期 Weekly Comparison`}
            note={(() => {
              const twStart = new Date(wkBounds.from + 'T00:00:00');
              const lyStart = new Date(twStart); lyStart.setFullYear(lyStart.getFullYear() - 1);
              const lyEnd = new Date(lyStart); lyEnd.setDate(lyStart.getDate() + 6);
              return `去年同期: ${toDateStr(lyStart)} → ${toDateStr(lyEnd)}`;
            })()}
            loading={loading}
          >
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={weekComparisonData}>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="day" tick={AXIS_STYLE} />
                <YAxis tick={AXIS_STYLE} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(v: number, name: string) => {
                    const label = name === 'thisWeek' ? '本週' : name === 'lastWeek' ? '上週' : '去年同期';
                    return [formatCurrency(v), label];
                  }}
                />
                <Legend
                  formatter={(value: string) => {
                    if (value === 'thisWeek') return '本週 This Week';
                    if (value === 'lastWeek') return '上週 Last Week';
                    return '去年同期 Last Year';
                  }}
                  wrapperStyle={{ fontSize: '11px' }}
                />
                <Line
                  type="monotone"
                  dataKey="thisWeek"
                  stroke={CHART_COLORS.primary}
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: CHART_COLORS.primary }}
                  activeDot={{ r: 6 }}
                />
                <Line
                  type="monotone"
                  dataKey="lastWeek"
                  stroke={CHART_COLORS.secondary}
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  dot={{ r: 3, fill: CHART_COLORS.secondary }}
                />
                <Line
                  type="monotone"
                  dataKey="lastYear"
                  stroke={CHART_COLORS.quaternary}
                  strokeWidth={2}
                  strokeDasharray="3 3"
                  dot={{ r: 3, fill: CHART_COLORS.quaternary }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ── Week Category Breakdown ──────────────────────────── */}
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Tag className="h-3.5 w-3.5 text-primary" />
                本週類別表現
                <span className="text-xs font-normal text-muted-foreground">Weekly Category Breakdown　點擊展開明細</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? (
                <Skeleton className="h-48 w-full" />
              ) : weekCatBreakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">本週無數據</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">類別 Category</th>
                        <th className="py-2 text-right font-medium">件數</th>
                        <th className="py-2 text-right font-medium">週營收</th>
                        <th className="py-2 text-right font-medium">均單價</th>
                        <th className="py-2 text-left font-medium pl-3">品牌組成</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weekCatBreakdown.map((cat, i) => {
                        const style = getCatStyle(cat.type);
                        const wcExp = expandedWeekCats.has(cat.type);
                        return (
                          <React.Fragment key={i}>
                            <tr
                              className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer"
                              onClick={() => setExpandedWeekCats(prev => { const n = new Set(prev); n.has(cat.type) ? n.delete(cat.type) : n.add(cat.type); return n; })}
                            >
                              <td className={`py-2 font-medium ${style.color}`}>
                                <span className="inline-flex items-center gap-1">
                                  {wcExp ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                                  {cat.type}
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums">{cat.qty}</td>
                              <td className="py-2 text-right tabular-nums font-semibold">{formatCurrency(cat.revenue)}</td>
                              <td className="py-2 text-right tabular-nums text-muted-foreground">
                                {formatCurrency(cat.qty > 0 ? cat.revenue / cat.qty : 0)}
                              </td>
                              <td className="py-2 pl-3">
                                <div className="flex flex-wrap gap-1">
                                  {cat.brands.slice(0, 5).map(b => (
                                    <span key={b} className="text-[10px] bg-accent/60 text-muted-foreground px-1.5 py-0.5 rounded">{b}</span>
                                  ))}
                                  {cat.brands.length > 5 && (
                                    <span className="text-[10px] text-muted-foreground/50">+{cat.brands.length - 5}</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {wcExp && (
                              <tr>
                                <td colSpan={5} className="p-0">
                                  <div className="bg-accent/10 px-4 py-2 border-b border-border/20">
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                                      {cat.itemList.map((item, ii) => (
                                        <div key={ii} className="flex items-center justify-between text-[11px] py-1 border-b border-border/10 last:border-0">
                                          <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-muted-foreground/50 tabular-nums w-4 text-right shrink-0">{ii + 1}</span>
                                            <span className="truncate">{item.title}</span>
                                            {item.vendor && <span className="text-[9px] text-muted-foreground/50 shrink-0">{item.vendor}</span>}
                                          </div>
                                          <span className="tabular-nums text-muted-foreground ml-2 shrink-0">×{item.qty} {formatCurrency(item.revenue)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top 10 Products */}
          <ChartCard title="本週暢銷 Top 10" subtitle="Top Products This Week" loading={loading}>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={weekTopProducts} layout="vertical">
                <CartesianGrid {...GRID_STYLE} />
                <XAxis type="number" tick={AXIS_STYLE} />
                <YAxis type="category" dataKey="title" tick={AXIS_STYLE} width={160}
                  tickFormatter={(v: string) => v.length > 22 ? v.slice(0, 22) + '…' : v} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => name === 'qty' ? v : formatCurrency(v)} />
                <Bar dataKey="qty" name="數量 Qty" fill={CHART_COLORS.primary} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}
    </div>
  );
}
