import { supabase } from './supabase';

export interface ProductUpdate {
  productId: string;
  productType?: string;
  title?: string;
  descriptionHtml?: string;
  tags?: string[];
}

export interface UpdateResult {
  total: number;
  ok: number;
  failed: number;
  results: { productId: string; ok: boolean; error?: string }[];
}

const CHUNK = 15;

/**
 * 更新 Shopify 商品欄位（product_type / title / 描述 / tags），經
 * /api/shopify-update-product serverless function（Shopify token 只喺 server，
 * 帶用戶 Supabase JWT 認證）。
 */
export async function updateProducts(
  items: ProductUpdate[],
  onProgress?: (done: number, total: number) => void
): Promise<UpdateResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('未登入 — 請重新登入 dashboard');

  const agg: UpdateResult = { total: items.length, ok: 0, failed: 0, results: [] };
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    const resp = await fetch('/api/shopify-update-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: batch }),
    });
    let j: any = null;
    try { j = await resp.json(); } catch { /* non-JSON */ }
    if (!resp.ok) throw new Error(j?.error || `更新服務回應 ${resp.status}（部署後先可用）`);
    agg.ok += j.ok ?? 0;
    agg.failed += j.failed ?? 0;
    if (Array.isArray(j.results)) agg.results.push(...j.results);
    onProgress?.(Math.min(i + CHUNK, items.length), items.length);
  }
  return agg;
}
