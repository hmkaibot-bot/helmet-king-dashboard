import { useEffect, useMemo, useState } from 'react';
import { useDateRange } from '@/lib/date-context';
import { queryAll } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { Card, CardContent } from '@/components/ui/card';
import { CampaignDetailModal } from '@/components/campaign-detail-modal';
import { campaignBusiness } from '@/lib/business-filter';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { MessageCircle, Users, Target, DollarSign, Store, Megaphone, Sparkles } from 'lucide-react';

/**
 * 查詢與轉換 — SleekFlow 查詢客 ↔ Shopify 購買紀錄 對數(零售)。
 *
 * 數據:inquiry_conversions(每晚 GitHub Actions 對數;電話做 join key)。
 * 轉換定義:首次查詢後 14 日內有購買。查詢前 60 日內有單 = 售後查詢。
 * 日期範圍用右上角全站選擇器(有「自訂」)— 按「首次查詢日」過濾。
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
}

const CLASS_LABELS: Record<string, { label: string; cls: string }> = {
  converted: { label: '✅ 已轉化', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  aftersales: { label: '🛠 售後查詢', cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
  pending: { label: '⏳ 窗口內', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  no_purchase: { label: '未購買', cls: 'text-muted-foreground border-border bg-card' },
  unmatched: { label: '對唔到客', cls: 'text-muted-foreground border-border bg-card' },
};

const tail = (p: string) => `…${p.slice(-4)}`;

/** bounds 日數 → post 牆用嘅 Meta date preset */
function presetForBounds(from: string, to: string): string {
  const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  if (days <= 7) return 'last_7d';
  if (days <= 14) return 'last_14d';
  if (days <= 31) return 'last_30d';
  if (days <= 90) return 'last_90d';
  return 'maximum';
}

