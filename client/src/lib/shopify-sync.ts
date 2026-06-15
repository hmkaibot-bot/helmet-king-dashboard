import { supabase } from './supabase';

export interface SyncItem {
  productId: string;
  promoPrice: number;
}

export interface SyncResult {
  total: number;
  ok: number;
  failed: number;
  results: { productId: string; ok: boolean; error?: string }[];
}

// 每批商品數 — Shopify 每件要 2 個 GraphQL call,細批避免 Vercel function timeout
// (Hobby plan 10s) 同 Shopify rate limit。
const CHUNK = 8;

/**
 * 將推廣價推上 (action='apply') 或還原 (action='restore') Shopify。
 * 經 /api/shopify-sync-price serverless function — Shopify token 只喺 server。
 * 帶住用戶 Supabase JWT 認證。
 */
export async function syncPromoPrices(
  items: SyncItem[],
  action: 'apply' | 'restore',
  onProgress?: (done: number, total: number) => void
): Promise<SyncResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('未登入 — 請重新登入 dashboard');

  const agg: SyncResult = { total: items.length, ok: 0, failed: 0, results: [] };
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    const resp = await fetch('/api/shopify-sync-price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, items: batch }),
    });
    let j: any = null;
    try { j = await resp.json(); } catch { /* non-JSON (e.g. 404 在本地 dev) */ }
    if (!resp.ok) {
      throw new Error(j?.error || `同步服務回應 ${resp.status}（部署後先可用）`);
    }
    agg.ok += j.ok ?? 0;
    agg.failed += j.failed ?? 0;
    if (Array.isArray(j.results)) agg.results.push(...j.results);
    onProgress?.(Math.min(i + CHUNK, items.length), items.length);
  }
  return agg;
}
