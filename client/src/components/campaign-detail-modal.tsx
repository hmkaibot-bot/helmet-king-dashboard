import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { formatNumber } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE } from '@/lib/chart-theme';
import { MessageCircle, X } from 'lucide-react';
import { LineChart, Line, ComposedChart, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';

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

export function CampaignDetailModal({ campaign, onClose }: { campaign: any; onClose: () => void }) {
  // 智能預設時段:campaign 完咗幾耐就開邊個 preset — 免得撳開見到全零
  // (例:5 月尾完嘅 campaign 預設「30日」會全零,應該直接開「90日/全期」)
  const [preset, setPreset] = useState(() => {
    const stop = campaign?.stop_time ? new Date(campaign.stop_time).getTime() : NaN;
    if (!Number.isFinite(stop)) return 'last_30d'; // 冇完結時間(通常仲行緊)
    const daysAgo = (Date.now() - stop) / 86400000;
    if (daysAgo <= 25) return 'last_30d';
    if (daysAgo <= 85) return 'last_90d';
    return 'maximum';
  });
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
