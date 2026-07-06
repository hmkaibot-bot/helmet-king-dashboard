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
}

export async function fetchRetailCommission(month: string): Promise<CommissionResult> {
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
