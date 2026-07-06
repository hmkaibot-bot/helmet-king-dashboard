import { supabase } from './supabase';

/**
 * 零售佣金 — 前端 lib。經 /api/retail-commission(ShopifyQL,server 端計)。
 */

export interface CommissionBrand { vendor: string; net: number; agent: boolean; }

export interface CommissionStaff {
  code: string;                 // KENNY / DICKY / ZOE / BEAN
  agentTotal: number;
  agentRate: number;            // 0.01 / 0.015 / 0.02
  agentComm: number;
  nonAgentTotal: number;
  nonAgentComm: number;
  nonAgentTargetHit: boolean;
  items: number;                // 已扣 DRINK/beverages/膠袋
  orders: number;
  avgItems: number;
  avgBonus: number;             // 0 / 700 / 900 / 1100
  targetBonus: number;          // 0 / 1000
  total: number;
  brands: CommissionBrand[];
}

export interface CommissionResult {
  month: string;                // YYYY-MM
  period: { start: string; end: string; isCurrentMonth: boolean };
  store: { total: number; target: number; hit: boolean; bonus: number };
  staff: CommissionStaff[];
  isSnapshot?: boolean;         // true = 由 Supabase 快照嚟(read_reports 未開通)
  computedAt?: string | null;   // 快照計算時間
}

async function fetchLive(month: string): Promise<CommissionResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('未登入 — 請重新登入 dashboard');
  const resp = await fetch('/api/retail-commission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ month }),
  });
  let j: any = null;
  try { j = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) throw new Error(j?.error || `佣金服務回應 ${resp.status}（部署後先可用）`);
  if (j?.ok === false) throw new Error(j.error || '佣金計算失敗');
  return {
    month: j.month,
    period: j.period,
    store: j.store,
    staff: Array.isArray(j.staff) ? j.staff : [],
  };
}

const STAFF_ORDER = ['KENNY', 'DICKY', 'ZOE', 'BEAN'];

/** Fallback:讀 Supabase 快照(ShopifyQL read_reports 未開通時用);冇資料回 null。 */
async function fetchSnapshot(month: string): Promise<CommissionResult | null> {
  const { data, error } = await supabase
    .from('retail_commission_snapshot')
    .select('*')
    .eq('month', month);
  if (error || !data || data.length === 0) return null;
  const rows = data as any[];
  const first = rows[0];
  const staff: CommissionStaff[] = rows
    .map(r => ({
      code: r.code,
      agentTotal: Number(r.agent_total), agentRate: Number(r.agent_rate), agentComm: Number(r.agent_comm),
      nonAgentTotal: Number(r.nonagent_total), nonAgentComm: Number(r.nonagent_comm), nonAgentTargetHit: !!r.nonagent_hit,
      items: Number(r.items), orders: Number(r.orders), avgItems: Number(r.avg_items),
      avgBonus: Number(r.avg_bonus), targetBonus: Number(r.target_bonus), total: Number(r.total),
      brands: [] as CommissionBrand[],
    }))
    .sort((a, b) => STAFF_ORDER.indexOf(a.code) - STAFF_ORDER.indexOf(b.code));
  return {
    month,
    period: { start: `${month}-01`, end: '', isCurrentMonth: false },
    store: { total: Number(first.store_total), target: 1_400_000, hit: !!first.store_hit, bonus: 1000 },
    staff,
    isSnapshot: true,
    computedAt: first.computed_at ?? null,
  };
}

/**
 * 先試 live(ShopifyQL,需 read_reports scope);唔得就 fallback 讀 Supabase 快照。
 * read_reports 開通之後,live 成功就會自動用返即時數(唔再落 fallback)。
 */
export async function fetchRetailCommission(month: string): Promise<CommissionResult> {
  try {
    return await fetchLive(month);
  } catch (liveErr) {
    const snap = await fetchSnapshot(month);
    if (snap) return snap;
    throw liveErr;
  }
}

/** 產生近 N 個月嘅 YYYY-MM 選項(由當月起倒數) */
export function recentMonths(n = 18): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1; // 1-based
  for (let i = 0; i < n; i++) {
    const value = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ value, label: `${y}年${m}月` });
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}
