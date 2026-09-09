/**
 * Vercel serverless function — 價格編輯器:逐個 variant 改正價 (price / compareAtPrice)。
 *
 * 同 /api/shopify-sync-price(推廣價,product 級一刀切)嘅分別:
 *  - 呢支係 variant 級:每個 SKU 自己一個價,SINGLE / DUO 分開改
 *  - 改嘅係「正價」— 唔寫 snapshot、唔搞劃線價自動計,老闆話幾多就幾多
 *  - 保險:推廣中(hk_promo.snapshot 非空)嘅 variant 一律拒改 —
 *    唔係嘅話推廣完結「還原原價」會用舊 snapshot 冚返老闆啱啱改嘅新正價
 *
 * 安全模型同 sync-price 一致:Shopify 認證只喺 server env;呼叫者必須帶
 * 有效 Supabase 用戶 JWT。
 *
 * POST body: { items: [{ productId: string,
 *                        variants: [{ variantId: string,
 *                                     price?: number,            // 唔提供 = 唔郁
 *                                     compareAtPrice?: number|null }] }] } // null = 清走劃線價
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 client/src/lib/config.ts; RLS 保護資料)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = '2026-01';

const SHOPIFY_READY =
  !!SHOPIFY_SHOP && (!!SHOPIFY_TOKEN || (!!SHOPIFY_CLIENT_ID && !!SHOPIFY_CLIENT_SECRET));

export const config = { maxDuration: 60 };

interface VariantEdit {
  variantId: string;
  price?: number;
  compareAtPrice?: number | null;
}
interface EditItem {
  productId: string;
  variants: VariantEdit[];
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

// token 換領 + cache — 同 shopify-sync-price 一套
let _tok = '';
let _tokExp = 0;
async function getShopifyToken(): Promise<string> {
  if (SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET) {
    if (_tok && Date.now() < _tokExp) return _tok;
    const r = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    });
    const j = await r.json().catch(() => ({} as any));
    if (!r.ok || !j.access_token) {
      const detail = j?.error_description || j?.error || JSON.stringify(j);
      throw new Error(`攞 Shopify token 失敗 — HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
    }
    _tok = j.access_token;
    _tokExp = Date.now() + (Number(j.expires_in || 86400) - 300) * 1000;
    return _tok;
  }
  return SHOPIFY_TOKEN;
}

async function shopifyGraphQL(query: string, variables: Record<string, unknown>): Promise<any> {
  const accessToken = await getShopifyToken();
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({} as any));
  if (!r.ok || j.errors) {
    const detail = j?.errors ?? j?.error ?? '';
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw new Error(`HTTP ${r.status}${msg ? ` — ${msg}` : ''}`);
  }
  return j.data;
}

// 推廣快照 metafield(hk_promo.snapshot)— 有嘢喺入面 = 推廣中,拒改
const SNAP_NS = 'hk_promo';
const SNAP_KEY = 'snapshot';

const VARIANTS_QUERY = `query($id: ID!) {
  product(id: $id) {
    id
    variants(first: 100) {
      nodes {
        id
        metafield(namespace: "${SNAP_NS}", key: "${SNAP_KEY}") { value }
      }
    }
  }
}`;

const BULK_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price compareAtPrice }
    userErrors { field message }
  }
}`;

function hasPromoSnapshot(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const o = JSON.parse(raw);
    return !!o && typeof o.p === 'number';
  } catch {
    return false;
  }
}

interface VariantResult {
  variantId: string;
  ok: boolean;
  error?: string;
}

async function updateOneProduct(item: EditItem): Promise<VariantResult[]> {
  const gid = `gid://shopify/Product/${item.productId}`;
  const data = await shopifyGraphQL(VARIANTS_QUERY, { id: gid });
  const nodes: Array<{ id: string; metafield: { value: string | null } | null }> =
    data?.product?.variants?.nodes ?? [];
  if (!data?.product) throw new Error('搵唔到商品');
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const results: VariantResult[] = [];
  const inputs: Record<string, unknown>[] = [];
  const inputVid: string[] = [];

  for (const v of item.variants) {
    const vgid = `gid://shopify/ProductVariant/${v.variantId}`;
    const node = byId.get(vgid);
    if (!node) {
      results.push({ variantId: v.variantId, ok: false, error: 'Shopify 搵唔到呢個 variant' });
      continue;
    }
    if (hasPromoSnapshot(node.metafield?.value)) {
      results.push({
        variantId: v.variantId,
        ok: false,
        error: '推廣中(有原價 snapshot)— 先喺推廣活動頁「還原原價」,再改正價,唔係新價會俾還原冚走',
      });
      continue;
    }
    if (v.price == null && v.compareAtPrice === undefined) {
      results.push({ variantId: v.variantId, ok: false, error: '冇任何要改嘅欄' });
      continue;
    }
    if (v.price != null && !(Number(v.price) > 0)) {
      results.push({ variantId: v.variantId, ok: false, error: '售價必須大過 0' });
      continue;
    }
    const input: Record<string, unknown> = { id: vgid };
    if (v.price != null) input.price = Number(v.price).toFixed(2);
    if (v.compareAtPrice !== undefined) {
      input.compareAtPrice =
        v.compareAtPrice != null && Number(v.compareAtPrice) > 0
          ? Number(v.compareAtPrice).toFixed(2)
          : null; // null = 清走劃線價
    }
    inputs.push(input);
    inputVid.push(v.variantId);
  }

  if (inputs.length > 0) {
    const res = await shopifyGraphQL(BULK_UPDATE, { productId: gid, variants: inputs });
    const errs: Array<{ field?: string[]; message: string }> =
      res?.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length > 0) {
      // userErrors 唔一定指到邊個 variant — 整批當失敗,原文回俾前端
      const msg = errs.map((e) => e.message).join('; ');
      for (const vid of inputVid) results.push({ variantId: vid, ok: false, error: msg });
    } else {
      for (const vid of inputVid) results.push({ variantId: vid, ok: true });
    }
  }
  return results;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SHOPIFY_READY) {
    return res.status(500).json({
      error: 'Shopify 未設定 — 要 SHOPIFY_SHOP + (SHOPIFY_CLIENT_ID/SECRET 或 SHOPIFY_ADMIN_TOKEN)',
    });
  }

  const auth = String(req.headers?.authorization || '');
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt || !(await verifyUser(jwt))) {
    return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });
  }

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const items: EditItem[] = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return res.status(400).json({ error: '冇嘢要改 (items 空)' });

  const results: Array<{ productId: string; variants: VariantResult[]; error?: string }> = [];
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const vr = await updateOneProduct(item);
      ok += vr.filter((r) => r.ok).length;
      failed += vr.filter((r) => !r.ok).length;
      results.push({ productId: item.productId, variants: vr });
    } catch (e: any) {
      failed += (item.variants?.length ?? 0) || 1;
      results.push({ productId: item.productId, variants: [], error: e?.message || String(e) });
    }
  }
  return res.status(200).json({ ok, failed, results });
}
