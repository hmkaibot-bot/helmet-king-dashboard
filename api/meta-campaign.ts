/**
 * Vercel serverless function — 單一 Meta 廣告活動深度數據(營銷分析頁 drill-down 彈窗)。
 *
 * 一個 request 並行拉 4 組 campaign insights:
 *  - summary : 總覽(spend/reach/frequency/曝光/clicks/actions/action_values)
 *  - daily   : 每日趨勢(time_increment=1)
 *  - demo    : 年齡 × 性別分佈(breakdowns=age,gender)
 *  - platform: FB / IG / AN 平台分佈(breakdowns=publisher_platform)
 *
 * 安全: Meta token 留 server-side(Vercel env META_ACCESS_TOKEN,同 GitHub Actions
 * meta-campaigns-sync 用同一條);呼叫者要帶 Supabase 用戶 JWT。
 * campaignId 淨化成純數字先入 URL;datePreset 走 whitelist。
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; RLS 保護) — 唔可以空, 否則 verifyUser 401 "No API key found"
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const META_TOKEN = process.env.META_ACCESS_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v25.0';

export const config = { maxDuration: 60 };

const PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'last_90d', 'maximum']);

async function verifyUser(token: string): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function graphGet(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, access_token: META_TOKEN });
  const r = await fetch(`${GRAPH}/${path}?${qs.toString()}`);
  const j: any = await r.json().catch(() => ({}));
  if (j?.error) {
    throw new Error(`Meta API: ${j.error.message || JSON.stringify(j.error)}`);
  }
  return j?.data ?? [];
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// actions array → { action_type: value } map(數值化)
function actionsMap(actions: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of Array.isArray(actions) ? actions : []) {
    if (a?.action_type) out[String(a.action_type)] = num(a.value);
  }
  return out;
}

// 查詢 = 由廣告開始嘅訊息對話(Messenger/IG DM);冇就 fallback 訊息互動
const MSG_KEYS = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.total_messaging_connection',
];
const PURCHASE_KEYS = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];

const firstOf = (m: Record<string, number>, keys: string[]): number => {
  for (const k of keys) if (m[k] != null) return m[k];
  return 0;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!META_TOKEN)
    return res.status(500).json({
      error: '未設定 META_ACCESS_TOKEN（請喺 Vercel → Settings → Environment Variables 加,同 GitHub secret 同一條 token）',
    });

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const campaignId = String(body?.campaignId ?? '').replace(/\D/g, '');
  if (!campaignId) return res.status(400).json({ error: '冇 campaignId' });
  const preset = PRESETS.has(String(body?.datePreset)) ? String(body.datePreset) : 'last_30d';

  try {
    const base = `${campaignId}/insights`;
    const [summaryRows, dailyRows, demoRows, platformRows] = await Promise.all([
      graphGet(base, {
        date_preset: preset,
        fields: 'spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,actions,action_values',
      }),
      graphGet(base, {
        date_preset: preset,
        time_increment: '1',
        fields: 'date_start,spend,impressions,reach,clicks,actions',
        limit: '200',
      }),
      graphGet(base, {
        date_preset: preset,
        breakdowns: 'age,gender',
        fields: 'reach,spend',
        limit: '100',
      }),
      graphGet(base, {
        date_preset: preset,
        breakdowns: 'publisher_platform',
        fields: 'reach,spend,impressions,clicks,actions',
        limit: '25',
      }),
    ]);

    const s = summaryRows[0] ?? {};
    const sActs = actionsMap(s.actions);
    const sVals = actionsMap(s.action_values);
    const summary = {
      spend: num(s.spend),
      impressions: num(s.impressions),
      reach: num(s.reach),
      frequency: num(s.frequency),
      clicks: num(s.clicks),
      cpc: num(s.cpc),
      cpm: num(s.cpm),
      ctr: num(s.ctr),
      inquiries: firstOf(sActs, MSG_KEYS),
      purchases: firstOf(sActs, PURCHASE_KEYS),
      purchaseValue: firstOf(sVals, PURCHASE_KEYS),
      linkClicks: sActs['link_click'] ?? 0,
      // 完整行動列表俾前端顯示(top N 由前端揀)
      actions: Object.entries(sActs)
        .map(([type, value]) => ({ type, value }))
        .sort((a, b) => b.value - a.value),
    };

    const daily = (dailyRows as any[]).map(d => {
      const m = actionsMap(d.actions);
      return {
        date: d.date_start,
        spend: num(d.spend),
        impressions: num(d.impressions),
        reach: num(d.reach),
        clicks: num(d.clicks),
        inquiries: firstOf(m, MSG_KEYS),
        purchases: firstOf(m, PURCHASE_KEYS),
      };
    });

    const demo = (demoRows as any[]).map(d => ({
      age: String(d.age ?? '?'),
      gender: String(d.gender ?? 'unknown'),
      reach: num(d.reach),
      spend: num(d.spend),
    }));

    const platform = (platformRows as any[]).map(p => {
      const m = actionsMap(p.actions);
      return {
        platform: String(p.publisher_platform ?? '?'),
        reach: num(p.reach),
        spend: num(p.spend),
        impressions: num(p.impressions),
        clicks: num(p.clicks),
        inquiries: firstOf(m, MSG_KEYS),
      };
    });

    return res.status(200).json({ ok: true, preset, summary, daily, demo, platform });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
