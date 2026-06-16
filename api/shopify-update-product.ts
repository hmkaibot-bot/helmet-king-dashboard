/**
 * Vercel serverless function — 更新 Shopify 商品欄位。
 * P1 用嚟改 product_type（分類清理）；title / tags / descriptionHtml 預留俾 P2 文案。
 *
 * 安全: Shopify Admin token 只留 server-side；呼叫者要帶有效 Supabase 用戶 JWT。
 * env (同 shopify-sync-price 共用): SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN (需 write_products scope)
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; RLS 保護) — 唔可以空, 否則 verifyUser 401 "No API key found"
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const API_VERSION = '2026-01';

export const config = { maxDuration: 60 };

interface UpdateItem {
  productId: string;
  productType?: string;
  title?: string;
  descriptionHtml?: string;
  tags?: string[];
}

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

async function shopifyGraphQL(query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : `HTTP ${r.status}`);
  }
  return j.data;
}

const PRODUCT_UPDATE = `mutation($input: ProductInput!) {
  productUpdate(input: $input) { product { id productType } userErrors { field message } }
}`;

async function updateOne(it: UpdateItem) {
  const input: Record<string, unknown> = { id: `gid://shopify/Product/${it.productId}` };
  if (typeof it.productType === 'string') input.productType = it.productType;
  if (typeof it.title === 'string') input.title = it.title;
  if (typeof it.descriptionHtml === 'string') input.descriptionHtml = it.descriptionHtml;
  if (Array.isArray(it.tags)) input.tags = it.tags;
  const data = await shopifyGraphQL(PRODUCT_UPDATE, { input });
  const ue = data?.productUpdate?.userErrors ?? [];
  if (ue.length) throw new Error(ue.map((e: any) => e.message).join('; '));
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN) {
    res.status(500).json({ error: 'Shopify 未設定 (請喺 Vercel 加 SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN)' });
    return;
  }
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) {
    res.status(401).json({ error: '未授權 — 請先登入 dashboard' });
    return;
  }

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const items: UpdateItem[] = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) {
    res.status(400).json({ error: '冇商品可更新' });
    return;
  }

  const results: { productId: string; ok: boolean; error?: string }[] = [];
  for (const it of items) {
    try {
      await updateOne(it);
      results.push({ productId: it.productId, ok: true });
    } catch (e: any) {
      results.push({ productId: it.productId, ok: false, error: e?.message || String(e) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  res.status(200).json({ total: items.length, ok, failed: items.length - ok, results });
}