export default function InquiryConversionPage() {
  const { bounds } = useDateRange();
  const [rows, setRows] = useState<ConvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  // 廣告 post 牆
  const [wall, setWall] = useState<{ loading: boolean; error: string | null; ads: WallAd[] }>({
    loading: true, error: null, ads: [],
  });
  const [campaignById, setCampaignById] = useState<Record<string, any>>({});
  const [detailCampaign, setDetailCampaign] = useState<any | null>(null);

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

  // post 牆:campaign 分類(淨零售)+ 廣告 creative/成效
  useEffect(() => {
    let cancelled = false;
    (async () => {
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
          body: JSON.stringify({ datePreset: presetForBounds(bounds.from, bounds.to) }),
        });
        const j: any = await resp.json().catch(() => null);
        if (cancelled) return;
        if (!resp.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${resp.status}（未 deploy 前呢部分見唔到)`);
        const retailAds = (j.ads as WallAd[]).filter(a => {
          const c = byId[a.campaignId];
          return !c || campaignBusiness(c) === 'retail'; // 搵唔到 campaign 嘅照顯示
        });
        setWall({ loading: false, error: null, ads: retailAds });
      } catch (e) {
        if (!cancelled) setWall({ loading: false, error: e instanceof Error ? e.message : String(e), ads: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [bounds]);

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
    const out: { icon: string; title: string; body: string; tone: string }[] = [];
    for (const r of inRange) {
      const who = r.customer_name ? `${r.customer_name}(${tail(r.contact_phone)})` : tail(r.contact_phone);
      if (r.classification === 'converted' && r.bought_matched_brand) {
        out.push({
          icon: '🎯', tone: 'border-emerald-700/40 bg-emerald-950/20',
          title: '問完就買埋嗰件',
          body: `${who} ${r.first_inquiry} 查詢 ${r.inquired_brands || '商品'},${r.days_to_purchase} 日後購買,14 日內消費 ${formatCurrency(Number(r.after_spend_14d))}。`,
        });
      } else if (r.classification === 'converted' && r.days_to_purchase === 0 && Number(r.after_pos_orders_14d) > 0) {
        out.push({
          icon: '🏃', tone: 'border-emerald-700/40 bg-emerald-950/20',
          title: '查詢即日到店購買',
          body: `${who} ${r.first_inquiry} WhatsApp 查詢,同日喺門市消費 ${formatCurrency(Number(r.after_spend_14d))}。`,
        });
      } else if (r.classification === 'converted') {
        out.push({
          icon: '✅', tone: 'border-emerald-700/40 bg-emerald-950/20',
          title: `查詢後 ${r.days_to_purchase} 日內購買`,
          body: `${who} ${r.first_inquiry} 查詢${r.inquired_brands ? ` ${r.inquired_brands}` : ''},之後消費 ${formatCurrency(Number(r.after_spend_14d))}${Number(r.after_pos_orders_14d) > 0 ? '(有到店)' : ''}。`,
        });
      } else if (r.classification === 'aftersales' && Number(r.lifetime_spent) >= 10000) {
        out.push({
          icon: '👑', tone: 'border-sky-700/40 bg-sky-950/20',
          title: 'VIP 售後查詢',
          body: `${who} 累計消費 ${formatCurrency(Number(r.lifetime_spent))}(${r.lifetime_orders} 單),${r.first_inquiry} 有跟進查詢 — 服務質素直接影響回購。`,
        });
      } else if (r.via_ad && r.customer_id != null) {
        out.push({
          icon: '📣', tone: 'border-purple-700/40 bg-purple-950/20',
          title: '廣告 re-touch 舊客',
          body: `${who} 係現有客人(累計 ${formatCurrency(Number(r.lifetime_spent || 0))}),${r.first_inquiry} 經 Meta 廣告撳入嚟查詢。`,
        });
      } else if (r.via_ad) {
        out.push({
          icon: '📣', tone: 'border-purple-700/40 bg-purple-950/20',
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
              <Card key={i} className={`border ${c.tone}`} data-testid={`case-card-${i}`}>
                <CardContent className="p-3">
                  <p className="text-xs font-semibold">{c.icon} {c.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{c.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* 廣告 post 牆:左圖+文案,右數據,撳入睇 detail */}
      <div>
        <h3 className="text-xs font-semibold mb-2">📣 廣告 Post 一覽 <span className="font-normal text-muted-foreground">左邊係個 post,右邊係數據 · 撳一行睇深度數據</span></h3>
        {wall.loading ? (
          <p className="text-xs text-muted-foreground py-6 text-center animate-pulse">向 Meta 攞緊廣告 post…</p>
        ) : wall.error ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300">{wall.error}</div>
        ) : wall.ads.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">呢個時段冇零售廣告投放</p>
        ) : (
          <div className="space-y-2">
            {wall.ads.map(a => {
              const camp = campaignById[a.campaignId];
              return (
                <Card
                  key={a.adId}
                  className="border-border/40 hover:border-border cursor-pointer transition-colors"
                  onClick={() => camp && setDetailCampaign(camp)}
                  title={camp ? '撳嚟睇活動深度數據(人數/查詢/每日趨勢/受眾)' : ''}
                  data-testid={`wall-ad-${a.adId}`}
                >
                  <CardContent className="p-3 flex gap-3 items-start">
                    {a.image ? (
                      <img src={a.image} alt="" className="w-24 h-24 rounded-md object-cover shrink-0 border border-border/40" loading="lazy" />
                    ) : (
                      <div className="w-24 h-24 rounded-md bg-muted/40 border border-border/40 shrink-0 flex items-center justify-center text-muted-foreground text-[10px]">冇圖</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate" title={camp?.campaign_name || a.name}>{camp?.campaign_name || a.name}</p>
                      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed line-clamp-3 whitespace-pre-wrap">{a.copy || '(冇文案 — 可能係 dark post 或動態素材)'}</p>
                    </div>
                    <div className="shrink-0 grid grid-cols-2 gap-x-4 gap-y-1 text-right">
                      <div><p className="text-[10px] text-muted-foreground">花費</p><p className="text-xs font-semibold tabular-nums">{formatCurrency(a.spend)}</p></div>
                      <div><p className="text-[10px] text-muted-foreground">曝光</p><p className="text-xs font-semibold tabular-nums">{formatNumber(a.impressions)}</p></div>
                      <div><p className="text-[10px] text-muted-foreground">點擊</p><p className="text-xs font-semibold tabular-nums">{formatNumber(a.clicks)}</p></div>
                      <div><p className="text-[10px] text-muted-foreground">查詢</p><p className={`text-xs font-semibold tabular-nums ${a.inquiries > 0 ? 'text-emerald-300' : ''}`}>{formatNumber(a.inquiries)}</p></div>
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
                      <tr key={r.contact_phone} className="border-b border-border/20 hover:bg-muted/20">
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
    </div>
  );
}
