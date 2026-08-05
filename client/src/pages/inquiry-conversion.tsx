import { useEffect, useMemo, useRef, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryAll, queryAllPages } from '@/lib/query-helpers';
import { todayISO } from '@/lib/promotions-shared';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { Card, CardContent } from '@/components/ui/card';
import { CampaignDetailModal } from '@/components/campaign-detail-modal';
import { adDepartment, DEPT_LABELS, DEPT_ORDER, type Dept } from '@/lib/business-filter';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { MessageCircle, Users, Target, DollarSign, Store, Megaphone, Sparkles } from 'lucide-react';

/**
 * 查詢與轉換 — SleekFlow 查詢客 ↔ Shopify 購買紀錄 對數(零售)。
 *
 * 數據:inquiry_conversions(每晚 GitHub Actions 對數;電話做 join key)。
 * 轉換定義:首次查詢後 14 日內有購買。查詢前 60 日內有單 = 售後查詢。
 * 日期範圍用右上角全站選擇器(撳日歷 icon 即自訂)— 查詢按「首次查詢日」過濾,
 * post 牆就直接攞該範圍嘅 Meta time_range 數據(唔再用 preset 近似)。
 * post 牆全部門都攞,用 chips 分開睇(零售/車房/賣車/旅行團/租車/尻片/通告/工作坊/其他)。
 */

interface ConvRow {
  contact_phone: string;
  first_inquiry: string;
  last_inquiry: string;
  conversations: number;
  inquired_brands: string | null;
  inquired_product_ids: string | null;
  via_ad: boolean;
  customer_id: number | null;
  customer_name: string | null;
  lifetime_orders: number | null;
  lifetime_spent: number | null;
  prior_order_at: string | null;
  first_order_after: string | null;
  days_to_purchase: number | null;
  bought_matched_brand: boolean | null;
  after_spend_14d: number;
  after_orders_14d: number;
  after_pos_orders_14d: number;
  classification: string;
  synced_at: string;
}

interface WallAd {
  adId: string;
  name: string;
  campaignId: string;
  status: string;
  image: string | null;
  copy: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  inquiries: number;
  start: string | null; // 投放開始(adset 排程,冇就廣告建立日)
  end: string | null;   // 投放結束;null = 冇設結束日
  adCount: number;      // 同一個 post 合併咗幾多個 ad(server 端 dedup)
  parts: WallAdPart[];  // 每個 ad 自己嘅一行(類型/投放期/數字分開睇)
  postKey: string;      // 連結推廣活動用嘅穩定 key(server 生成)
  dept: Dept; // client 端按 campaign 名+廣告名分部門
}

// 推廣活動(連結 post 用嘅精簡版)
interface PromoLite {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface PromoSalesRow {
  qty: number;
  rev: number;
  liftPct: number | null; // 對比投放前同長度時段 ±%;prevZero 時為 null
  prevZero: boolean;
}

/**
 * post ↔ 推廣活動 自動建議:活動名切做兩字一格,睇 post 名+文案命中幾多格,
 * 而且投放期要同活動期有重疊。命中 ≥2 格先算似。
 */
function suggestPromo(ad: WallAd, promos: PromoLite[]): PromoLite | null {
  const text = `${ad.name} ${ad.copy}`;
  const adStart = ad.start ?? '';
  const adEnd = ad.end ?? '9999-12-31';
  let best: PromoLite | null = null;
  let bestScore = 0;
  for (const p of promos) {
    if (p.status === 'cancelled') continue;
    if (adStart && (p.end_date < adStart || p.start_date > adEnd)) continue;
    const clean = p.name.replace(/推廣|活動|\s+/g, '');
    let hits = 0;
    const seen = new Set<string>();
    for (let i = 0; i + 2 <= clean.length; i++) {
      const bg = clean.slice(i, i + 2);
      if (seen.has(bg)) continue;
      seen.add(bg);
      if (text.includes(bg)) hits++;
    }
    if (hits > bestScore) {
      bestScore = hits;
      best = p;
    }
  }
  return bestScore >= 2 ? best : null;
}

interface WallAdPart {
  goal: string;
  name: string;
  status: string;
  start: string | null;
  end: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  inquiries: number;
}

// Meta adset optimization_goal → 中文類型
const GOAL_LABELS: Record<string, string> = {
  POST_ENGAGEMENT: '互動',
  CONVERSATIONS: '對話',
  LANDING_PAGE_VIEWS: '流量',
  LINK_CLICKS: '流量',
  REACH: '觸及',
  IMPRESSIONS: '曝光',
  THRUPLAY: '影片',
  OFFSITE_CONVERSIONS: '轉換',
  CONVERSIONS: '轉換',
  LEAD_GENERATION: '名單',
  PAGE_LIKES: '讚好',
};

/** ad 類型:Meta 實際投放目標優先,冇就靠團隊改名嘅字頭估 */
function goalLabel(p: { goal: string; name: string }): string {
  if (GOAL_LABELS[p.goal]) return GOAL_LABELS[p.goal];
  const n = p.name.toLowerCase();
  if (n.startsWith('engagement')) return '互動';
  if (n.startsWith('traffic')) return '流量';
  if (n.startsWith('message')) return '對話';
  return '推廣';
}

/** 團隊改名嘅字頭(Engagement_/Traffic_…)— 老闆要保留嚟分返邊個 ad 打邊個 */
function adTag(name: string): string {
  const m = /^([A-Za-z]{2,})_/.exec(name.trim());
  return m ? m[1].toUpperCase() : '';
}

/** '2026-07-03' → '7月3日'(唔係今年先加年份) */
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const yy = y === new Date().getFullYear() ? '' : `${String(y).slice(2)}年`;
  return `${yy}${m}月${d}日`;
}

