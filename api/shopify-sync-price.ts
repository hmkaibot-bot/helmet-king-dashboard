/**
 * Vercel serverless function — 將 dashboard 嘅推廣價推上 / 還原 Shopify。
 *
 * 安全模型:
 *  - Shopify Admin token 只存喺 server-side env var (SHOPIFY_ADMIN_TOKEN),
 *    永遠唔會落前端 bundle。
 *  - 呼叫者必須帶住有效嘅 Supabase 用戶 JWT (Authorization: Bearer <jwt>),
 *    即係只有登入咗 dashboard 嘅用戶先 call 到 → 防止公開 endpoint 被濫用改價。
 *
 * 需要嘅 Vercel 環境變數:
 *  - SHOPIFY_SHOP          e.g. helmetking-0001.myshopify.com
 *  - SHOPIFY_ADMIN_TOKEN   shpca_...  (需要 write_products scope)
 *  (SUPABASE_URL / SUPABASE_ANON_KEY 有 fallback,毋須另設)
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 client/src/lib/config.ts; RLS 保護資料)。必須有值, 否則
  // verifyUser 嘅 apikey header 會空, Supabase 回 401 "No API key found" → 所有用戶被當未授權。
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const API_VERSION = '2026-01';

// Vercel: 俾長啲嘅 timeout (Pro plan 先生效, Hobby 上限 10s — client 已分細批)
export const config = { maxDuration: 60 };

interface SyncItem {
  productId: string;
  promoPrice: number;
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
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : `HTTP ${r.status}`);
  }
  return j.data;
}

const VARIANTS_QUERY = `query($id: ID!) {
  product(id: $id) { id variants(first: 100) { nodes { id price compareAtPrice } } }
}`;

const BULK_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

async function syncOneProduct(item: SyncItem, action: 'apply' | 'restore') {
  const gid = `gid://shopify/Product/${item.productId}`;
  const data = await shopifyGraphQL(VARIANTS_QUERY, { id: gid });
  const product = data?.product;
  if (!product) throw new Error('搵唔到商品');

  const variants: { id: string; price: string; compareAtPrice: string | null }[] =
    product.variants?.nodes ?? [];
  if (variants.length === 0) throw new Error('冇 variant');

  const variantInputs = variants.map((v) => {
    const curPrice = Number(v.price) || 0;
    const curCompare = Number(v.compareAtPrice) || 0;
    if (action === 'restore') {
      // 還原: 售價 = 原價 (compareAt 有值就用,否則保持現價),清走 compareAt
      const original = curCompare > 0 ? curCompare : curPrice;
      return { id: v.id, price: original.toFixed(2), compareAtPrice: null };
    }
    // 套用推廣: compareAt = 原價 (現價同 compareAt 取大者),售價 = 推廣價
    const original = Math.max(curPrice, curCompare);
    return { id: v.id, price: Number(item.promoPrice).toFixed(2), compareAtPrice: original.toFixed(2) };
  });

  const res = await shopifyGraphQL(BULK_UPDATE, { productId: gid, variants: variantInputs });
  const ue = res?.productVariantsBulkUpdate?.userErrors ?? [];
  if (ue.length) throw new Error(ue.map((e: any) => e.message).join('; '));
  return variantInputs.length;
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

  // ── Auth: 必須係登入咗嘅 dashboard 用戶 ──
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
  const action: 'apply' | 'restore' = body?.action === 'restore' ? 'restore' : 'apply';
  const items: SyncItem[] = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) {
    res.status(400).json({ error: '冇商品可同步' });
    return;
  }

  const results: { productId: string; ok: boolean; updated?: number; error?: string }[] = [];
  for (const it of items) {
    try {
      const updated = await syncOneProduct(it, action);
      results.push({ productId: it.productId, ok: true, updated });
    } catch (e: any) {
      results.push({ productId: it.productId, ok: false, error: e?.message || String(e) });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  res.status(200).json({ action, total: items.length, ok, failed: items.length - ok, results });
}
