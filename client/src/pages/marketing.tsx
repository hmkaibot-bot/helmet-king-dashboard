import { Fragment, useEffect, useState, useMemo } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryWithDateRange, queryAll } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { campaignBusiness, isRetailInquiry, type Business } from '@/lib/business-filter';
import { CampaignDetailModal } from '@/components/campaign-detail-modal';
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

/** 2026-07-22T… / 2026-07-22 → 22/7;冇日子就空白 */
function shortDate(v: string | null | undefined): string {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getDate()}/${d.getMonth() + 1}`;
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
  // Shopify 一個戶口包住兩盤數:source_name='pos' 係門市收銀,其餘先係真線上。
  // (門市長期佔九成半,所以一定要拆開,唔可以全部當「線上」。)
  const [posRevByDay, setPosRevByDay] = useState<Record<string, number>>({});
  const [onlineRevByDay, setOnlineRevByDay] = useState<Record<string, number>>({});
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
        const [ads, orders, marsello, inq, campDaily] = await Promise.all([
          queryWithDateRange('meta_ad_insights', 'date,spend,impressions,clicks,reach,cpm,cpc,ctr', 'date', bounds),
          queryWithDateRange('shopify_orders', 'created_at,total_price,financial_status,cancelled_at,source_name', 'created_at', bounds),
          queryAll('marsello_customers', 'id,created_at,last_seen,tier_name,subscribed'),
          // SleekFlow 查詢(電話+原文係品牌 Top 10 撳入去睇對話用;原文只有認到商品嘅訊息先有)
          queryWithDateRange('inquiry_events', 'message_id,conversation_id,contact_id,contact_phone,channel,occurred_at,matched_brand,matched_title,matched_product_type,message_text,source,business', 'occurred_at', bounds),
          queryWithDateRange('meta_campaign_daily', 'campaign_id,date,spend,impressions,clicks,conversations', 'date', bounds),
        ]);
        if (cancelled) return;

        const validOrders = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const posMap: Record<string, number> = {};
        const onlineMap: Record<string, number> = {};
        validOrders.forEach((o: any) => {
          const d = o.created_at?.slice(0, 10);
          if (!d) return;
          const target = String(o.source_name || '') === 'pos' ? posMap : onlineMap;
          target[d] = (target[d] || 0) + (parseFloat(o.total_price) || 0);
        });

        setAdInsights(ads);
        setPosRevByDay(posMap);
        setOnlineRevByDay(onlineMap);
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
  // campaign_id → 最近一次有花費嘅日子 + 最近 7 日花費(用嚟分「仲投緊」/「已停投放」)
  const [recentSpend, setRecentSpend] = useState<Record<string, { last: string; spend7: number }>>({});
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

        // 「仲有冇俾錢」睇最近 14 日實際花費 —— status 靠唔住:好多活動投放期完咗
        // 但一直冇關,Meta 照顯示 ACTIVE。呢個查詢固定睇最近 14 日,唔跟頁面日期範圍,
        // 唔係揀「今日」就會全部睇落好似停晒。
        const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        const { data: recent } = await supabase
          .from('meta_campaign_daily')
          .select('campaign_id,date,spend')
          .gte('date', since)
          .gt('spend', 0)
          .limit(5000);
        if (cancelled) return;
        const map: Record<string, { last: string; spend7: number }> = {};
        const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        for (const r of recent || []) {
          const id = String((r as any).campaign_id);
          const day = String((r as any).date).slice(0, 10);
          const row = (map[id] = map[id] || { last: '', spend7: 0 });
          if (day > row.last) row.last = day;
          if (day >= sevenAgo) row.spend7 += parseFloat((r as any).spend) || 0;
        }
        setRecentSpend(map);
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
  const totalPosRev = Object.values(posRevByDay).reduce((s, v) => s + v, 0);
  const totalOnlineRev = Object.values(onlineRevByDay).reduce((s, v) => s + v, 0);
  const roas = totalSpend > 0 ? totalOnlineRev / totalSpend : 0; // 線上 ROAS — 真網店訂單先相對可歸因

  /* ── 廣告 ↔ 銷售掛勾: 線上(Shopify) + 實體零售(BC CARSHOP, 不含車房維修) ── */
  const totalSales = totalPosRev + totalOnlineRev;
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
    const adMsgs: InqMsg[] = [];
    for (const e of viewInquiries) {
      const conv = String(e.conversation_id || e.message_id);
      if (e.source === 'ctwa') {
        adConvSet.add(conv);
        // 原文只有「認到商品」嘅訊息先會存 — 其餘照列出時間/渠道,至少睇到係邊單
        adMsgs.push({
          at: String(e.occurred_at),
          who: whoOf(e),
          text:
            e.message_text ||
            (e.matched_title || e.matched_brand
              ? `查詢：${e.matched_title || e.matched_brand}`
              : '（只記錄咗查詢時間同渠道,未有存低原文）'),
        });
      }
      if (e.matched_brand) {
        (brandConv[e.matched_brand] = brandConv[e.matched_brand] || new Set()).add(conv);
        if (e.message_text) (brandMsgs[e.matched_brand] = brandMsgs[e.matched_brand] || []).push({ at: String(e.occurred_at), who: whoOf(e), text: String(e.message_text) });
      }
      // 車件(MOTORCYCLE PARTS)同服務唔算零售商品 — sync 每晚會清,呢度做多重保險
      if (e.matched_title && !/^(MOTORCYCLE PARTS|SERVICES)/i.test(String(e.matched_product_type || ''))) {
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
      adMsgs: adMsgs.sort((a, b) => b.at.localeCompare(a.at)),
    };
  }, [viewInquiries]);
  // 品牌/單品 Top 10 撳行 → 對話彈窗
  const [inquiryDetail, setInquiryDetail] = useState<{ title: string; count: number; msgs: InqMsg[]; subtitle?: string } | null>(null);
  const [showHowTo, setShowHowTo] = useState(false); // 頁頂長說明摺埋,想睇定義先撳開
  const costPerInquiry = inquiryStats.total > 0 ? totalSpend / inquiryStats.total : 0;

  const salesVsSpend = useMemo(() => {
    const adMap: Record<string, number> = {};
    adSeries.forEach((a) => { adMap[a.date] = a.spend; });
    const allDays = new Set([...adSeries.map((a) => a.date), ...Object.keys(posRevByDay), ...Object.keys(onlineRevByDay), ...Object.keys(inquiryStats.dayCounts)]);
    return Array.from(allDays).sort().map((d) => {
      const online = onlineRevByDay[d] || 0;
      const retail = posRevByDay[d] || 0;
      return { date: d.slice(5), online, retail, total: online + retail, spend: adMap[d] || 0, inquiries: inquiryStats.dayCounts[d] || 0 };
    });
  }, [adSeries, posRevByDay, onlineRevByDay, inquiryStats]);

  // P3: 每日貢獻表 — 完整日期、廣告成本佔比,由新到舊
  const dailyRows = useMemo(() => {
    const adMap: Record<string, number> = {};
    adSeries.forEach((a) => { adMap[a.date] = a.spend; });
    const allDays = new Set([...adSeries.map((a) => a.date), ...Object.keys(posRevByDay), ...Object.keys(onlineRevByDay), ...Object.keys(inquiryStats.dayCounts)]);
    return Array.from(allDays).filter(Boolean).sort((a, b) => b.localeCompare(a)).map((d) => {
      const online = onlineRevByDay[d] || 0;
      const retail = posRevByDay[d] || 0;
      const spend = adMap[d] || 0;
      const total = online + retail;
      return { date: d, online, retail, total, spend, inquiries: inquiryStats.dayCounts[d] || 0, costPct: total > 0 ? (spend / total) * 100 : 0 };
    });
  }, [adSeries, posRevByDay, onlineRevByDay, inquiryStats]);

  const ctrTrend = adSeries.map((a) => ({ date: a.date.slice(5), ctr: a.ctr }));
  const costTrend = adSeries.map((a) => ({ date: a.date.slice(5), cpm: a.cpm, cpc: a.cpc }));
  const impClickTrend = adSeries.map((a) => ({ date: a.date.slice(5), impressions: a.impressions, clicks: a.clicks }));

  /* ── Campaign Performance computations ── */
  // 仲投緊 = 最近 7 日有實際花費。Meta 個 status 靠唔住(投放期完咗都可以一直 ACTIVE)。
  const liveCutoff = useMemo(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), []);
  const isLive = useMemo(
    () => (c: any) => (recentSpend[String(c.campaign_id)]?.last || '') >= liveCutoff,
    [recentSpend, liveCutoff]
  );

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
    // 「仲投緊」永遠排前,組內先跟上面揀嘅排序 —— 分頁都唔會撈亂兩組
    result.sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
    return result;
  }, [viewCampaigns, statusFilter, perfFilter, sortBy, isLive]);

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

  /* ── 🚦 廣告健康警號 ────────────────────────────────────────
     老闆用呢頁嘅目的:監控現有廣告健康。三類警號 + 停投提示,
     全部用手上數據算,唔使多拉 API:
     ① 燒費冇查詢/冇單 ② 每查詢成本比前半期飛升 ③ CTR 跌 / CPM 升
     趨勢一律「後半期 vs 前半期」— adSeries 已經逐日齊。 */
  const adHealth = useMemo(() => {
    const alerts: { level: 'red' | 'amber'; title: string; detail: string }[] = [];

    // ① 燒咗錢但零查詢零轉化嘅 campaign(最近 7 日仲投緊嘅先計 — 停咗嘅唔嘈)
    const burners = viewCampaigns
      .filter(c => isLive(c) && c.spend >= 200 && c.purchases === 0)
      .sort((a, b) => b.spend - a.spend);
    const burnTotal = burners.reduce((s, c) => s + c.spend, 0);
    if (burners.length > 0) {
      alerts.push({
        level: burnTotal >= 500 ? 'red' : 'amber',
        title: `${burners.length} 個仲投緊嘅活動燒咗 ${formatCurrency(burnTotal)} 但零轉化`,
        detail: burners.slice(0, 3).map(c => `${c.campaign_name || '未命名'}(${formatCurrency(c.spend)})`).join('、')
          + (burners.length > 3 ? ` 等 ${burners.length} 個` : '') + ' — 考慮停咗佢或者換受眾',
      });
    }

    // ②③ 前半期 vs 後半期:每查詢成本 / CTR / CPM
    const mid = Math.floor(adSeries.length / 2);
    if (adSeries.length >= 4) {
      const sum = (arr: typeof adSeries) => arr.reduce(
        (a, d) => ({ spend: a.spend + d.spend, imp: a.imp + d.impressions, clicks: a.clicks + d.clicks }),
        { spend: 0, imp: 0, clicks: 0 }
      );
      const firstHalf = sum(adSeries.slice(0, mid));
      const secondHalf = sum(adSeries.slice(mid));
      const firstDays = new Set(adSeries.slice(0, mid).map(d => d.date));
      const secondDays = new Set(adSeries.slice(mid).map(d => d.date));
      const inqIn = (days: Set<string>) =>
        Object.entries(inquiryStats.dayCounts || {}).reduce((s, [d, n]) => s + (days.has(d) ? (n as number) : 0), 0);

      // ② 每查詢成本
      const inq1 = inqIn(firstDays);
      const inq2 = inqIn(secondDays);
      const cpi1 = inq1 > 0 ? firstHalf.spend / inq1 : 0;
      const cpi2 = inq2 > 0 ? secondHalf.spend / inq2 : 0;
      if (cpi1 > 0 && cpi2 > 0) {
        const jump = ((cpi2 - cpi1) / cpi1) * 100;
        if (jump >= 25) {
          alerts.push({
            level: jump >= 50 ? 'red' : 'amber',
            title: `每查詢成本升咗 ${jump.toFixed(0)}%`,
            detail: `前半期 ${formatCurrency(cpi1)}/查詢 → 後半期 ${formatCurrency(cpi2)}/查詢 — 同樣嘅錢換少咗客`,
          });
        }
      }

      // ③ CTR 跌 / CPM 升(創意疲乏)
      const ctr1 = firstHalf.imp > 0 ? (firstHalf.clicks / firstHalf.imp) * 100 : 0;
      const ctr2 = secondHalf.imp > 0 ? (secondHalf.clicks / secondHalf.imp) * 100 : 0;
      if (ctr1 > 0 && ctr2 > 0 && ((ctr2 - ctr1) / ctr1) * 100 <= -20) {
        alerts.push({
          level: 'amber',
          title: `CTR 由 ${ctr1.toFixed(1)}% 跌到 ${ctr2.toFixed(1)}%`,
          detail: '跌超過兩成通常係創意睇厭咗 — 換圖換文案',
        });
      }
      const cpm1 = firstHalf.imp > 0 ? (firstHalf.spend / firstHalf.imp) * 1000 : 0;
      const cpm2 = secondHalf.imp > 0 ? (secondHalf.spend / secondHalf.imp) * 1000 : 0;
      if (cpm1 > 0 && cpm2 > 0 && ((cpm2 - cpm1) / cpm1) * 100 >= 30) {
        alerts.push({
          level: 'amber',
          title: `CPM 升咗 ${(((cpm2 - cpm1) / cpm1) * 100).toFixed(0)}%`,
          detail: `每千次曝光 ${formatCurrency(cpm1)} → ${formatCurrency(cpm2)} — 受眾太窄或者競爭大咗`,
        });
      }
    }

    // ④ 廣告係咪停晒(負責人撳停 / 信用卡出事)
    const lastSpendDay = [...adSeries].reverse().find(d => d.spend > 0)?.date || null;
    const daysSince = lastSpendDay
      ? Math.floor((Date.now() - new Date(lastSpendDay + 'T00:00:00Z').getTime()) / 86400000)
      : null;
    if (totalSpend > 0 && daysSince != null && daysSince >= 3) {
      alerts.push({
        level: 'amber',
        title: `已經 ${daysSince} 日冇廣告支出`,
        detail: `最後有花費係 ${lastSpendDay} — 係咪有人撳咗停,定係付款方式出咗問題?`,
      });
    }

    return { alerts, burners };
  }, [viewCampaigns, isLive, adSeries, inquiryStats, totalSpend]);

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
          <span className="text-xs text-muted-foreground">已隱藏 {hiddenCampaignCount} 個非零售活動</span>
        )}
        <button
          onClick={() => setShowHowTo(v => !v)}
          data-testid="toggle-howto"
          className="ml-auto text-xs px-2 py-1 rounded border border-border/60 text-muted-foreground hover:text-foreground transition-colors"
        >
          {showHowTo ? '收埋說明' : '點解讀 ▾'}
        </button>
      </div>

      {showHowTo && (
        <div className="rounded-md border border-border/50 bg-accent/10 p-3 text-xs text-muted-foreground space-y-1.5" data-testid="howto-panel">
          <p><b className="text-foreground">數字點嚟:</b>零售廣告數字按 campaign 分類逐日加總;分類唔啱可以喺下面活動表撳「業務」chip 反轉。查詢按同事分隊 + channel 過濾,認唔到業務嘅唔計。</p>
          <p><b className="text-foreground">睇邊個指標:</b>你 97% 生意喺門市 POS,廣告睇完入舖買嘅人網上追蹤唔到 — 所以主指標係<b className="text-foreground">「查詢量」同「每查詢成本」</b>(客人問完先買,呢個先追蹤到廣告嘅實際功效)。</p>
          <p><b className="text-foreground">ROAS 要小心:</b>係 Meta pixel 報嘅購買數 × 平均單價 ÷ 廣告費估出嚟,<b className="text-foreground">只反映網店</b>,唔包門市成交,亦唔係真收銀數 — 當參考,唔好當實數。</p>
          <p><b className="text-foreground">廣告佔比:</b>廣告費 ÷ 總銷售。而家極低(1% 以下),即係生意主要唔係靠廣告推動 — 加大廣告前先睇「每查詢成本」頂唔頂得順。</p>
        </div>
      )}

      {/* ── 🚦 廣告健康警號 ── */}
      {!loading && (
        <div data-testid="ad-health">
          {adHealth.alerts.length === 0 ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-300 flex items-center gap-2">
              ✅ 廣告健康:冇燒費零轉化嘅活動,每查詢成本同 CTR 都穩定
            </div>
          ) : (
            <div className="space-y-2">
              {adHealth.alerts.map((a, i) => (
                <div
                  key={i}
                  className={`rounded-md border p-3 ${a.level === 'red' ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}
                >
                  <div className={`text-sm font-semibold ${a.level === 'red' ? 'text-red-300' : 'text-amber-300'}`}>
                    {a.level === 'red' ? '🔴' : '🟡'} {a.title}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{a.detail}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ 💬 客服查詢 SleekFlow — 主指標 ═══ */}
      <h2 className="text-sm font-semibold pt-2" data-testid="section-inquiries">
        💬 客服查詢 <span className="text-xs font-normal text-primary">⭐ 廣告主指標</span>
        <span className="text-xs font-normal text-muted-foreground ml-2">SleekFlow · 客人問完先買,呢個先追蹤到廣告功效</span>
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
          <button
            onClick={() =>
              setInquiryDetail({
                title: '經廣告入口嘅查詢',
                count: inquiryStats.adConvs,
                msgs: inquiryStats.adMsgs,
                subtitle: `${inquiryStats.adConvs} 單對話 · 由 Meta 廣告(CTWA)撳入嚟 · 新至舊`,
              })
            }
            disabled={inquiryStats.adConvs === 0}
            title={inquiryStats.adConvs > 0 ? '撳嚟睇邊幾單係經廣告入嚟' : '呢個期間未有經廣告入口嘅查詢'}
            data-testid="chip-ad-entry"
            className="px-2 py-0.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 tabular-nums transition-colors enabled:hover:border-sky-400 enabled:cursor-pointer disabled:opacity-60"
          >
            經廣告 {inquiryStats.adConvs}
            {inquiryStats.adConvs > 0 && <MessageCircle className="inline h-3 w-3 ml-1.5 -mt-0.5" />}
          </button>
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

      <ChartCard title="每日 總銷售 vs 廣告費 vs 客服查詢" subtitle="Daily Total Sales vs Ad Spend vs Inquiries" note="* 總銷售 = 同一個 Shopify 戶口拆開兩條數:門市 POS(source_name=pos,約佔 95%)+ 線上(網店同其他銷售渠道)。查詢 = SleekFlow 每日 distinct 對話數(已按業務過濾)。廣告主要打線上,但客人好多時睇完廣告返門市買,所以廣告效果要睇「廣告成本佔比」呢個整體指標;上方「線上 ROAS」只計網店訂單,相對可歸因。兩者都唔係逐單歸因。">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={salesVsSpend}>
            <CartesianGrid {...GRID_STYLE} /><XAxis dataKey="date" tick={AXIS_STYLE} />
            <YAxis yAxisId="left" tick={AXIS_STYLE} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_STYLE} tickFormatter={(v) => `$${v.toFixed(0)}`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, n: string) => n === 'Ad Spend' ? [`HK$${v.toFixed(0)}`, n] : n === '查詢 Inquiries' ? [formatNumber(v), n] : [formatCurrency(v), n]} />
            <Area yAxisId="left" type="monotone" dataKey="retail" stackId="sales" name="門市 POS" stroke={CHART_COLORS.tertiary} fill={CHART_COLORS.tertiary} fillOpacity={0.25} strokeWidth={1.5} />
            <Area yAxisId="left" type="monotone" dataKey="online" stackId="sales" name="線上 Online" stroke={CHART_COLORS.primary} fill={CHART_COLORS.primary} fillOpacity={0.25} strokeWidth={1.5} />
            <Line yAxisId="right" type="monotone" dataKey="spend" name="Ad Spend" stroke={CHART_COLORS.fifth} strokeWidth={2} dot={false} />
            <Line yAxisId="right" type="monotone" dataKey="inquiries" name="查詢 Inquiries" stroke={CHART_COLORS.secondary} strokeWidth={2} strokeDasharray="4 2" dot={false} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

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

      {/* ── ② 廣告表現(次要:睇健康,唔係睇成效)── */}
      <h2 className="text-sm font-semibold pt-2" data-testid="section-ad-perf">
        📣 廣告表現 <span className="text-xs font-normal text-muted-foreground">Meta Ads · 睇投放健康</span>
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title={retailOnly ? 'Meta 支出（零售）' : 'Meta 支出'} subtitle="Spend" value={formatCurrency(totalSpend)} icon={DollarSign} loading={loading} testId="kpi-spend" />
        <KpiCard title="曝光量" subtitle="Impressions" value={formatNumber(totalImpressions)} icon={Eye} loading={loading} testId="kpi-imp" />
        <KpiCard title="點擊" subtitle="Clicks" value={formatNumber(totalClicks)} icon={MousePointer} loading={loading} testId="kpi-clicks" />
        <KpiCard title="CPC" subtitle="Avg" value={`HK$${avgCPC.toFixed(2)}`} icon={BarChart3} loading={loading} testId="kpi-cpc" />
        <KpiCard title="CTR" subtitle="Rate" value={formatPercent(avgCTR)} icon={Percent} loading={loading} testId="kpi-ctr" />
        <KpiCard title="線上 ROAS ⚠" subtitle="只算網店 · 估算" value={roas > 100 ? `>​99x` : `${roas.toFixed(1)}x`} icon={TrendingUp} loading={loading} testId="kpi-roas" />
      </div>

      {/* ═══ 💰 廣告 ↔ 銷售掛勾 Ad ↔ Sales ═══ */}
      <h2 className="text-sm font-semibold pt-2" data-testid="section-ad-sales">
        💰 廣告 ↔ 銷售掛勾 <span className="text-xs font-normal text-muted-foreground">Ad ↔ Sales</span>
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="總銷售" subtitle="Total Sales" value={formatCurrency(totalSales)} icon={DollarSign} loading={loading} testId="kpi-total-sales" />
        <KpiCard title="門市 POS" subtitle="Shopify POS" value={formatCurrency(totalPosRev)} icon={Store} loading={loading} testId="kpi-retail-sales" />
        <KpiCard title="線上" subtitle="網店 + 其他銷售渠道" value={formatCurrency(totalOnlineRev)} icon={Globe} loading={loading} testId="kpi-online-sales" />
        <KpiCard title="廣告費" subtitle="Ad Spend" value={formatCurrency(totalSpend)} icon={DollarSign} loading={loading} testId="kpi-ad-spend" />
        <KpiCard title="廣告成本佔比" subtitle="Spend/Sales" value={formatPercent(adCostPct)} icon={Percent} loading={loading} testId="kpi-ad-cost-pct" />
        <KpiCard title="Blended CAC" subtitle="廣告費/新會員" value={blendedCAC > 0 ? formatCurrency(blendedCAC) : '—'} icon={Target} loading={loading} testId="kpi-blended-cac" />
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
                      <th className="text-left px-3 py-2.5 font-medium text-muted-foreground whitespace-nowrap">投放期 Run dates</th>
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
                    {paginatedCampaigns.map((c, i) => {
                      const live = isLive(c);
                      const showHeader = i === 0 || isLive(paginatedCampaigns[i - 1]) !== live;
                      return (
                      <Fragment key={c.campaign_id || i}>
                      {showHeader && (
                        <tr className="bg-muted/40">
                          <td colSpan={13} className="px-3 py-1.5 text-[11px] font-semibold">
                            {live ? (
                              <span className="text-green-400">
                                ● 仲投緊 · 最近 7 日有實際花費（{filteredCampaigns.filter(isLive).length}）
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                ○ 已停投放 · 7 日內冇再俾錢（{filteredCampaigns.filter((x) => !isLive(x)).length}）—— 部分狀態仍係 ACTIVE，只係投放期完咗未關
                              </span>
                            )}
                          </td>
                        </tr>
                      )}
                      <tr
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
                        <td className="px-3 py-2 tabular-nums whitespace-nowrap text-muted-foreground">
                          {shortDate(c.start_time)} – {shortDate(c.stop_time) || '未設'}
                          {recentSpend[String(c.campaign_id)]?.last && (
                            <span className="block text-[10px] opacity-70">
                              最後花費 {shortDate(recentSpend[String(c.campaign_id)].last)}
                            </span>
                          )}
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
                      </Fragment>
                      );
                    })}
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

      {/* ── 明細區(放最底):每日貢獻表 + CTR / CPM / CPC 趨勢 ── */}
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
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">門市 POS</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">線上 Online</th>
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
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalPosRev)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalOnlineRev)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totalSales)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{totalSpend > 0 ? formatPercent(adCostPct) : '—'}</td>
                    </tr>
                    {dailyRows.map((r) => (
                      <tr key={r.date} className="border-b border-border/20 hover:bg-muted/20" data-testid={`daily-row-${r.date}`}>
                        <td className="px-3 py-2 tabular-nums">{r.date}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.spend > 0 ? formatCurrency(r.spend) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.inquiries > 0 ? formatNumber(r.inquiries) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.retail)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.online)}</td>
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
          subtitle={inquiryDetail.subtitle}
          onClose={() => setInquiryDetail(null)}
        />
      )}
    </div>
  );
}

/* ── SleekFlow 對話彈窗 — 客人訊息用聊天 bubble 排版,新至舊 ── */
function InquiryChatModal({ title, count, msgs, subtitle, onClose }: { title: string; count: number; msgs: InqMsg[]; subtitle?: string; onClose: () => void }) {
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
              {subtitle ?? `${count} 單對話 · 顯示 ${msgs.length} 條認到商品嘅訊息 · 新至舊`}
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