// 部門 badge/chip 顏色
const DEPT_CLS: Record<Dept, string> = {
  retail: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  garage: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  bikesale: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  tour: 'text-violet-300 border-violet-500/40 bg-violet-500/10',
  rental: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10',
  video: 'text-pink-300 border-pink-500/40 bg-pink-500/10',
  notice: 'text-slate-300 border-slate-500/40 bg-slate-500/10',
  workshop: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
  other: 'text-muted-foreground border-border bg-card',
};

const CLASS_LABELS: Record<string, { label: string; cls: string }> = {
  converted: { label: '✅ 已轉化', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  aftersales: { label: '🛠 售後查詢', cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
  pending: { label: '⏳ 窗口內', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  no_purchase: { label: '未購買', cls: 'text-muted-foreground border-border bg-card' },
  unmatched: { label: '對唔到客', cls: 'text-muted-foreground border-border bg-card' },
};

const tail = (p: string) => `…${p.slice(-4)}`;

export default function InquiryConversionPage() {
  const { bounds } = useDateRange();
  const [rows, setRows] = useState<ConvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  // 廣告 post 牆
  const [wall, setWall] = useState<{ loading: boolean; error: string | null; ads: WallAd[] }>({
    loading: true, error: null, ads: [],
  });
  const [deptFilter, setDeptFilter] = useState<'all' | Dept>('retail');
  const [campaignById, setCampaignById] = useState<Record<string, any>>({});
  const [detailCampaign, setDetailCampaign] = useState<any | null>(null);
  // 案例/明細行 drill-down(睇購買紀錄+對話)
  const [caseRow, setCaseRow] = useState<ConvRow | null>(null);
  // post 圖 lightbox(頁內彈大圖,唔開新分頁)
  const [lightbox, setLightbox] = useState<string | null>(null);

  // post ↔ 推廣活動 連結 + 關聯銷售(右下角)
  const [promos, setPromos] = useState<PromoLite[]>([]);
  const [promoItems, setPromoItems] = useState<Array<{ promotion_id: string; product_id: number | string; is_archived: boolean }>>([]);
  const [links, setLinks] = useState<Record<string, string>>({}); // postKey → promotion id
  const [dismissedSug, setDismissedSug] = useState<Set<string>>(new Set());
  const [promoSales, setPromoSales] = useState<Record<string, PromoSalesRow>>({});
  const [salesLoading, setSalesLoading] = useState(false);
  const bigTablesRef = useRef<{ inv: any[]; orders: any[]; lines: any[] } | null>(null);

  useEffect(() => {
    (async () => {
      const [{ data: ps }, { data: ls }] = await Promise.all([
        supabase.from('promotions').select('id,name,start_date,end_date,status'),
        supabase.from('post_promotion_links').select('post_key,promotion_id'),
      ]);
      setPromos(((ps as any[]) ?? []).map(p => ({ ...p, id: String(p.id) })));
      const m: Record<string, string> = {};
      for (const l of (ls as any[]) ?? []) m[String(l.post_key)] = String(l.promotion_id);
      setLinks(m);
      const items = await queryAllPages('promotion_items', 'promotion_id,product_id,is_archived');
      setPromoItems(items as any[]);
    })().catch(e => console.error('promo link load error:', e));
  }, []);

  const suggestions = useMemo(() => {
    const out: Record<string, PromoLite> = {};
    for (const a of wall.ads) {
      if (!a.postKey || links[a.postKey] || dismissedSug.has(a.postKey)) continue;
      const s = suggestPromo(a, promos);
      if (s) out[a.postKey] = s;
    }
    return out;
  }, [wall.ads, promos, links, dismissedSug]);

  const linkPromo = async (postKey: string, promotionId: string) => {
    setLinks(m => ({ ...m, [postKey]: promotionId }));
    const { error } = await supabase
      .from('post_promotion_links')
      .upsert({ post_key: postKey, promotion_id: promotionId }, { onConflict: 'post_key' });
    if (error) {
      alert(`連結失敗:${error.message}`);
      setLinks(m => { const n = { ...m }; delete n[postKey]; return n; });
    }
  };
  const unlinkPromo = async (postKey: string) => {
    setLinks(m => { const n = { ...m }; delete n[postKey]; return n; });
    await supabase.from('post_promotion_links').delete().eq('post_key', postKey);
  };

  // 關聯銷售:活動貨品(SKU 對應)喺投放期內嘅件數+金額,對比投放前同長度時段。
  // 計法同 promo-snapshot 一致:cancelled 單唔計,營收 = qty × line.price,POS+網店都計。
  useEffect(() => {
    const linked = wall.ads.filter(a => a.postKey && links[a.postKey]);
    if (linked.length === 0 || promoItems.length === 0) { setPromoSales({}); return; }
    let cancelled = false;
    (async () => {
      setSalesLoading(true);
      try {
        if (!bigTablesRef.current) {
          const [inv, orders, lines] = await Promise.all([
            queryAllPages('shopify_inventory', 'sku,product_id'),
            queryAllPages('shopify_orders', 'id,created_at,cancelled_at'),
            queryAllPages('shopify_order_lines', 'sku,quantity,price,order_id'),
          ]);
          bigTablesRef.current = { inv: inv as any[], orders: orders as any[], lines: lines as any[] };
        }
        if (cancelled) return;
        const { inv, orders, lines } = bigTablesRef.current;
        const okOrder = new Map<string, number>(); // order id → created_at ms(cancelled 剔走)
        for (const o of orders) if (!o.cancelled_at) okOrder.set(String(o.id), new Date(o.created_at).getTime());
        const skusByProduct = new Map<string, string[]>();
        for (const r of inv) {
          if (r.product_id == null || !r.sku) continue;
          const k = String(r.product_id);
          const arr = skusByProduct.get(k) ?? [];
          arr.push(String(r.sku));
          skusByProduct.set(k, arr);
        }

        const out: Record<string, PromoSalesRow> = {};
        for (const a of linked) {
          const pid = links[a.postKey];
          // 唔剔 is_archived:活動完結/還原價後 items 會俾 archive,但歷史銷售照計佢哋
          const prodIds = new Set(
            promoItems.filter(it => String(it.promotion_id) === pid).map(it => String(it.product_id))
          );
          const skuSet = new Set<string>();
          for (const pd of prodIds) for (const s of skusByProduct.get(pd) ?? []) skuSet.add(s);

          const startISO = a.start ?? todayISO();
          const endISO = a.end && a.end <= todayISO() ? a.end : todayISO();
          const start = new Date(startISO + 'T00:00:00').getTime();
          const end = new Date(endISO + 'T23:59:59').getTime();
          const winMs = Math.max(86_400_000, end - start + 1000);
          const preEnd = start - 1;
          const preStart = start - winMs;

          let qty = 0, rev = 0, preQty = 0;
          for (const line of lines) {
            if (!line.sku || !skuSet.has(String(line.sku))) continue;
            const t = okOrder.get(String(line.order_id));
            if (t == null) continue;
            const q = Number(line.quantity ?? 0);
            if (t >= start && t <= end) { qty += q; rev += q * Number(line.price ?? 0); }
            else if (t >= preStart && t <= preEnd) preQty += q;
          }
          out[a.postKey] = preQty === 0
            ? { qty, rev, liftPct: null, prevZero: true }
            : { qty, rev, liftPct: Math.round(((qty - preQty) / preQty) * 100), prevZero: false };
        }
        if (!cancelled) setPromoSales(out);
      } catch (e) {
        console.error('promo sales calc error:', e);
      } finally {
        if (!cancelled) setSalesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [wall.ads, links, promoItems]);

  useEffect(() => {
    if (!lightbox) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [lightbox]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await queryAll('inquiry_conversions', '*');
        if (cancelled) return;
        setRows(data as ConvRow[]);
        const latest = (data as ConvRow[]).map(r => r.synced_at).sort().pop() ?? null;
        setSyncedAt(latest);
      } catch (e) { console.error('inquiry_conversions error:', e); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // post 牆:精確跟日期範圍攞 Meta 數據,再按 campaign 名+廣告名分部門。
  // debounce 500ms — 老闆用日歷揀緊日期嗰陣唔好連環問 Meta(帳戶有 rate limit)。
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setWall(w => ({ ...w, loading: true, error: null }));
      try {
        const { data: camps } = await supabase.from('meta_campaigns').select('*').limit(2000);
        if (cancelled) return;
        const byId: Record<string, any> = {};
        for (const c of camps || []) byId[String(c.campaign_id)] = c;
        setCampaignById(byId);

        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error('未登入');
        const resp = await fetch('/api/meta-post-wall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ since: bounds.from, until: bounds.to }),
        });
        const j: any = await resp.json().catch(() => null);
        if (cancelled) return;
        if (!resp.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${resp.status}（未 deploy 前呢部分見唔到)`);
        const ads = (j.ads as WallAd[]).map(a => {
          const c = byId[a.campaignId];
          return { ...a, dept: adDepartment(`${c?.campaign_name ?? ''} ${a.name}`, c?.business) };
        });
        setWall({ loading: false, error: null, ads });
      } catch (e) {
        if (!cancelled) setWall({ loading: false, error: e instanceof Error ? e.message : String(e), ads: [] });
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [bounds]);

  const deptCounts = useMemo(() => {
    const m = {} as Record<Dept, number>;
    for (const a of wall.ads) m[a.dept] = (m[a.dept] ?? 0) + 1;
    return m;
  }, [wall.ads]);
  const shownAds = useMemo(
    () => (deptFilter === 'all' ? wall.ads : wall.ads.filter(a => a.dept === deptFilter)),
    [wall.ads, deptFilter]
  );

  // ── 按日期範圍(首次查詢日)過濾 ─────────────────────────────────────────
  const inRange = useMemo(
    () => rows.filter(r => r.first_inquiry >= bounds.from && r.first_inquiry <= bounds.to),
    [rows, bounds]
  );

  const stats = useMemo(() => {
    const total = inRange.length;
    const matched = inRange.filter(r => r.customer_id != null);
    const converted = inRange.filter(r => r.classification === 'converted');
    const aftersales = inRange.filter(r => r.classification === 'aftersales');
    const pending = inRange.filter(r => r.classification === 'pending');
    const viaAd = inRange.filter(r => r.via_ad);
    const convSpend = converted.reduce((s, r) => s + Number(r.after_spend_14d || 0), 0);
    const storeVisits = inRange.filter(r => Number(r.after_pos_orders_14d) > 0).length;
    const boughtMatched = converted.filter(r => r.bought_matched_brand).length;
    // 轉化率分母:剔走仲喺窗口內嗰批(佢哋未有機會轉化)
    const denom = total - pending.length;
    return { total, matched, converted, aftersales, pending, viaAd, convSpend, storeVisits, boughtMatched, denom };
  }, [inRange]);

  // ── 有趣案例(規則自動生成)────────────────────────────────────────────
  const cases = useMemo(() => {
    const out: { icon: string; title: string; body: string; tone: string; row: ConvRow }[] = [];
    for (const r of inRange) {
      const who = r.customer_name ? `${r.customer_name}(${tail(r.contact_phone)})` : tail(r.contact_phone);
      if (r.classification === 'converted' && r.bought_matched_brand) {
        out.push({
          icon: '🎯', tone: 'border-emerald-700/40 bg-emerald-950/20', row: r,
          title: '問完就買埋嗰件',
          body: `${who} ${r.first_inquiry} 查詢 ${r.inquired_brands || '商品'},${r.days_to_purchase} 日後購買,14 日內消費 ${formatCurrency(Number(r.after_spend_14d))}。`,
        });
      } else if (r.classification === 'converted' && r.days_to_purchase === 0 && Number(r.after_pos_orders_14d) > 0) {
        out.push({
          icon: '🏃', tone: 'border-emerald-700/40 bg-emerald-950/20', row: r,
          title: '查詢即日到店購買',
          body: `${who} ${r.first_inquiry} WhatsApp 查詢,同日喺門市消費 ${formatCurrency(Number(r.after_spend_14d))}。`,
        });
      } else if (r.classification === 'converted') {
        out.push({
          icon: '✅', tone: 'border-emerald-700/40 bg-emerald-950/20', row: r,
          title: `查詢後 ${r.days_to_purchase} 日內購買`,
          body: `${who} ${r.first_inquiry} 查詢${r.inquired_brands ? ` ${r.inquired_brands}` : ''},之後消費 ${formatCurrency(Number(r.after_spend_14d))}${Number(r.after_pos_orders_14d) > 0 ? '(有到店)' : ''}。`,
        });
      } else if (r.classification === 'aftersales' && Number(r.lifetime_spent) >= 10000) {
        out.push({
          icon: '👑', tone: 'border-sky-700/40 bg-sky-950/20', row: r,
          title: 'VIP 售後查詢',
          body: `${who} 累計消費 ${formatCurrency(Number(r.lifetime_spent))}(${r.lifetime_orders} 單),${r.first_inquiry} 有跟進查詢 — 服務質素直接影響回購。`,
        });
      } else if (r.via_ad && r.customer_id != null) {
        out.push({
          icon: '📣', tone: 'border-purple-700/40 bg-purple-950/20', row: r,
          title: '廣告 re-touch 舊客',
          body: `${who} 係現有客人(累計 ${formatCurrency(Number(r.lifetime_spent || 0))}),${r.first_inquiry} 經 Meta 廣告撳入嚟查詢。`,
        });
      } else if (r.via_ad) {
        out.push({
          icon: '📣', tone: 'border-purple-700/40 bg-purple-950/20', row: r,
          title: '經廣告新查詢',
          body: `${tail(r.contact_phone)} ${r.first_inquiry} 經 Meta 廣告(CTWA)入嚟查詢,暫未有購買紀錄。`,
        });
      }
    }
    return out.slice(0, 12);
  }, [inRange]);

  const sorted = useMemo(
    () => [...inRange].sort((a, b) => b.first_inquiry.localeCompare(a.first_inquiry)),
    [inRange]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold" data-testid="section-inquiry-conversion">
          💬→🛒 查詢與轉換 <span className="text-xs font-normal text-muted-foreground">Inquiries & Conversion(零售)</span>
        </h2>
        <span className="text-[11px] text-muted-foreground">
          轉換窗 14 日 · 電話對數(IG/FB 查詢冇電話追唔到)· 每晚自動更新
          {syncedAt ? ` · 上次對數 ${new Date(syncedAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}` : ''}
        </span>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="查詢客" subtitle="有電話可追蹤" value={formatNumber(stats.total)} icon={MessageCircle} loading={loading} testId="kpi-conv-total" />
        <KpiCard title="對到 Shopify 客" subtitle={stats.total > 0 ? formatPercent((stats.matched.length / stats.total) * 100) : '—'} value={formatNumber(stats.matched.length)} icon={Users} loading={loading} testId="kpi-conv-matched" />
        <KpiCard title="14 日內轉化" subtitle={stats.denom > 0 ? `轉化率 ${formatPercent((stats.converted.length / stats.denom) * 100)}` : '未夠數計'} value={formatNumber(stats.converted.length)} icon={Target} loading={loading} testId="kpi-conv-converted" />
        <KpiCard title="轉化消費" subtitle="14 日內" value={formatCurrency(stats.convSpend)} icon={DollarSign} loading={loading} testId="kpi-conv-spend" />
        <KpiCard title="查詢後到店" subtitle="有門市 POS 單" value={formatNumber(stats.storeVisits)} icon={Store} loading={loading} testId="kpi-conv-store" />
        <KpiCard title="經廣告查詢" subtitle="CTWA 標記" value={formatNumber(stats.viaAd.length)} icon={Megaphone} loading={loading} testId="kpi-conv-ad" />
      </div>

      {/* 漏斗 + 分類拆解 */}
      {!loading && stats.total > 0 && (
        <Card className="border-border/40">
          <CardContent className="p-4 space-y-2">
            {([
              { label: '查詢客(有電話)', n: stats.total, cls: 'bg-primary/60' },
              { label: '對到 Shopify 客', n: stats.matched.length, cls: 'bg-sky-500/60' },
              { label: '售後查詢(查詢前 60 日內已買)', n: stats.aftersales.length, cls: 'bg-sky-500/40' },
              { label: '14 日內轉化', n: stats.converted.length, cls: 'bg-emerald-500/70' },
              { label: '仲喺 14 日窗口內(未計轉化率)', n: stats.pending.length, cls: 'bg-amber-500/50' },
            ] as const).map(b => (
              <div key={b.label} className="flex items-center gap-2 text-xs">
                <span className="w-64 shrink-0 text-muted-foreground">{b.label}</span>
                <div className="flex-1 h-4 rounded bg-muted/30 overflow-hidden">
                  <div className={`h-full rounded ${b.cls}`} style={{ width: `${(b.n / stats.total) * 100}%` }} />
                </div>
                <span className="w-10 text-right tabular-nums">{b.n}</span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground pt-1">
              轉化 = 首次查詢後 14 日內有購買;「問完就買埋嗰件」{stats.boughtMatched} 個。轉化率分母剔走仲喺窗口內嗰批。
            </p>
          </CardContent>
        </Card>
      )}

      {/* 有趣案例 */}
      {cases.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-amber-300" /> 有趣案例 <span className="font-normal text-muted-foreground">自動由數據抽出</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {cases.map((c, i) => (
              <Card
                key={i}
                className={`border ${c.tone} cursor-pointer hover:brightness-125 transition-all`}
                onClick={() => setCaseRow(c.row)}
                title="撳嚟睇詳情(購買紀錄+對話內容)"
                data-testid={`case-card-${i}`}
              >
                <CardContent className="p-3">
                  <p className="text-xs font-semibold">{c.icon} {c.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{c.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* 廣告 post 牆:左圖+文案,右數據,撳入睇 detail;部門 chips 分開睇 */}
      <div>
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <h3 className="text-xs font-semibold">📣 廣告 Post 一覽 <span className="font-normal text-muted-foreground">左邊係個 post,右邊係數據 · 撳一行睇深度數據</span></h3>
          <div className="flex gap-1 flex-wrap ml-auto">
            <button
              onClick={() => setDeptFilter('all')}
              className={`px-2 py-0.5 rounded-full border text-[11px] transition-colors ${deptFilter === 'all' ? 'border-primary bg-primary/15 text-primary font-semibold' : 'border-border text-muted-foreground hover:text-foreground'}`}
              data-testid="dept-chip-all"
            >
              全部 {wall.ads.length}
            </button>
            {DEPT_ORDER.map(d => (
              <button
                key={d}
                onClick={() => setDeptFilter(d)}
                className={`px-2 py-0.5 rounded-full border text-[11px] transition-colors ${deptFilter === d ? `${DEPT_CLS[d]} font-semibold` : 'border-border text-muted-foreground hover:text-foreground'}`}
                data-testid={`dept-chip-${d}`}
              >
                {DEPT_LABELS[d]} {deptCounts[d] ?? 0}
              </button>
            ))}
          </div>
        </div>
        {wall.loading ? (
          <p className="text-xs text-muted-foreground py-6 text-center animate-pulse">向 Meta 攞緊廣告 post…</p>
        ) : wall.error ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300">{wall.error}</div>
        ) : shownAds.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">
            呢個時段冇{deptFilter === 'all' ? '' : `「${DEPT_LABELS[deptFilter as Dept]}」`}廣告投放
          </p>
        ) : (
          <div className="space-y-2">
            {shownAds.map(a => {
              const camp = campaignById[a.campaignId];
              return (
                <Card
                  key={a.adId}
                  className="border-border/40 hover:border-border cursor-pointer transition-colors"
                  onClick={() => camp && setDetailCampaign(camp)}
                  title={camp ? '撳嚟睇活動深度數據(人數/查詢/每日趨勢/受眾)' : ''}
                  data-testid={`wall-ad-${a.adId}`}
                >
                  <CardContent className="p-4 flex flex-col lg:flex-row gap-5 items-start">
                    {/* 左邊 60%:圖 + 文案 */}
                    <div className="w-full lg:w-[60%] flex gap-4 items-start flex-wrap md:flex-nowrap">
                    {a.image ? (
                      <img
                        src={a.image}
                        alt=""
                        className="w-80 max-w-full h-auto rounded-md shrink-0 border border-border/40 cursor-zoom-in"
                        loading="lazy"
                        title="撳嚟彈大圖"
                        onClick={(e) => { e.stopPropagation(); setLightbox(a.image); }}
                      />
                    ) : (
                      <div className="w-80 h-44 rounded-md bg-muted/40 border border-border/40 shrink-0 flex items-center justify-center text-muted-foreground text-[10px]">冇圖</div>
                    )}
                    <div className="min-w-[16rem] flex-1">
                      <p className="text-sm font-semibold" title={camp?.campaign_name || a.name}>
                        <span className={`inline-block align-middle mr-2 px-1.5 py-0.5 rounded border text-[10px] font-medium ${DEPT_CLS[a.dept]}`}>{DEPT_LABELS[a.dept]}</span>
                        {camp?.campaign_name || a.name}
                        {a.adCount > 1 && (
                          <span className="ml-2 text-[10px] font-normal text-muted-foreground" title="同一個 post boost 咗幾次,數字已加埋一齊">
                            ({a.adCount} 個廣告合併)
                          </span>
                        )}
                      </p>
                      {/* 文案全文 — 唔截字 */}
                      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed whitespace-pre-wrap">{a.copy || '(冇文案 — 可能係 dark post 或動態素材)'}</p>
                    </div>
                    </div>

                    {/* 右邊 40%:數據(每個 ad 兩行,大字)+ 推廣關聯銷售 */}
                    <div className="w-full lg:w-[40%] shrink-0 border-t lg:border-t-0 lg:border-l border-border/30 pt-3 lg:pt-0 lg:pl-5 flex flex-col items-end gap-3">
                    {/* 每個 ad 兩行:①類型+投放期 ②四格大字數據;合併加「合共」 */}
                    {(() => {
                      const parts: WallAdPart[] = a.parts?.length
                        ? a.parts
                        : [{ goal: '', name: a.name, status: a.status, start: a.start, end: a.end, spend: a.spend, impressions: a.impressions, clicks: a.clicks, inquiries: a.inquiries }];
                      const multi = parts.length > 1;
                      const period = (s: string | null, e: string | null, st: string) =>
                        `${s ? fmtDay(s) : '—'}${e ? ` – ${fmtDay(e)}` : st === 'ACTIVE' ? ' 起' : ' 起(已停)'}`;
                      const chip = (p: WallAdPart) => (
                        <span className="inline-block px-1.5 py-px rounded border border-border/60 bg-muted/30 text-xs leading-5 align-middle" title={p.name}>
                          {goalLabel(p)}
                        </span>
                      );
                      const statBox = (label: string, value: string, extra = '') => (
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className={`text-xl font-bold tabular-nums whitespace-nowrap ${extra}`}>{value}</p>
                        </div>
                      );
                      return (
                        <div className="w-full flex flex-col items-end gap-3">
                          {parts.map((p, i) => (
                            <div key={i} className="text-right">
                              <p className="text-sm">
                                {chip(p)}
                                {adTag(p.name) && (
                                  <span className="ml-1.5 text-[10px] tracking-wide text-muted-foreground align-middle">{adTag(p.name)}</span>
                                )}
                                <span className="ml-3 text-lg font-bold tabular-nums whitespace-nowrap align-middle">{period(p.start, p.end, p.status)}</span>
                              </p>
                              <div className="flex gap-6 justify-end mt-1">
                                {statBox('花費', formatCurrency(p.spend))}
                                {statBox('曝光', formatNumber(p.impressions))}
                                {statBox('點擊', formatNumber(p.clicks))}
                                {statBox('查詢', formatNumber(p.inquiries), p.inquiries > 0 ? 'text-emerald-300' : '')}
                              </div>
                            </div>
                          ))}
                          {multi && (
                            <div className="text-right border-t border-border/70 pt-2 w-full">
                              <p className="text-sm">
                                <span className="text-muted-foreground font-semibold align-middle">合共</span>
                                <span className="ml-3 text-lg font-bold tabular-nums whitespace-nowrap align-middle">{period(a.start, a.end, a.status)}</span>
                              </p>
                              <div className="flex gap-6 justify-end mt-1">
                                {statBox('花費', formatCurrency(a.spend))}
                                {statBox('曝光', formatNumber(a.impressions))}
                                {statBox('點擊', formatNumber(a.clicks))}
                                {statBox('查詢', formatNumber(a.inquiries), a.inquiries > 0 ? 'text-emerald-300' : '')}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* 右下角:推廣活動連結 + 關聯銷售(自動建議 → 老闆確認 → 永久記住) */}
                    {a.postKey && (
                      <div
                        className="w-full flex justify-end pt-2 border-t border-border/20"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const pid = links[a.postKey];
                          const linkedPromo = pid ? promos.find(p => p.id === pid) : null;
                          if (linkedPromo) {
                            const s = promoSales[a.postKey];
                            return (
                              <div className="text-right" data-testid={`promo-sales-${a.adId}`}>
                                <p className="text-sm">
                                  📈 推廣「{linkedPromo.name}」投放期賣咗
                                  {s ? (
                                    <>
                                      {' '}
                                      <span className="font-bold tabular-nums">{formatNumber(s.qty)} 件 · {formatCurrency(s.rev)}</span>{' '}
                                      {s.prevZero ? (
                                        <span className="text-xs text-muted-foreground">(投放前同長度時段冇銷售)</span>
                                      ) : (
                                        <span className={`text-xs font-semibold ${(s.liftPct ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                                          (對比前段 {(s.liftPct ?? 0) >= 0 ? '+' : ''}{s.liftPct}%)
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">{salesLoading ? ' 計緊…' : ' —'}</span>
                                  )}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  關聯數:活動貨品喺投放期嘅 POS+網店銷售,唔係廣告直接歸因 ·{' '}
                                  <button className="underline hover:text-foreground" onClick={() => unlinkPromo(a.postKey)}>解除連結</button>
                                </p>
                              </div>
                            );
                          }
                          const sug = suggestions[a.postKey];
                          if (sug) {
                            return (
                              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                似係推廣「<span className="text-foreground font-medium">{sug.name}</span>」?
                                <button
                                  className="px-2 py-0.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                                  onClick={() => linkPromo(a.postKey, sug.id)}
                                  data-testid={`promo-confirm-${a.adId}`}
                                >
                                  ✓ 連結
                                </button>
                                <button
                                  className="px-2 py-0.5 rounded border border-border hover:text-foreground"
                                  onClick={() => setDismissedSug(prev => new Set(prev).add(a.postKey))}
                                >
                                  ✗ 唔係
                                </button>
                              </p>
                            );
                          }
                          return (
                            <select
                              className="text-xs bg-background border border-border rounded px-1.5 py-0.5 text-muted-foreground"
                              value=""
                              onChange={(e) => e.target.value && linkPromo(a.postKey, e.target.value)}
                              data-testid={`promo-select-${a.adId}`}
                            >
                              <option value="">連結推廣活動…</option>
                              {promos.filter(p => p.status !== 'cancelled').map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          );
                        })()}
                      </div>
                    )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* 明細表 */}
      <Card className="border-border/40 overflow-hidden">
        <CardContent className="p-0">
          <div className="px-4 pt-3 pb-2">
            <h3 className="text-sm font-semibold">查詢客明細 <span className="text-xs font-normal text-muted-foreground">按首次查詢日,新至舊</span></h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="conversion-table">
              <thead>
                <tr className="border-b border-border/40 bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">電話</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">首次查詢</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">分類</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">客人</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">查詢品牌</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">首購(查詢後)</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">14日消費</th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground">到店</th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground">經廣告</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">載入中...</td></tr>
                ) : sorted.length === 0 ? (
                  <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">呢個時段冇有電話嘅零售查詢</td></tr>
                ) : (
                  sorted.map(r => {
                    const cl = CLASS_LABELS[r.classification] ?? CLASS_LABELS.unmatched;
                    return (
                      <tr
                        key={r.contact_phone}
                        className="border-b border-border/20 hover:bg-muted/20 cursor-pointer"
                        onClick={() => setCaseRow(r)}
                        title="撳嚟睇詳情(購買紀錄+對話內容)"
                      >
                        <td className="px-3 py-2 tabular-nums">{tail(r.contact_phone)}</td>
                        <td className="px-3 py-2 tabular-nums">{r.first_inquiry}</td>
                        <td className="px-3 py-2"><span className={`px-1.5 py-0.5 rounded text-[10px] border whitespace-nowrap ${cl.cls}`}>{cl.label}</span></td>
                        <td className="px-3 py-2 max-w-[160px] truncate" title={r.customer_name || ''}>{r.customer_name || '—'}</td>
                        <td className="px-3 py-2 max-w-[140px] truncate" title={r.inquired_brands || ''}>{r.inquired_brands || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{r.first_order_after ? `${r.first_order_after}（+${r.days_to_purchase}日）` : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{Number(r.after_spend_14d) > 0 ? formatCurrency(Number(r.after_spend_14d)) : '—'}</td>
                        <td className="px-3 py-2 text-center">{Number(r.after_pos_orders_14d) > 0 ? '🏪' : ''}</td>
                        <td className="px-3 py-2 text-center">{r.via_ad ? '📣' : ''}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {detailCampaign && (
        <CampaignDetailModal campaign={detailCampaign} onClose={() => setDetailCampaign(null)} />
      )}

      {caseRow && <CaseDetailModal row={caseRow} onClose={() => setCaseRow(null)} />}

      {/* post 圖大圖 lightbox — 撳任何地方或 Esc 就閂 */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
          data-testid="image-lightbox"
        >
          <img src={lightbox} alt="" className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}


/* ── 案例 drill-down 彈窗:查詢 timeline + 購買紀錄 + 對話內容 ──────────────
   對話係即時經 /api/sleekflow-messages 問 SleekFlow(唔入庫);
   webhook 合成嘅 conversation id(contact:…)攞唔到,會提示等每晚同步。 */
function CaseDetailModal({ row, onClose }: { row: ConvRow; onClose: () => void }) {
  const [orders, setOrders] = useState<{ loading: boolean; rows: any[] }>({ loading: true, rows: [] });
  const [chat, setChat] = useState<{ loading: boolean; error: string | null; msgs: { at: string; fromShop: boolean; text: string }[] }>({
    loading: true, error: null, msgs: [],
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 購買紀錄(查詢前 60 日 → 而家)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (row.customer_id == null) { setOrders({ loading: false, rows: [] }); return; }
      try {
        const since = new Date(new Date(row.first_inquiry).getTime() - 60 * 86400000).toISOString();
        const { data: os } = await supabase
          .from('shopify_orders')
          .select('id,created_at,total_price,source_name,financial_status,cancelled_at')
          .eq('customer_id', row.customer_id)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(20);
        const valid = (os || []).filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const ids = valid.map((o: any) => o.id);
        let titlesByOrder: Record<string, string[]> = {};
        if (ids.length) {
          const { data: ls } = await supabase
            .from('shopify_order_lines')
            .select('order_id,title')
            .in('order_id', ids)
            .limit(200);
          for (const l of ls || []) {
            (titlesByOrder[String((l as any).order_id)] = titlesByOrder[String((l as any).order_id)] || []).push(String((l as any).title));
          }
        }
        if (cancelled) return;
        setOrders({ loading: false, rows: valid.map((o: any) => ({ ...o, titles: titlesByOrder[String(o.id)] || [] })) });
      } catch { if (!cancelled) setOrders({ loading: false, rows: [] }); }
    })();
    return () => { cancelled = true; };
  }, [row]);

  // 對話內容(即時問 SleekFlow)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: evs } = await supabase
          .from('inquiry_events')
          .select('conversation_id')
          .eq('contact_phone', row.contact_phone)
          .limit(200);
        const convIds = Array.from(new Set((evs || []).map((e: any) => String(e.conversation_id))))
          .filter(id => /^[0-9a-fA-F-]{30,40}$/.test(id))
          .slice(0, 3);
        if (convIds.length === 0) {
          if (!cancelled) setChat({ loading: false, error: '呢個客暫時只有 webhook 即時紀錄 — 對話內容要等每晚 API 同步之後先攞到', msgs: [] });
          return;
        }
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error('未登入');
        const all: { at: string; fromShop: boolean; text: string }[] = [];
        for (const id of convIds) {
          const resp = await fetch('/api/sleekflow-messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ conversationId: id }),
          });
          const j: any = await resp.json().catch(() => null);
          if (resp.ok && j?.ok !== false && Array.isArray(j?.messages)) all.push(...j.messages);
        }
        if (cancelled) return;
        all.sort((a, b) => a.at.localeCompare(b.at));
        setChat({ loading: false, error: all.length === 0 ? '攞唔到對話內容(可能未 deploy 或 SleekFlow 冇呢個對話)' : null, msgs: all });
      } catch (e) {
        if (!cancelled) setChat({ loading: false, error: e instanceof Error ? e.message : String(e), msgs: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [row]);

  const fmtHK = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  };
  const cl = CLASS_LABELS[row.classification] ?? CLASS_LABELS.unmatched;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
        data-testid="case-detail-modal"
      >
        {/* header */}
        <div className="flex items-center gap-3 p-4 border-b border-border/60">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold truncate">
              {row.customer_name || '未對到 Shopify 客'} <span className="text-muted-foreground font-normal">{tail(row.contact_phone)}</span>
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              首次查詢 {row.first_inquiry} · {row.conversations} 單對話
              {row.inquired_brands ? ` · 查詢 ${row.inquired_brands}` : ''}
              {row.via_ad ? ' · 📣 經廣告' : ''}
              {row.lifetime_orders != null ? ` · 累計 ${row.lifetime_orders} 單 ${formatCurrency(Number(row.lifetime_spent || 0))}` : ''}
            </p>
          </div>
          <span className={`px-2 py-1 rounded text-xs border whitespace-nowrap shrink-0 ${cl.cls}`}>{cl.label}</span>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground shrink-0" title="關閉 (Esc)">✕</button>
        </div>

        <div className="overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 左:購買紀錄 */}
          <div>
            <h3 className="text-xs font-semibold mb-2">🛒 購買紀錄 <span className="font-normal text-muted-foreground">查詢前 60 日起,新至舊</span></h3>
            {orders.loading ? (
              <p className="text-xs text-muted-foreground py-6 text-center animate-pulse">載入中…</p>
            ) : orders.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">{row.customer_id == null ? '對唔到 Shopify 客 — 冇購買紀錄可睇' : '呢段時間冇訂單'}</p>
            ) : (
              <div className="space-y-2">
                {orders.rows.map((o: any) => {
                  const day = String(o.created_at).slice(0, 10);
                  const afterInquiry = day >= row.first_inquiry;
                  return (
                    <div key={o.id} className={`rounded-md border p-2.5 ${afterInquiry ? 'border-emerald-700/40 bg-emerald-950/15' : 'border-border/40 bg-muted/20'}`}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="tabular-nums">{day} · {String(o.source_name) === 'pos' ? '🏪 門市' : '🌐 線上'}</span>
                        <span className="font-semibold tabular-nums">{formatCurrency(Number(o.total_price || 0))}</span>
                      </div>
                      {afterInquiry && <p className="text-[10px] text-emerald-300 mt-0.5">查詢後 {Math.round((new Date(day).getTime() - new Date(row.first_inquiry).getTime()) / 86400000)} 日</p>}
                      {o.titles.length > 0 && (
                        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{o.titles.slice(0, 4).join(' · ')}{o.titles.length > 4 ? ` …共 ${o.titles.length} 件` : ''}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 右:對話內容(即時問 SleekFlow,唔入庫) */}
          <div>
            <h3 className="text-xs font-semibold mb-2">💬 對話內容 <span className="font-normal text-muted-foreground">即時由 SleekFlow 攞,唔會儲底</span></h3>
            {chat.loading ? (
              <p className="text-xs text-muted-foreground py-6 text-center animate-pulse">攞緊對話…</p>
            ) : chat.error && chat.msgs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">{chat.error}</p>
            ) : (
              <div className="space-y-2 max-h-[52vh] overflow-y-auto pr-1">
                {chat.msgs.map((m, i) => (
                  <div key={i} className={m.fromShop ? 'flex justify-end' : ''}>
                    <div className={`w-fit max-w-[88%] ${m.fromShop ? 'text-right' : ''}`}>
                      <p className="text-[10px] text-muted-foreground mb-0.5 tabular-nums">{m.fromShop ? '店方 · ' : ''}{fmtHK(m.at)}</p>
                      <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-left ${
                        m.fromShop ? 'bg-primary/15 border border-primary/25 rounded-tr-sm' : 'bg-muted/40 border border-border/30 rounded-tl-sm'
                      }`}>
                        {m.text}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
