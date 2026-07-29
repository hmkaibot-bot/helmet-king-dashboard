import { useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { campaignBusiness, isRetailInquiry, type Business } from '@/lib/business-filter';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { DollarSign, Eye, MousePointer, BarChart3, Percent, TrendingUp, Target, Award, AlertTriangle, ChevronLeft, ChevronRight, Store, Globe, X, MessageCircle } from 'lucide-react';
import { LineChart, Line, AreaChart, Area, ComposedChart, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

/* ── Constants ── */
const AOV = 1248; // HKD average order value
const PAGE_SIZE = 20;

/* ── Rating logic ── */
function getRating(c: any) {
  if (c.purchases_90d >= 20) return { label: '🔥 極佳', color: 'text-green-400', score: 5 };
  if (c.purchases_90d >= 5 || c.ctr_90d >= 8) return { label: '✅ 優秀', color: 'text-green-400', score: 4 };
  if (c.purchases_90d > 0 && c.ctr_90d >= 4) return { label: '👍 良好', color: 'text-blue-400', score: 3 };
  if (c.purchases_90d > 0 || c.ctr_90d >= 4) return { label: '📊 一般', color: 'text-yellow-400', score: 2 };
  if (c.ctr_90d >= 2 || c.spend_90d < 300) return { label: '📉 偏低', color: 'text-orange-400', score: 1 };
  return { label: '❌ 差', color: 'text-red-400', score: 0 };
}

function getRecommendation(c: any) {
  if (c.purchases_90d >= 20) return '重複投放';
  if (c.purchases_90d >= 5) return '可再做';
  if (c.purchases_90d > 0 && c.spend_90d < 200) return '增加預算測試';
  if (c.spend_90d > 500 && c.purchases_90d === 0 && c.ctr_90d < 3) return '不建議再做';
  if (c.spend_90d > 300 && c.purchases_90d === 0) return '審查受眾';
  return '持續觀察';
}

function computeCampaignFields(c: any) {
  const spend = parseFloat(c.spend_90d) || 0;
  const purchases = parseInt(c.purchases_90d) || 0;
  const ctr = parseFloat(c.ctr_90d) || 0;
  const impressions = parseInt(c.impressions_90d) || 0;
  const cpc = parseFloat(c.cpc_90d) || 0;
  const estimatedRev = purchases * AOV;
  const roas = spend > 0 && purchases > 0 ? estimatedRev / spend : 0;
  const cpa = purchases > 0 ? spend / purchases : null;
  const rating = getRating({ ...c, spend_90d: spend, purchases_90d: purchases, ctr_90d: ctr });
  const recommendation = getRecommendation({ ...c, spend_90d: spend, purchases_90d: purchases, ctr_90d: ctr });
  return { ...c, spend, purchases, ctr, impressions, cpc, estimatedRev, roas, cpa, rating, recommendation };
}

type SortBy = 'purchases' | 'ctr' | 'spend' | 'roas' | 'cpa';
type StatusFilter = 'all' | 'ACTIVE' | 'PAUSED' | 'ended';
type PerfFilter = 'all' | 'has_purchases' | 'no_purchases';

/* ── SleekFlow 對話彈窗共用 ── */
type InqMsg = { at: string; who: string; text: string };
// SleekFlow 時間係 UTC — 顯示轉香港時間(28/7 下午1:58)
const fmtHK = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};

export default function MarketingPage() {
  const { bounds } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [adInsights, setAdInsights] = useState<any[]>([]);
  const [shopifyRevByDay, setShopifyRevByDay] = useState<Record<string, number>>({});
  const [retailRevByDay, setRetailRevByDay] = useState<Record<string, number>>({});
  const [marselloCustomers, setMarselloCustomers] = useState<any[]>([]);
  // SleekFlow 客服查詢事件(webhook 落 inquiry_events;只有 metadata 冇訊息內容)
  const [inquiries, setInquiries] = useState<any[]>([]);
  // campaign × 日成效(GitHub Actions 每晚同步)— 零售模式要逐 campaign 加總先分到業務
  const [campaignDaily, setCampaignDaily] = useState<any[]>([]);
  // 🪖 淨睇零售(預設開;戶口同時孭 26King 賣車/租車廣告,零售以外全部隱藏)
  const [retailOnly, setRetailOnly] = useState(() => {
    try { return localStorage.getItem('mkt_retail_only') !== '0'; } catch { return true; }
  });
  const toggleRetailOnly = (v: boolean) => {
    setRetailOnly(v);
    try { localStorage.setItem('mkt_retail_only', v ? '1' : '0'); } catch { /* ignore */ }
  };

  // Campaign Performance state
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortBy>('purchases');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [perfFilter, setPerfFilter] = useState<PerfFilter>('all');
  const [page, setPage] = useState(0);
  // 撳活動行 → drill-down 彈窗(即時經 /api/meta-campaign 攞人數/查詢/每日/受眾)
  const [detailCampaign, setDetailCampaign] = useState<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [ads, orders, retail, marsello, inq, campDaily] = await Promise.all([
          queryWithDateRange('meta_ad_insights', 'date,spend,impressions,clicks,reach,cpm,cpc,ctr', 'date', bounds),
          queryWithDateRange('shopify_orders', 'created_at,total_price,financial_status,cancelled_at', 'created_at', bounds),
          // 實體零售 = BC 門市 (dimension CARSHOP),一直不含車房維修 (GARAGE)。同 overview「零售 Retail」口徑一致。
          queryWithDateRange('bc_sales_invoices', 'invoice_date,total_amount_incl_tax', 'invoice_date', bounds, [{ column: 'dimension1_code', op: 'eq', value: 'CARSHOP' }]),
          queryAll('marsello_customers', 'id,created_at,last_seen,tier_name,subscribed'),
          // SleekFlow 查詢(電話+原文係品牌 Top 10 撳入去睇對話用;原文只有認到商品嘅訊息先有)
          queryWithDateRange('inquiry_events', 'message_id,conversation_id,contact_id,contact_phone,channel,occurred_at,matched_brand,matched_title,message_text,source,business', 'occurred_at', bounds),
          queryWithDateRange('meta_campaign_daily', 'campaign_id,date,spend,impressions,clicks,conversations', 'date', bounds),
        ]);
        if (cancelled) return;

        const validOrders = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const dayRevMap: Record<string, number> = {};
        validOrders.forEach((o: any) => { const d = o.created_at?.slice(0, 10); if (d) dayRevMap[d] = (dayRevMap[d] || 0) + (parseFloat(o.total_price) || 0); });

        const retailDayMap: Record<string, number> = {};
        retail.forEach((o: any) => { const d = o.invoice_date?.slice(0, 10); if (d) retailDayMap[d] = (retailDayMap[d] || 0) + (parseFloat(o.total_amount_incl_tax) || 0); });

        setAdInsights(ads);
        setShopifyRevByDay(dayRevMap);
        setRetailRevByDay(retailDayMap);
        setMarselloCustomers(marsello);
        setInquiries(inq);
        setCampaignDaily(campDaily);
      } catch (e) { console.error('Marketing error:', e); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [bounds]);

  // Load meta_campaigns(全表 — 冇 90 日支出嘅都要,business 對照 campaign_daily 用)
  const [allCampaignRows, setAllCampaignRows] = useState<any[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function loadCampaigns() {
      setCampaignsLoading(true);
      try {
        const { data, error } = await supabase
          .from('meta_campaigns')
          .select('*')
          .order('spend_90d', { ascending: false })
          .limit(2000);
        if (cancelled) return;
        if (error) { console.error('Campaigns error:', error); setCampaigns([]); return; }
        setAllCampaignRows(data || []);
        setCampaigns((data || []).filter((c: any) => (parseFloat(c.spend_90d) || 0) > 0).map(computeCampaignFields));
      } catch (e) { console.error('Campaigns fetch error:', e); } finally { if (!cancelled) setCampaignsLoading(false); }
    }
    loadCampaigns();
    return () => { cancelled = true; };
  }, []);

  /* ── 🪖 業務分流:campaign → 零售 / 非零售(26King 賣車·租車) ── */
  // 有效業務 = DB override 優先,冇就按名稱關鍵字自動分
  const bizById = useMemo(() => {
    const m: Record<string, Business> = {};
    for (const c of allCampaignRows) m[String(c.campaign_id)] = campaignBusiness(c);
    return m;
  }, [allCampaignRows]);

  // 撳活動表個業務 chip 反轉分類 — override 寫入 DB,以後都記得
  const [savingBizId, setSavingBizId] = useState<string | null>(null);
  async function flipCampaignBusiness(c: any, ev: React.MouseEvent) {
    ev.stopPropagation(); // 唔好順手打開 drill-down 彈窗
    const next: Business = bizById[String(c.campaign_id)] === 'retail' ? 'nonretail' : 'retail';
    setSavingBizId(String(c.campaign_id));
    try {
      const { error } = await supabase.from('meta_campaigns').update({ business: next }).eq('campaign_id', c.campaign_id);
      if (error) throw error;
      setAllCampaignRows((rows) => rows.map((r) => (r.campaign_id === c.campaign_id ? { ...r, business: next } : r)));
      setCampaigns((rows) => rows.map((r) => (r.campaign_id === c.campaign_id ? { ...r, business: next } : r)));
    } catch (e) {
      console.error('flip business error:', e);
    } finally {
      setSavingBizId(null);
    }
  }

  // 零售模式下頁面用嘅 campaign / 查詢子集
  const viewCampaigns = useMemo(
    () => (retailOnly ? campaigns.filter((c) => bizById[String(c.campaign_id)] !== 'nonretail') : campaigns),
    [campaigns, retailOnly, bizById]
  );
  const hiddenCampaignCount = campaigns.length - viewCampaigns.length;
  const viewInquiries = useMemo(
    () => (retailOnly ? inquiries.filter(isRetailInquiry) : inquiries),
    [inquiries, retailOnly]
  );

  /* 零售模式廣告日數:meta_ad_insights 係成個戶口(零售+賣車+租車撈埋),
     零售要由 meta_campaign_daily 逐 campaign 加總。未識別 campaign(對照唔到)唔計入零售。 */
  const retailAdByDay = useMemo(() => {
    const m: Record<string, { spend: number; impressions: number; clicks: number }> = {};
    for (const d of campaignDaily) {
      if (bizById[String(d.campaign_id)] !== 'retail') continue;
      const day = String(d.date || '').slice(0, 10);
      if (!day) continue;
      const row = (m[day] = m[day] || { spend: 0, impressions: 0, clicks: 0 });
      row.spend += parseFloat(d.spend) || 0;
      row.impressions += parseInt(d.impressions) || 0;
      row.clicks += parseInt(d.clicks) || 0;
    }
    return m;
  }, [campaignDaily, bizById]);

  /* ── Meta 廣告日 series(模式感知)──
     全部業務:meta_ad_insights(戶口級,n8n 每晚同步,歷史最齊)。
     淨睇零售:meta_campaign_daily 零售 campaign 加總(campaign 級先分到業務;
     覆蓋範圍由每日同步 job 開始回填,太舊嘅日子可能未有數)。 */
  const adSeries = useMemo(() => {
    if (retailOnly) {
      return Object.entries(retailAdByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({
          date,
          spend: v.spend,
          impressions: v.impressions,
          clicks: v.clicks,
          ctr: v.impressions > 0 ? (v.clicks / v.impressions) * 100 : 0,
          cpc: v.clicks > 0 ? v.spend / v.clicks : 0,
          cpm: v.impressions > 0 ? (v.spend / v.impressions) * 1000 : 0,
        }));
    }
    const byDay: Record<string, { spend: number; impressions: number; clicks: number }> = {};
    for (const a of adInsights) {
      const day = String(a.date || '').slice(0, 10);
      if (!day) continue;
      const row = (byDay[day] = byDay[day] || { spend: 0, impressions: 0, clicks: 0 });
      row.spend += parseFloat(a.spend) || 0;
      row.impressions += parseInt(a.impressions) || 0;
      row.clicks += parseInt(a.clicks) || 0;
    }
    return Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        spend: v.spend,
        impressions: v.impressions,
        clicks: v.clicks,
        ctr: v.impressions > 0 ? (v.clicks / v.impressions) * 100 : 0,
        cpc: v.clicks > 0 ? v.spend / v.clicks : 0,
        cpm: v.impressions > 0 ? (v.spend / v.impressions) * 1000 : 0,
      }));
  }, [retailOnly, retailAdByDay, adInsights]);

  /* ── Existing KPIs ── */
  const totalSpend = adSeries.reduce((s, a) => s + a.spend, 0);
  const totalImpressions = adSeries.reduce((s, a) => s + a.impressions, 0);
  const totalClicks = adSeries.reduce((s, a) => s + a.clicks, 0);
  const avgCPC = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const totalShopifyRev = Object.values(shopifyRevByDay).reduce((s, v) => s + v, 0);
  const roas = totalSpend > 0 ? totalShopifyRev / totalSpend : 0; // 線上 ROAS (Shopify/Spend) — 相對可歸因

  /* ── 廣告 ↔ 銷售掛勾: 線上(Shopify) + 實體零售(BC CARSHOP, 不含車房維修) ── */
  const totalRetailRev = Object.values(retailRevByDay).reduce((s, v) => s + v, 0);
  const totalSales = totalShopifyRev + totalRetailRev;
  const adCostPct = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0; // 廣告費佔總銷售比

  // P4: Blended CAC — 期間新會員 (Marsello) 作獲客代理,廣告費 ÷ 新會員
  const newMembersInRange = marselloCustomers.filter((c) => { const d = c.created_at?.slice(0, 10); return d && d >= bounds.from && d <= bounds.to; }).length;
  const blendedCAC = newMembersInRange > 0 ? totalSpend / newMembersInRange : 0;

  /* ── SleekFlow 客服查詢統計 ──
     查詢量 = distinct 對話數(貼「幾多個客嚟問」;同一單對話幾條訊息計一次)。
     日期用 occurred_at.slice(0,10) — 同本頁銷售/廣告日期切法一致,先對得埋。 */
  const inquiryStats = useMemo(() => {
    const convSet = new Set<string>();
    const contactSet = new Set<string>();
    const byChannel: Record<string, Set<string>> = { whatsapp: new Set(), instagram: new Set(), facebook: new Set(), other: new Set() };
    const byDay: Record<string, Set<string>> = {};
    for (const e of viewInquiries) {
      const conv = String(e.conversation_id || e.message_id);
      convSet.add(conv);
      if (e.contact_id) contactSet.add(String(e.contact_id));
      const ch = String(e.channel || '');
      const bucket = ch.includes('whatsapp') ? 'whatsapp' : ch.includes('instagram') ? 'instagram' : ch.includes('facebook') || ch.includes('messenger') ? 'facebook' : 'other';
      byChannel[bucket].add(conv);
      const d = String(e.occurred_at || '').slice(0, 10);
      if (d) { byDay[d] = byDay[d] || new Set(); byDay[d].add(conv); }
    }
    const dayCounts: Record<string, number> = {};
    Object.entries(byDay).forEach(([d, s]) => { dayCounts[d] = s.size; });
    // 廣告入口(CTWA 標記)/ 品牌 Top / 單品 Top — 全部按 distinct 對話計
    const adConvSet = new Set<string>();
    const brandConv: Record<string, Set<string>> = {};
    const prodConv: Record<string, Set<string>> = {};
    // 撳品牌/單品行彈出嘅對話原文(sync 只儲認到商品嘅訊息)
    const brandMsgs: Record<string, InqMsg[]> = {};
    const prodMsgs: Record<string, InqMsg[]> = {};
    const whoOf = (e: any) =>
      e.contact_phone || (String(e.channel).includes('instagram') ? 'IG 客人' : String(e.channel).includes('facebook') ? 'FB 客人' : '客人');
    for (const e of viewInquiries) {
      const conv = String(e.conversation_id || e.message_id);
      if (e.source === 'ctwa') adConvSet.add(conv);
      if (e.matched_brand) {
        (brandConv[e.matched_brand] = brandConv[e.matched_brand] || new Set()).add(conv);
        if (e.message_text) (brandMsgs[e.matched_brand] = brandMsgs[e.matched_brand] || []).push({ at: String(e.occurred_at), who: whoOf(e), text: String(e.message_text) });
      }
      if (e.matched_title) {
        (prodConv[e.matched_title] = prodConv[e.matched_title] || new Set()).add(conv);
        if (e.message_text) (prodMsgs[e.matched_title] = prodMsgs[e.matched_title] || []).push({ at: String(e.occurred_at), who: whoOf(e), text: String(e.message_text) });
      }
    }
    const topOf = (m: Record<string, Set<string>>, msgs: Record<string, InqMsg[]>) =>
      Object.entries(m)
        .map(([k, s]) => ({ name: k, count: s.size, msgs: (msgs[k] || []).sort((a, b) => b.at.localeCompare(a.at)) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    return {
      total: convSet.size,
      contacts: contactSet.size,
      whatsapp: byChannel.whatsapp.size,
      instagram: byChannel.instagram.size,
      facebook: byChannel.facebook.size,
      dayCounts,
      adConvs: adConvSet.size,
      topBrands: topOf(brandConv, brandMsgs),
      topProducts: topOf(prodConv, prodMsgs),
    };
  }, [viewInquiries]);
  // 品牌/單品 Top 10 撳行 → 對話彈窗
  const [inquiryDetail, setInquiryDetail] = useState<{ title: string; count: number; msgs: InqMsg[] } | null>(null);
  const costPerInquiry = inquiryStats.total > 0 ? totalSpend / inquiryStats.total : 0;

  const salesVsSpend = useMemo(() => {
    const adMap: Record<string, number> = {};
    adSeries.forEach((a) => { adMap[a.date] = a.spend; });
    const allDays = new Set([...adSeries.map((a) => a.date), ...Object.keys(shopifyRevByDay), ...Object.keys(retailRevByDay), ...Object.keys(inquiryStats.dayCounts)]);
    return Array.from(allDays).sort().map((d) => {
      const online = shopifyRevByDay[d] || 0;
      const retail = retailRevByDay[d] || 0;
      return { date: d.slice(5), online, retail, total: online + retail, spend: adMap[d] || 0, inquiries: inquiryStats.dayCounts[d] || 0 };
    });
  }, [adSeries, shopifyRevByDay, retailRevByDay, inquiryStats]);

  // P3: 每日貢獻表 — 完整日期、廣告成本佔比,由新到舊
  const dailyRows = useMemo(() => {
    const adMap: Record<string, number> = {};
    adSeries.forEach((a) => { adMap[a.date] = a.spend; });
    const allDays = new Set([...adSeries.map((a) => a.date), ...Object.keys(shopifyRevByDay), ...Object.keys(retailRevByDay), ...Object.keys(inquiryStats.dayCounts)]);
    return Array.from(allDays).filter(Boolean).sort((a, b) => b.localeCompare(a)).map((d) => {
      const online = shopifyRevByDay[d] || 0;
      const retail = retailRevByDay[d] || 0;
      const spend = adMap[d] || 0;
      const total = online + retail;
      return { date: d, online, retail, total, spend, inquiries: inquiryStats.dayCounts[d] || 0, costPct: total > 0 ? (spend / total) * 100 : 0 };
    });
  }, [adSeries, shopifyRevByDay, retailRevByDay, inquiryStats]);

  const ctrTrend = adSeries.map((a) => ({ date: a.date.slice(5), ctr: a.ctr }));
  const costTrend = adSeries.map((a) => ({ date: a.date.slice(5), cpm: a.cpm, cpc: a.cpc }));
  const impClickTrend = adSeries.map((a) => ({ date: a.date.slice(5), impressions: a.impressions, clicks: a.clicks }));

  const ninetyAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const activeMembers = marselloCustomers.filter((c) => c.last_seen && c.last_seen >= ninetyAgo).length;
  const inactiveMembers = marselloCustomers.length - activeMembers;

  const memberGrowth = useMemo(() => {
    const monthMap: Record<string, number> = {};
    marselloCustomers.forEach((c) => { if (!c.created_at) return; const m = c.created_at.slice(0, 7); monthMap[m] = (monthMap[m] || 0) + 1; });
    let cum = 0;
    return Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => { cum += count; return { month, total: cum }; });
  }, [marselloCustomers]);

  const tierDist = useMemo(() => {
    const map: Record<string, number> = {};
    marselloCustomers.forEach((c) => { const t = c.tier_name || '未分層'; map[t] = (map[t] || 0) + 1; });
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [marselloCustomers]);

  /* ── Campaign Performance computations ── */
  const filteredCampaigns = useMemo(() => {
    let result = [...viewCampaigns];

    // Status filter
    if (statusFilter === 'ACTIVE') result = result.filter(c => c.status === 'ACTIVE');
    else if (statusFilter === 'PAUSED') result = result.filter(c => c.status === 'PAUSED');
    else if (statusFilter === 'ended') result = result.filter(c => c.status !== 'ACTIVE' && c.status !== 'PAUSED');

    // Performance filter
    if (perfFilter === 'has_purchases') result = result.filter(c => c.purchases > 0);
    else if (perfFilter === 'no_purchases') result = result.filter(c => c.purchases === 0);

    // Sort
    switch (sortBy) {
      case 'purchases': result.sort((a, b) => b.purchases - a.purchases); break;
      case 'ctr': result.sort((a, b) => b.ctr - a.ctr); break;
      case 'spend': result.sort((a, b) => b.spend - a.spend); break;
      case 'roas': result.sort((a, b) => b.roas - a.roas); break;
      case 'cpa': result.sort((a, b) => {
        if (a.cpa === null && b.cpa === null) return 0;
        if (a.cpa === null) return 1;
        if (b.cpa === null) return -1;
        return a.cpa - b.cpa; // lower is better
      }); break;
    }
    return result;
  }, [viewCampaigns, statusFilter, perfFilter, sortBy]);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [statusFilter, perfFilter, sortBy, retailOnly]);

  const totalPages = Math.ceil(filteredCampaigns.length / PAGE_SIZE);
  const paginatedCampaigns = filteredCampaigns.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  /* ── Campaign Summary KPIs ── */
  const campSummary = useMemo(() => {
    const withSpend = viewCampaigns.length;
    const withPurchases = viewCampaigns.filter(c => c.purchases > 0).length;
    const totalPurchases = viewCampaigns.reduce((s, c) => s + c.purchases, 0);
    const totalAdSpend = viewCampaigns.reduce((s, c) => s + c.spend, 0);
    const purchaseCampaigns = viewCampaigns.filter(c => c.purchases > 0);
    const bestRoas = purchaseCampaigns.length > 0
      ? purchaseCampaigns.reduce((best, c) => c.roas > best.roas ? c : best, purchaseCampaigns[0])
      : null;
    const avgCpa = purchaseCampaigns.length > 0
      ? purchaseCampaigns.reduce((s, c) => s + (c.cpa || 0), 0) / purchaseCampaigns.length
      : 0;
    return { withSpend, withPurchases, totalPurchases, totalAdSpend, bestRoas, avgCpa };
  }, [viewCampaigns]);

  /* ── Section 2: ROAS & Ad Efficiency ── */
  const roasSection = useMemo(() => {
    const purchaseCampaigns = viewCampaigns.filter(c => c.purchases > 0);
    const totalPurchases = purchaseCampaigns.reduce((s, c) => s + c.purchases, 0);
    const totalSpendPurch = purchaseCampaigns.reduce((s, c) => s + c.spend, 0);
    const overallRoas = totalSpendPurch > 0 ? (totalPurchases * AOV) / totalSpendPurch : 0;
    const targetRoas = 8;
    const roasProgress = Math.min((overallRoas / targetRoas) * 100, 100);

    const bestCampaign = purchaseCampaigns.length > 0
      ? purchaseCampaigns.reduce((best, c) => c.roas > best.roas ? c : best, purchaseCampaigns[0])
      : null;

    const zeroPurchSpenders = viewCampaigns.filter(c => c.purchases === 0).sort((a, b) => b.spend - a.spend);
    const worstSpender = zeroPurchSpenders.length > 0 ? zeroPurchSpenders[0] : null;

    // Top 10 by purchases for bar chart
    const top10 = [...purchaseCampaigns].sort((a, b) => b.purchases - a.purchases).slice(0, 10).map(c => ({
      name: c.campaign_name?.length > 25 ? c.campaign_name.slice(0, 25) + '…' : (c.campaign_name || 'Unknown'),
      purchases: c.purchases,
      fill: c.rating.score >= 4 ? CHART_COLORS.tertiary : c.rating.score >= 3 ? CHART_COLORS.secondary : CHART_COLORS.primary,
    }));

    // Top 15 spend vs purchases comparison
    const top15 = [...purchaseCampaigns].sort((a, b) => b.purchases - a.purchases).slice(0, 15).map(c => ({
      name: c.campaign_name?.length > 20 ? c.campaign_name.slice(0, 20) + '…' : (c.campaign_name || 'Unknown'),
      spend: Math.round(c.spend),
      purchasesScaled: c.purchases * 100,
      purchases: c.purchases,
    }));

    // Should redo list
    const shouldRedo = purchaseCampaigns.filter(c => c.purchases >= 5).sort((a, b) => b.purchases - a.purchases);

    // Avoid list
    const avoid = viewCampaigns.filter(c => c.spend > 500 && c.purchases === 0 && c.ctr < 3).sort((a, b) => b.spend - a.spend);

    return { overallRoas, targetRoas, roasProgress, bestCampaign, worstSpender, top10, top15, shouldRedo, avoid };
  }, [viewCampaigns]);

  /* ── Status color helper ── */
  function statusColor(status: string) {
    if (status === 'ACTIVE') return 'text-green-400';
    if (status === 'PAUSED') return 'text-yellow-400';
    return 'text-gray-500';
  }

  function ctrColor(ctr: number, spend: number) {
    if (ctr >= 8) return 'text-green-400';
    if (ctr >= 4) return 'text-yellow-400';
    if (spend > 300) return 'text-red-400';
    return '';
  }

  return (
    <div className="space-y-4">
      {/* ── 🪖 業務切換:淨睇零售 vs 全部(戶口同時孭 26King 賣車/租車廣告) ── */}
      <div className="flex items-center gap-2 flex-wrap" data-testid="business-toggle">
        <button
          onClick={() => toggleRetailOnly(true)}
          data-testid="toggle-retail-only"
          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${retailOnly ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'}`}
        >
          🪖 淨睇零售
        </button>
        <button
          onClick={() => toggleRetailOnly(false)}
          data-testid="toggle-all-business"
          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${!retailOnly ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'}`}
        >
          全部業務
        </button>
        {retailOnly && !campaignsLoading && hiddenCampaignCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            已隱藏 {hiddenCampaignCount} 個非零售活動（26King 賣車／租車／車房／自駕團）· 查詢按同事分隊＋channel 線過濾
          </span>
        )}
        {retailOnly && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            * 零售廣告數字按 campaign 分類逐日加總；分類唔啱可以喺活動表撳「業務」chip 反轉
          </span>
        )}
      </div>

      {/* ── Existing Meta KPIs ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title={retailOnly ? 'Meta 支出（零售）' : 'Meta 支出'} subtitle="Spend" value={formatCurrency(totalSpend)} icon={DollarSign} loading={loading} testId="kpi-spend" />
        <KpiCard title="曝光量" subtitle="Impressions" value={formatNumber(totalImpressions)} icon={Eye} loading={loading} testId="kpi-imp" />
        <KpiCard title="點擊" subtitle="Clicks" value={formatNumber(totalClicks)} icon={MousePointer} loading={loading} testId="kpi-clicks" />
        <KpiCard title="CPC" subtitle="Avg" value={`HK$${avgCPC.toFixed(2)}`} icon={BarChart3} loading={loading} testId="kpi-cpc" />
        <KpiCard title="CTR" subtitle="Rate" value={formatPercent(avgCTR)} icon={Percent} loading={loading} testId="kpi-ctr" />
        <KpiCard title="廣告佔比率" subtitle="Rev/Spend" value={roas > 100 ? `>​99x` : `${roas.toFixed(1)}x`} icon={TrendingUp} loading={loading} testId="kpi-roas" />
      </div>

      {/* ═══ 💰 廣告 ↔ 銷售掛勾 Ad ↔ Sales ═══ */}
      <h2 className="text-sm font-semibold pt-2" data-testid="section-ad-sales">
        💰 廣告 ↔ 銷售掛勾 <span className="text-xs font-normal text-muted-foreground">Ad ↔ Sales</span>
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="總銷售" subtitle="Total Sales" value={formatCurrency(totalSales)} icon={DollarSign} loading={loading} testId="kpi-total-sales" />
        <KpiCard title="線上" subtitle="Shopify" value={formatCurrency(totalShopifyRev)} icon={Globe} loading={loading} testId="kpi-online-sales" />
        <KpiCard title="實體零售" subtitle="門市 POS" value={formatCurrency(totalRetailRev)} icon={Store} loading={loading} testId="kpi-retail-sales" />
        <KpiCard title="廣告費" subtitle="Ad Spend" value={formatCurrency(totalSpend)} icon={DollarSign} loading={loading} testId="kpi-ad-spend" />
        <KpiCard title="廣告成本佔比" subtitle="Spend/Sales" value={formatPercent(adCostPct)} icon={Percent} loading={loading} testId="kpi-ad-cost-pct" />
        <KpiCard title="Blended CAC" subtitle="廣告費/新會員" value={blendedCAC > 0 ? formatCurrency(blendedCAC) : '—'} icon={Target} loading={loading} testId="kpi-blended-cac" />
      </div>

      {/* ═══ 💬 客服查詢 SleekFlow ═══ */}
      <h2 className="text-sm font-semibold pt-2" data-testid="section-inquiries">
        💬 客服查詢 <span className="text-xs font-normal text-muted-foreground">SleekFlow Inquiries</span>
      </h2>
      {!loading && inquiries.length === 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300">
          未收到 SleekFlow 數據 — 要喺 SleekFlow Flow Builder 設一次 webhook(收到訊息 → HTTP Request 指去 dashboard),設定咗之後新查詢就會自動出現喺度。
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="查詢對話" subtitle="Conversations" value={formatNumber(inquiryStats.total)} icon={MessageCircle} loading={loading} testId="kpi-inq-total" />
        <KpiCard title="獨立客人" subtitle="Unique Contacts" value={formatNumber(inquiryStats.contacts)} icon={Target} loading={loading} testId="kpi-inq-contacts" />
        <KpiCard title="WhatsApp" subtitle="對話" value={formatNumber(inquiryStats.whatsapp)} icon={MessageCircle} loading={loading} testId="kpi-inq-wa" />
        <KpiCard title="Instagram" subtitle="對話" value={formatNumber(inquiryStats.instagram)} icon={MessageCircle} loading={loading} testId="kpi-inq-ig" />
        <KpiCard title="Facebook" subtitle="對話" value={formatNumber(inquiryStats.facebook)} icon={MessageCircle} loading={loading} testId="kpi-inq-fb" />
        <KpiCard title="每查詢廣告成本" subtitle="Spend/Inquiry" value={costPerInquiry > 0 ? formatCurrency(costPerInquiry) : '—'} icon={DollarSign} loading={loading} testId="kpi-inq-cost" />
      </div>

      {/* 入口拆分:經 Meta 廣告(CTWA flow 標記)vs 直接搵上門 */}
      {!loading && inquiryStats.total > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-muted-foreground">查詢入口:</span>
          <span className="px-2 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 tabular-nums">
            經廣告 {inquiryStats.adConvs}
          </span>
          <span className="px-2 py-0.5 rounded border border-border bg-card tabular-nums">
            直接 {inquiryStats.total - inquiryStats.adConvs}
          </span>
          {inquiryStats.adConvs === 0 && (
            <span className="text-[10px] text-muted-foreground">
              （廣告入口靠 CTWA flow 標記 — 由設定嗰日起計,歷史數據冇呢個標記）
            </span>
          )}
        </div>
      )}

      {/* 🔥 最多人查詢 Top 10(訊息內容對照商品字典;只存對照結果唔存原文) */}
      {!loading && (inquiryStats.topBrands.length > 0 || inquiryStats.topProducts.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card className="border-border/40">
            <CardContent className="p-3">
              <h3 className="text-xs font-semibold mb-2">🔥 最多人查詢品牌 Top 10 <span className="font-normal text-muted-foreground">按對話數 · 撳一行睇對話</span></h3>
              <table className="w-full text-xs">
                <tbody>
                  {inquiryStats.topBrands.map((b, i) => (
                    <tr
                      key={b.name}
                      className="border-b border-border/20 cursor-pointer hover:bg-muted/20 transition-colors"
                      onClick={() => setInquiryDetail({ title: b.name, count: b.count, msgs: b.msgs })}
                      title="撳嚟睇 SleekFlow 對話"
                      data-testid={`brand-row-${i}`}
                    >
                      <td className="py-1 text-muted-foreground w-6 tabular-nums">{i + 1}</td>
                      <td className="py-1 font-medium">{b.name}</td>
                      <td className="py-1 text-right tabular-nums whitespace-nowrap">
                        {b.count} 單<MessageCircle className="inline h-3 w-3 text-muted-foreground ml-1.5 -mt-0.5" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card className="border-border/40">
            <CardContent className="p-3">
              <h3 className="text-xs font-semibold mb-2">🔥 最多人查詢單品 <span className="font-normal text-muted-foreground">認到型號先計 · 撳一行睇對話</span></h3>
              {inquiryStats.topProducts.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">未有認到型號嘅查詢</p>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {inquiryStats.topProducts.map((p, i) => (
                      <tr
                        key={p.name}
                        className="border-b border-border/20 cursor-pointer hover:bg-muted/20 transition-colors"
                        onClick={() => setInquiryDetail({ title: p.name, count: p.count, msgs: p.msgs })}
                        title="撳嚟睇 SleekFlow 對話"
                        data-testid={`product-row-${i}`}
                      >
                        <td className="py-1 text-muted-foreground w-6 tabular-nums">{i + 1}</td>
                        <td className="py-1 truncate max-w-[260px]" title={p.name}>{p.name.length > 42 ? p.name.slice(0, 42) + '…' : p.name}</td>
                        <td className="py-1 text-right tabular-nums whitespace-nowrap">
                          {p.count} 單<MessageCircle className="inline h-3 w-3 text-muted-foreground ml-1.5 -mt-0.5" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-[10px] text-muted-foreground mt-2">* 由訊息文字對照商品字典;認到商品嘅訊息會存原文,撳行可以睇返對話。「呢個幾錢」呢類認唔到嘅唔入榜、唔存原文</p>
            </CardContent>
          </Card>
        </div>
      )}

      <ChartCard title="每日 總銷售 vs 廣告費 vs 客服查詢" subtitle="Daily Total Sales vs Ad Spend vs Inquiries" note="* 總銷售 = 線上 Shopify + 實體門市(BC CARSHOP,一直不含車房維修)。查詢 = SleekFlow 每日 distinct 對話數。實體零售多數非廣告驅動,故以「廣告成本佔比」睇整體強度;上方「廣告佔比率」卡為線上 ROAS,相對可歸因。非逐單歸因。">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={salesVsSpend}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} tickFormatter={(v) => `$${v.toFixed(0)}`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, n: string) => n === 'Ad Spend' ? [`HK$${v.toFixed(0)}`, n] : n === '查詢 Inquiries' ? [formatNumber(v), n] : [formatCurrency(v), n]} />
            <Area yAxisId="left" type="monotone" dataKey="online" stackId="sales" name="線上 Online" stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary} fillOpacity={0.25} strokeWidth={1.5} />
            <Area yAxisId="left" type="monotone" dataKey="retail" stackId="sales" name="實體零售 Retail" stroke={CHART_COLORS.tertiary} fill={CHART_COLORS.tertiary} fillOpacity={0.25} strokeWidth={1.5} />
            <Line yAxisId="right" type="monotone" dataKey="spend" name="Ad Spend" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="inquiries" name="查詢 Inquiries" stroke={CHART_COLORS.secondary} strokeWidth={2} strokeDasharray="4 2" dot={false} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── P3: 每日貢獻表 Daily Contribution ── */}
      <Card className="border-border/40 overflow-hidden">
        <CardContent className="p-0">
          <div className="px-4 pt-3 pb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">每日貢獻表 <span className="text-xs font-normal text-muted-foreground">Daily Contribution</span></h3>
            <span className="text-[11px] text-muted-foreground">由新到舊 · 廣告成本佔比 &gt;30% 標橙</span>
          </div>
          <div className="overflow-auto max-h-[440px]">
            <table className="w-full text-xs" data-testid="daily-contribution-table">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border/40 bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">日期 Date</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">廣告費 Spend</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">查詢 Inq</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">線上 Online</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">實體零售 Retail</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">總銷售 Total</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">廣告成本佔比</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">載入中...</td></tr>
                ) : dailyRows.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">此期間冇數據</td></tr>
                ) : (
                  <>
                    <tr className="border-b border-border/40 bg-muted/40 font-semibold" data-testid="daily-row-total">
                      <td className="px-3 py-2">合計 Total</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalSpend)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{inquiryStats.total > 0 ? formatNumber(inquiryStats.total) : '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalShopifyRev)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalRetailRev)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalSales)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{totalSpend > 0 ? formatPercent(adCostPct) : '—'}</td>
                    </tr>
                    {dailyRows.map((r) => (
                      <tr key={r.date} className="border-b border-border/20 hover:bg-muted/20" data-testid={`daily-row-${r.date}`}>
                        <td className="px-3 py-2 tabular-nums">{r.date}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.spend > 0 ? formatCurrency(r.spend) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.inquiries > 0 ? formatNumber(r.inquiries) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.online)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.retail)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{formatCurrency(r.total)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.spend > 0 && r.total > 0 ? (r.costPct > 30 ? 'text-orange-400' : 'text-green-400') : 'text-muted-foreground'}`}>{r.spend > 0 && r.total > 0 ? formatPercent(r.costPct) : '—'}</td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="CTR 趨勢" subtitle="Click-Through Rate" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={ctrTrend}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} tickFormatter={(v) => `${v.toFixed(1)}%`} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => `${v.toFixed(2)}%`} />
              <Area type="monotone" dataKey="ctr" stroke={CHART_COLORS.tertiary} fill={CHART_COLORS.tertiary} fillOpacity={0.15} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="CPM / CPC" subtitle="Cost Trends" loading={loading}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={costTrend}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
              <YAxis yAxisId="left" tick={AXIS_STYLE} /><YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => `HK$${v.toFixed(2)}`} />
              <Line yAxisId="left" type="monotone" dataKey="cpm" name="CPM" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={false} />
              <Line yAxisId="right" type="monotone" dataKey="cpc" name="CPC" stroke={CHART_COLORS.quaternary} strokeWidth={2} dot={false} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="曝光 vs 點擊" subtitle="Impressions vs Clicks" loading={loading}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={impClickTrend}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => formatNumber(v)} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatNumber(v)} />
            <Area yAxisId="left" type="monotone" dataKey="impressions" name="Impressions" stroke={CHART_COLORS.secondary} fill={CHART_COLORS.secondary} fillOpacity={0.1} strokeWidth={2} />
            <Area yAxisId="right" type="monotone" dataKey="clicks" name="Clicks" stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary} fillOpacity={0.1} strokeWidth={2} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Marsello Section (existing) ── */}
      <h2 className="text-sm font-semibold pt-2">Marsello 會員 <span className="text-xs font-normal text-muted-foreground">Analytics</span></h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="會員增長" subtitle="Cumulative" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={memberGrowth}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="month" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} /><Line type="monotone" dataKey="total" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="活躍 vs 非活躍" subtitle="Active Split" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={[{ name: '活躍', value: activeMembers }, { name: '非活躍', value: inactiveMembers }]} cx="50%" cy="50%" innerRadius={50} outerRadius={75} dataKey="value" paddingAngle={2}>
                <Cell fill={CHART_COLORS.tertiary} /><Cell fill={CHART_COLORS.fifth} />
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} /><Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="等級分佈" subtitle="Tier" loading={loading}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tierDist}>
              <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="name" tick={AXIS_STYLE} /><YAxis tick={AXIS_STYLE} />
              <Tooltip {...TOOLTIP_STYLE} /><Bar dataKey="value" fill={CHART_COLORS.quaternary} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
           Section 1: 📊 廣告活動表現 Campaign Performance
         ═══════════════════════════════════════════════════════════════ */}
      <h2 className="text-sm font-semibold pt-4" data-testid="section-campaign-performance">
        📊 廣告活動表現 <span className="text-xs font-normal text-muted-foreground">Campaign Performance</span>
      </h2>

      {/* Summary KPI cards */}
      {!campaignsLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard title="有花費活動" subtitle="With Spend" value={String(campSummary.withSpend)} icon={BarChart3} testId="kpi-camp-total" />
          <KpiCard title="有購買活動" subtitle="With Purchases" value={String(campSummary.withPurchases)} icon={Target} testId="kpi-camp-purchases" />
          <KpiCard title="總購買數" subtitle="Total Purchases" value={String(campSummary.totalPurchases)} icon={TrendingUp} testId="kpi-camp-total-purchases" />
          <KpiCard title="最佳 ROAS" subtitle="Best Campaign" value={campSummary.bestRoas ? `${campSummary.bestRoas.roas.toFixed(1)}x` : '-'} icon={Award} testId="kpi-camp-best-roas" />
          <KpiCard title="平均 CPA" subtitle="Avg (有購買)" value={campSummary.avgCpa > 0 ? `HK$${campSummary.avgCpa.toFixed(0)}` : '-'} icon={DollarSign} testId="kpi-camp-avg-cpa" />
          <KpiCard title="總廣告費" subtitle="Total Ad Spend" value={formatCurrency(campSummary.totalAdSpend)} icon={DollarSign} testId="kpi-camp-total-spend" />
        </div>
      )}

      {/* Sort + Filter controls */}
      <Card className="border-border/40">
        <CardContent className="p-4 space-y-3">
          {/* Sort buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">排序:</span>
            {([
              { key: 'purchases', label: '按購買數 Purchases ↓' },
              { key: 'ctr', label: '按 CTR ↓' },
              { key: 'spend', label: '按花費 Spend ↓' },
              { key: 'roas', label: '按 ROAS ↓' },
              { key: 'cpa', label: '按 CPA ↑' },
            ] as { key: SortBy; label: string }[]).map(s => (
              <button
                key={s.key}
                data-testid={`sort-${s.key}`}
                onClick={() => setSortBy(s.key)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${sortBy === s.key ? 'bg-primary text-primary-foreground border-primary' : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-border'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* Filter row */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">狀態:</span>
              {([
                { key: 'all', label: 'All' },
                { key: 'ACTIVE', label: 'Active' },
                { key: 'PAUSED', label: 'Paused' },
                { key: 'ended', label: 'Ended' },
              ] as { key: StatusFilter; label: string }[]).map(f => (
                <button
                  key={f.key}
                  data-testid={`filter-status-${f.key}`}
                  onClick={() => setStatusFilter(f.key)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${statusFilter === f.key ? 'bg-secondary text-foreground border-border' : 'border-border/40 text-muted-foreground hover:text-foreground'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">表現:</span>
              {([
                { key: 'all', label: 'All' },
                { key: 'has_purchases', label: '有購買 Has purchases' },
                { key: 'no_purchases', label: '無購買 No purchases' },
              ] as { key: PerfFilter; label: string }[]).map(f => (
                <button
                  key={f.key}
                  data-testid={`filter-perf-${f.key}`}
                  onClick={() => setPerfFilter(f.key)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${perfFilter === f.key ? 'bg-secondary text-foreground border-border' : 'border-border/40 text-muted-foreground hover:text-foreground'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground ml-auto tabular-nums">
              {filteredCampaigns.length} campaigns
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Campaign table */}
      <Card className="border-border/40 overflow-hidden">
        <CardContent className="p-0">
          {campaignsLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">載入中...</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="campaign-table">
                  <thead>
                    <tr className="border-b border-border/40 bg-muted/30">
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">評分</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">活動名稱 Campaign</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">業務</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">狀態</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">花費 Spend</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">曝光 Imp</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">CTR</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">CPC</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">購買</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">ROAS</th>
                      <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">CPA</th>
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">建議</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedCampaigns.map((c, i) => (
                      <tr
                        key={c.campaign_id || i}
                        data-testid={`campaign-row-${i}`}
                        onClick={() => setDetailCampaign(c)}
                        title="撳嚟睇深度數據(人數/查詢/每日趨勢/受眾)"
                        className="border-b border-border/20 hover:bg-muted/20 cursor-pointer transition-colors"
                      >
                        <td className="px-3 py-2">
                          <span className={`whitespace-nowrap ${c.rating.color}`}>{c.rating.label}</span>
                        </td>
                        <td className="px-3 py-2 max-w-[220px]">
                          <span
                            className="truncate block"
                            title={c.campaign_name || ''}
                          >
                            {c.campaign_name?.length > 35 ? c.campaign_name.slice(0, 35) + '…' : (c.campaign_name || '—')}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {/* 業務 chip — 撳一下反轉零售/非零售(override 入 DB;分類錯先需要撳) */}
                          <button
                            onClick={(ev) => flipCampaignBusiness(c, ev)}
                            disabled={savingBizId === String(c.campaign_id)}
                            title="撳嚟反轉零售/非零售分類(會記住)"
                            data-testid={`biz-chip-${i}`}
                            className={`px-1.5 py-0.5 rounded text-[10px] border whitespace-nowrap transition-colors disabled:opacity-40 ${
                              bizById[String(c.campaign_id)] === 'nonretail'
                                ? 'border-orange-500/40 bg-orange-500/10 text-orange-300 hover:border-orange-400'
                                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400'
                            }`}
                          >
                            {savingBizId === String(c.campaign_id) ? '…' : bizById[String(c.campaign_id)] === 'nonretail' ? '非零售' : '零售'}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`${statusColor(c.status)} font-medium`}>
                            {c.status || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">HK${c.spend.toLocaleString('en-HK', { maximumFractionDigits: 0 })}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(c.impressions)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${ctrColor(c.ctr, c.spend)}`}>{c.ctr.toFixed(2)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">HK${c.cpc.toFixed(2)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${c.purchases > 0 ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{c.purchases}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.purchases > 0 ? <span className="text-green-400">{c.roas.toFixed(1)}x</span> : <span className="text-muted-foreground">-</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {c.cpa !== null ? `HK$${c.cpa.toFixed(0)}` : <span className="text-muted-foreground">-</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs whitespace-nowrap ${
                            c.recommendation === '重複投放' || c.recommendation === '可再做' ? 'text-green-400'
                            : c.recommendation === '不建議再做' ? 'text-red-400'
                            : c.recommendation === '審查受眾' ? 'text-orange-400'
                            : 'text-muted-foreground'
                          }`}>
                            {c.recommendation}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border/30">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    第 {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredCampaigns.length)} 筆，共 {filteredCampaigns.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      data-testid="page-prev"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="p-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {page + 1} / {totalPages}
                    </span>
                    <button
                      data-testid="page-next"
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="p-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════════════════
           Section 2: 🎯 ROAS & 廣告效益 Ad Efficiency
         ═══════════════════════════════════════════════════════════════ */}
      <h2 className="text-sm font-semibold pt-4" data-testid="section-roas-efficiency">
        🎯 ROAS & 廣告效益 <span className="text-xs font-normal text-muted-foreground">Ad Efficiency</span>
      </h2>

      {/* ROAS KPI Row */}
      {!campaignsLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Overall ROAS */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">整體 ROAS <span className="opacity-70">Overall</span></p>
              <p className="text-xl font-semibold tabular-nums" data-testid="roas-overall">
                {roasSection.overallRoas.toFixed(1)}x
              </p>
            </CardContent>
          </Card>
          {/* Target ROAS with progress */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">目標 ROAS <span className="opacity-70">Target: {roasSection.targetRoas}x</span></p>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${roasSection.overallRoas >= roasSection.targetRoas ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ width: `${roasSection.roasProgress}%` }}
                  />
                </div>
                <span className={`text-sm font-semibold tabular-nums ${roasSection.overallRoas >= roasSection.targetRoas ? 'text-green-400' : 'text-red-400'}`}>
                  {roasSection.roasProgress.toFixed(0)}%
                </span>
              </div>
            </CardContent>
          </Card>
          {/* Best campaign */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">最佳 Campaign <span className="opacity-70">Best</span></p>
              <p className="text-sm font-medium truncate" title={roasSection.bestCampaign?.campaign_name || ''} data-testid="roas-best-campaign">
                {roasSection.bestCampaign
                  ? `${roasSection.bestCampaign.campaign_name?.slice(0, 30) || '—'} (${roasSection.bestCampaign.roas.toFixed(1)}x)`
                  : '-'}
              </p>
            </CardContent>
          </Card>
          {/* Worst spender */}
          <Card className="border-border/40">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">最差投入 <span className="opacity-70">Worst Spend</span></p>
              <p className="text-sm font-medium truncate text-red-400" title={roasSection.worstSpender?.campaign_name || ''} data-testid="roas-worst-spender">
                {roasSection.worstSpender
                  ? `${roasSection.worstSpender.campaign_name?.slice(0, 30) || '—'} (HK$${roasSection.worstSpender.spend.toLocaleString('en-HK', { maximumFractionDigits: 0 })})`
                  : '-'}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top 10 by purchases - horizontal bar */}
        <ChartCard title="Top 10 購買活動" subtitle="By Purchases" loading={campaignsLoading}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={roasSection.top10} layout="vertical" margin={{ left: 10, right: 20 }}>
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" tick={AXIS_STYLE} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} width={140} />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(v: number) => [`${v} purchases`, 'Purchases']}
              />
              <Bar dataKey="purchases" radius={[0, 3, 3, 0]}>
                {roasSection.top10.map((entry, idx) => (
                  <Cell key={idx} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Spend vs Purchases comparison */}
        <ChartCard title="花費 vs 購買 (Top 15)" subtitle="Spend (red) vs Purchases×100 (green)" loading={campaignsLoading}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={roasSection.top15} layout="vertical" margin={{ left: 10, right: 20 }}>
              <CartesianGrid {...GRID_STYLE} horizontal={false} />
              <XAxis type="number" tick={AXIS_STYLE} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_STYLE, fontSize: 10 }} width={120} />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(v: number, name: string) => {
                  if (name === 'Spend') return [`HK$${v.toLocaleString()}`, name];
                  return [`${v / 100} purchases (×100)`, 'Purchases'];
                }}
              />
              <Bar dataKey="spend" name="Spend" fill={CHART_COLORS.fifth} radius={[0, 3, 3, 0]} />
              <Bar dataKey="purchasesScaled" name="Purchases ×100" fill={CHART_COLORS.tertiary} radius={[0, 3, 3, 0]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Should Redo list ── */}
      {roasSection.shouldRedo.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-green-400 mb-2">
            ✅ 值得重做 Should Redo ({roasSection.shouldRedo.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {roasSection.shouldRedo.map((c, i) => (
              <Card key={c.id || i} className="border-green-800/40 bg-green-950/20" data-testid={`redo-card-${i}`}>
                <CardContent className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate" title={c.campaign_name}>
                      {c.campaign_name?.slice(0, 40) || '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                      {c.purchases} purchases · CPA HK${c.cpa?.toFixed(0) || '—'}
                    </p>
                  </div>
                  <span className="text-green-400 text-xs font-medium whitespace-nowrap">✅ 重做</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── Avoid list ── */}
      {roasSection.avoid.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-red-400 mb-2">
            ❌ 不建議再做 Avoid ({roasSection.avoid.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {roasSection.avoid.map((c, i) => (
              <Card key={c.id || i} className="border-red-800/40 bg-red-950/20" data-testid={`avoid-card-${i}`}>
                <CardContent className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate" title={c.campaign_name}>
                      {c.campaign_name?.slice(0, 40) || '—'}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">
                      Spent HK${c.spend.toLocaleString('en-HK', { maximumFractionDigits: 0 })}
                    </p>
                  </div>
                  <span className="text-red-400 text-xs font-medium whitespace-nowrap">❌ 避免</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Campaign drill-down 彈窗 */}
      {detailCampaign && (
        <CampaignDetailModal campaign={detailCampaign} onClose={() => setDetailCampaign(null)} />
      )}

      {/* SleekFlow 對話彈窗(品牌/單品 Top 10 撳行打開) */}
      {inquiryDetail && (
        <InquiryChatModal
          title={inquiryDetail.title}
          count={inquiryDetail.count}
          msgs={inquiryDetail.msgs}
          onClose={() => setInquiryDetail(null)}
        />
      )}
    </div>
  );
}

/* ── SleekFlow 對話彈窗 — 客人訊息用聊天 bubble 排版,新至舊 ── */
function InquiryChatModal({ title, count, msgs, onClose }: { title: string; count: number; msgs: InqMsg[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-5xl min-h-[55vh] max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
        data-testid="inquiry-chat-modal"
      >
        {/* header */}
        <div className="flex items-center gap-3 p-4 border-b border-border/60">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-snug truncate" title={title}>💬 {title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {count} 單對話 · 顯示 {msgs.length} 條認到商品嘅訊息 · 新至舊
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground shrink-0" title="關閉 (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body — 聊天 bubble */}
        <div className="overflow-y-auto p-4 space-y-3">
          {msgs.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">
              呢批對話係舊數據,未有存低原文（新查詢會自動有）
            </p>
          ) : (
            msgs.map((m, i) => (
              <div key={i}>
                <p className="text-xs text-muted-foreground mb-1 tabular-nums">
                  {fmtHK(m.at)} · {m.who}
                </p>
                <div className="rounded-lg rounded-tl-sm bg-muted/40 border border-border/30 px-4 py-3 text-base leading-relaxed w-fit max-w-[85%] whitespace-pre-wrap break-words">
                  {m.text}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Campaign drill-down 彈窗 ─────────────────────────────────────────────────
   撳活動行開,即時經 /api/meta-campaign(Meta token 留 server)攞:
   接觸人數/頻次、查詢(由廣告開始嘅訊息對話)、每日趨勢、年齡×性別、FB/IG 平台分佈 */

const ACTION_LABELS: Record<string, string> = {
  'onsite_conversion.messaging_conversation_started_7d': '開始訊息對話（查詢）',
  'onsite_conversion.total_messaging_connection': '訊息互動',
  'onsite_conversion.messaging_conversation_replied_7d': '對話獲回覆',
  'onsite_conversion.messaging_welcome_message_view': '見到歡迎訊息',
  'onsite_conversion.messaging_first_reply': '店方首次回覆',
  'onsite_conversion.messaging_user_depth_2_message_send': '客人回覆第 2 句',
  'onsite_conversion.messaging_user_depth_3_message_send': '客人回覆第 3 句',
  link_click: '連結點擊',
  landing_page_view: '到達頁瀏覽',
  post_engagement: '帖文互動',
  page_engagement: '專頁互動',
  post_reaction: '心情／讚好',
  comment: '留言',
  post: '分享',
  video_view: '影片觀看',
  omni_purchase: '購買',
  purchase: '購買',
  'offsite_conversion.fb_pixel_purchase': '購買（Pixel）',
  'offsite_conversion.fb_pixel_add_to_cart': '加入購物車',
  'offsite_conversion.fb_pixel_initiate_checkout': '開始結帳',
  'offsite_conversion.fb_pixel_view_content': '瀏覽商品',
  lead: '潛在客戶表格',
  'onsite_conversion.lead_grouped': '潛在客戶',
  'onsite_conversion.post_save': '收藏帖文',
};

const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  audience_network: 'Audience Network',
  messenger: 'Messenger',
  threads: 'Threads',
  unknown: '其他',
};

const GENDER_LABELS: Record<string, string> = { male: '男', female: '女', unknown: '未知' };

const DETAIL_PRESETS: { key: string; label: string }[] = [
  { key: 'last_7d', label: '7日' },
  { key: 'last_30d', label: '30日' },
  { key: 'last_90d', label: '90日' },
  { key: 'maximum', label: '全期' },
];

function CampaignDetailModal({ campaign, onClose }: { campaign: any; onClose: () => void }) {
  const [preset, setPreset] = useState('last_30d');
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: any | null }>({
    loading: true,
    error: null,
    data: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setState({ loading: true, error: null, data: null });
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error('未登入 — 請重新登入 dashboard');
        const resp = await fetch('/api/meta-campaign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ campaignId: campaign.campaign_id, datePreset: preset }),
        });
        const j: any = await resp.json().catch(() => null);
        if (cancelled) return;
        if (!resp.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${resp.status}`);
        setState({ loading: false, error: null, data: j });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : String(e), data: null });
      }
    }
    load();
    return () => { cancelled = true; };
  }, [campaign.campaign_id, preset]);

  // ESC 關閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = state.data;
  const s = d?.summary;

  // 年齡 × 性別 pivot(row = 年齡層,col = 性別,值 = 接觸人數)
  const demoPivot = useMemo(() => {
    const rows: Record<string, Record<string, number>> = {};
    for (const r of d?.demo ?? []) {
      rows[r.age] = rows[r.age] || {};
      rows[r.age][r.gender] = (rows[r.age][r.gender] || 0) + r.reach;
    }
    return Object.entries(rows).sort((a, b) => a[0].localeCompare(b[0]));
  }, [d]);
  const demoMax = useMemo(
    () => Math.max(1, ...(d?.demo ?? []).map((r: any) => r.reach)),
    [d]
  );

  const dailyChart = useMemo(
    () => (d?.daily ?? []).map((r: any) => ({ ...r, date: String(r.date).slice(5) })),
    [d]
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start gap-3 p-4 border-b border-border/60">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug">{campaign.campaign_name || '—'}</h2>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
              <span className={campaign.status === 'ACTIVE' ? 'text-green-400' : ''}>{campaign.status || '—'}</span>
              {campaign.objective && <span>· {campaign.objective}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {DETAIL_PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                  preset === p.key
                    ? 'bg-primary/90 text-primary-foreground border-primary'
                    : 'border-border bg-background hover:bg-accent/60'
                }`}
              >
                {p.label}
              </button>
            ))}
            <button onClick={onClose} className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground ml-1" title="關閉 (Esc)">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* body */}
        <div className="overflow-y-auto p-4 space-y-4">
          {state.loading ? (
            <div className="py-16 text-center text-sm text-muted-foreground animate-pulse">向 Meta 攞緊即時數據…</div>
          ) : state.error ? (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-xs whitespace-pre-wrap">
              {state.error}
            </div>
          ) : s ? (
            <>
              {/* KPI grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <DetailKpi label="接觸人數 Reach" value={formatNumber(s.reach)} sub={`平均睇 ${s.frequency ? s.frequency.toFixed(1) : '—'} 次`} />
                <DetailKpi label="曝光 Impressions" value={formatNumber(s.impressions)} sub={`CPM HK$${s.cpm.toFixed(1)}`} />
                <DetailKpi
                  label="查詢（訊息對話）"
                  value={formatNumber(s.inquiries)}
                  sub={s.inquiries > 0 ? `每個查詢 HK$${(s.spend / s.inquiries).toFixed(0)}` : '—'}
                  highlight
                />
                <DetailKpi
                  label="購買 Purchases"
                  value={formatNumber(s.purchases)}
                  sub={s.purchaseValue > 0 ? `價值 HK$${formatNumber(Math.round(s.purchaseValue))}` : '—'}
                />
                <DetailKpi label="花費 Spend" value={`HK$${formatNumber(Math.round(s.spend))}`} sub={`CPC HK$${s.cpc.toFixed(2)}`} />
                <DetailKpi label="連結點擊" value={formatNumber(s.linkClicks)} sub={`CTR ${s.ctr.toFixed(2)}%`} />
                <DetailKpi label="總點擊 Clicks" value={formatNumber(s.clicks)} sub="含所有互動點擊" />
                <DetailKpi
                  label="接觸成本"
                  value={s.reach > 0 ? `HK$${((s.spend / s.reach) * 1000).toFixed(0)}` : '—'}
                  sub="每千人接觸"
                />
              </div>

              {/* 每日趨勢 */}
              {dailyChart.length > 1 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1.5">每日趨勢（花費 vs 接觸人數 vs 查詢）</p>
                  <ResponsiveContainer width="100%" height={190}>
                    <ComposedChart data={dailyChart} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="date" {...AXIS_STYLE} interval="preserveStartEnd" />
                      <YAxis yAxisId="l" {...AXIS_STYLE} />
                      <YAxis yAxisId="r" orientation="right" {...AXIS_STYLE} />
                      <Tooltip {...TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar yAxisId="l" dataKey="spend" name="花費 HK$" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
                      <Line yAxisId="r" dataKey="reach" name="人數" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={false} />
                      <Line yAxisId="r" dataKey="inquiries" name="查詢" stroke={CHART_COLORS.tertiary || '#f59e0b'} strokeWidth={2} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* 平台分佈 */}
              {(d.platform ?? []).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1.5">平台分佈</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-muted-foreground border-b border-border/40">
                        <th className="text-left py-1 font-normal">平台</th>
                        <th className="text-right py-1 font-normal">人數</th>
                        <th className="text-right py-1 font-normal">曝光</th>
                        <th className="text-right py-1 font-normal">花費</th>
                        <th className="text-right py-1 font-normal">查詢</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.platform.map((p: any) => (
                        <tr key={p.platform} className="border-b border-border/20">
                          <td className="py-1">{PLATFORM_LABELS[p.platform] || p.platform}</td>
                          <td className="py-1 text-right tabular-nums">{formatNumber(p.reach)}</td>
                          <td className="py-1 text-right tabular-nums">{formatNumber(p.impressions)}</td>
                          <td className="py-1 text-right tabular-nums">HK${formatNumber(Math.round(p.spend))}</td>
                          <td className="py-1 text-right tabular-nums">{formatNumber(p.inquiries)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 受眾分佈:年齡 × 性別(接觸人數) */}
              {demoPivot.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1.5">受眾分佈（接觸人數,按年齡 × 性別）</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-muted-foreground border-b border-border/40">
                        <th className="text-left py-1 font-normal">年齡</th>
                        {['male', 'female', 'unknown'].map(g => (
                          <th key={g} className="text-right py-1 font-normal">{GENDER_LABELS[g]}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {demoPivot.map(([age, byG]) => (
                        <tr key={age} className="border-b border-border/20">
                          <td className="py-1 tabular-nums">{age}</td>
                          {['male', 'female', 'unknown'].map(g => {
                            const v = byG[g] || 0;
                            return (
                              <td key={g} className="py-1 text-right tabular-nums">
                                <span className={v === demoMax ? 'font-bold text-foreground' : v === 0 ? 'text-muted-foreground/50' : ''}>
                                  {v ? formatNumber(v) : '—'}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 行動 breakdown */}
              {(s.actions ?? []).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1.5 inline-flex items-center gap-1">
                    <MessageCircle className="h-3 w-3" /> 廣告帶嚟嘅行動（Top 8）
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5">
                    {s.actions.slice(0, 8).map((a: any) => (
                      <div key={a.type} className="flex items-center justify-between text-xs border-b border-border/20 py-1">
                        <span className="text-muted-foreground truncate mr-2" title={a.type}>
                          {ACTION_LABELS[a.type] || a.type}
                        </span>
                        <span className="tabular-nums font-medium">{formatNumber(a.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="py-16 text-center text-sm text-muted-foreground">呢個時段冇投放數據</div>
          )}
        </div>

        {/* footer */}
        <div className="px-4 py-2 border-t border-border/60 text-[10px] text-muted-foreground">
          數據嚟自 Meta 即時 API · 「查詢」= 由廣告開始嘅訊息對話（Messenger／IG,7 日歸因）· 人數為估算接觸人數
        </div>
      </div>
    </div>
  );
}

function DetailKpi({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-2 ${highlight ? 'border-amber-500/40 bg-amber-500/10' : 'border-border/60 bg-background/40'}`}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums mt-0.5 ${highlight ? 'text-amber-300' : ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}
