/**
 * Vercel serverless function — 商品編輯器嘅讀取 + 圖片 + collection 操作。
 * 文字欄 (title / 描述 / product_type / tags) 用另一支 api/shopify-update-product.ts。
 *
 * 安全: Shopify token 留 server-side; 呼叫者要帶 Supabase 用戶 JWT。
 * env: SHOPIFY_SHOP + (SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET 或 SHOPIFY_ADMIN_TOKEN), 需 write_products scope
 *
 * action:
 *  - get             { productId }                      → 商品詳情 (含 media / collections)
 *  - listCollections {}                                 → 所有 collection (落揀單)
 *  - addMedia        { productId, urls[] }              → 由圖片 URL 加相
 *  - deleteMedia     { productId, mediaIds[] }          → 刪相
 *  - reorderMedia    { productId, mediaIds[] (新次序) }  → 重排
 *  - addCollection   { productId, collectionId }        → 加入 collection
 *  - removeCollection{ productId, collectionId }        → 由 collection 移除 (只限手動 collection)
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; RLS 保護) — 唔可以空, 否則 verifyUser 401 "No API key found"
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = '2026-01';

// 有靜態 token, 或者有 Client ID + Secret (Dev Dashboard app) 就算設定好。
const SHOPIFY_READY =
  !!SHOPIFY_SHOP && (!!SHOPIFY_TOKEN || (!!SHOPIFY_CLIENT_ID && !!SHOPIFY_CLIENT_SECRET));

export const config = { maxDuration: 60 };

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

// Dev Dashboard app 冇靜態 token — 要用 Client ID + Secret 行 client credentials grant
// 即時換領 access token (約 24h 過期), 所以 cache 住、夠鐘先再換。
// 若有設定舊式 SHOPIFY_ADMIN_TOKEN 就直接用 (向後相容)。
let _tok = '';
let _tokExp = 0; // epoch ms
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
    _tokExp = Date.now() + (Number(j.expires_in || 86400) - 300) * 1000; // 提早 5 分鐘 refresh
    return _tok;
  }
  return SHOPIFY_TOKEN; // 向後相容: 靜態 admin custom app token
}

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  const accessToken = await getShopifyToken();
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({} as any));
  if (!r.ok || j.errors) {
    const detail = j?.errors ?? j?.error ?? '';
    throw new Error(`HTTP ${r.status}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  return j.data;
}

const pid = (id: string) => `gid://shopify/Product/${id}`;
const firstErr = (arr: any[]) => (arr && arr.length ? arr.map((e) => e.message).join('; ') : '');

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SHOPIFY_READY)
    return res.status(500).json({ error: 'Shopify 未設定 (請喺 Vercel 加 SHOPIFY_SHOP + SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)' });

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const action = String(body?.action || '');

  try {
    if (action === 'get') {
      const data = await gql(
        `query($id: ID!) {
          product(id: $id) {
            id title descriptionHtml productType vendor tags status handle onlineStoreUrl
            media(first: 50) { nodes { id mediaContentType status preview { image { url } } } }
            collections(first: 50) { nodes { id title } }
            variants(first: 100) { nodes { id sku price compareAtPrice inventoryQuantity } }
          }
        }`,
        { id: pid(body.productId) }
      );
      const p = data?.product;
      if (!p) return res.status(404).json({ error: '搵唔到商品' });
      return res.status(200).json({
        product: {
          id: p.id,
          title: p.title,
          descriptionHtml: p.descriptionHtml || '',
          productType: p.productType || '',
          vendor: p.vendor || '',
          tags: p.tags || [],
          status: p.status,
          handle: p.handle,
          onlineStoreUrl: p.onlineStoreUrl || null,
          media: (p.media?.nodes || []).map((m: any) => ({
            id: m.id,
            url: m.preview?.image?.url || null,
            type: m.mediaContentType,
            status: m.status,
          })),
          collections: (p.collections?.nodes || []).map((c: any) => ({ id: c.id, title: c.title })),
          // 營銷貼文用 — 生成嗰刻攞 live 價,唔用隔夜 snapshot
          variants: (p.variants?.nodes || []).map((v: any) => ({
            id: v.id,
            sku: v.sku || '',
            price: v.price != null ? Number(v.price) : null,
            compareAtPrice: v.compareAtPrice != null ? Number(v.compareAtPrice) : null,
            inventoryQuantity: v.inventoryQuantity ?? null,
          })),
        },
      });
    }

    if (action === 'listCollections') {
      const data = await gql(`query { collections(first: 250) { nodes { id title } } }`, {});
      return res.status(200).json({ collections: (data?.collections?.nodes || []).map((c: any) => ({ id: c.id, title: c.title })) });
    }

    if (action === 'addMedia') {
      const urls: string[] = Array.isArray(body.urls) ? body.urls : [];
      if (urls.length === 0) return res.status(400).json({ error: '冇圖片 URL' });
      const media = urls.map((u) => ({ originalSource: u, mediaContentType: 'IMAGE' }));
      const data = await gql(
        `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) { media { id } mediaUserErrors { field message } }
        }`,
        { productId: pid(body.productId), media }
      );
      const err = firstErr(data?.productCreateMedia?.mediaUserErrors);
      if (err) return res.status(200).json({ ok: false, error: err });
      return res.status(200).json({ ok: true, added: data?.productCreateMedia?.media?.length || 0 });
    }

    if (action === 'deleteMedia') {
      const mediaIds: string[] = Array.isArray(body.mediaIds) ? body.mediaIds : [];
      if (mediaIds.length === 0) return res.status(400).json({ error: '冇相揀' });
      const data = await gql(
        `mutation($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds mediaUserErrors { field message } }
        }`,
        { productId: pid(body.productId), mediaIds }
      );
      const err = firstErr(data?.productDeleteMedia?.mediaUserErrors);
      if (err) return res.status(200).json({ ok: false, error: err });
      return res.status(200).json({ ok: true, deleted: data?.productDeleteMedia?.deletedMediaIds?.length || 0 });
    }

    if (action === 'reorderMedia') {
      const mediaIds: string[] = Array.isArray(body.mediaIds) ? body.mediaIds : [];
      if (mediaIds.length === 0) return res.status(400).json({ error: '冇次序' });
      const moves = mediaIds.map((id, i) => ({ id, newPosition: String(i) }));
      const data = await gql(
        `mutation($id: ID!, $moves: [MoveInput!]!) {
          productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message } }
        }`,
        { id: pid(body.productId), moves }
      );
      const err = firstErr(data?.productReorderMedia?.mediaUserErrors);
      if (err) return res.status(200).json({ ok: false, error: err });
      return res.status(200).json({ ok: true });
    }

    if (action === 'addCollection') {
      const data = await gql(
        `mutation($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) { collection { id } userErrors { field message } }
        }`,
        { id: body.collectionId, productIds: [pid(body.productId)] }
      );
      const err = firstErr(data?.collectionAddProducts?.userErrors);
      if (err) return res.status(200).json({ ok: false, error: err });
      return res.status(200).json({ ok: true });
    }

    if (action === 'removeCollection') {
      const data = await gql(
        `mutation($id: ID!, $productIds: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $productIds) { job { id } userErrors { field message } }
        }`,
        { id: body.collectionId, productIds: [pid(body.productId)] }
      );
      const err = firstErr(data?.collectionRemoveProducts?.userErrors);
      if (err) return res.status(200).json({ ok: false, error: err + '（注意：自動 / 規則 collection 無法手動移除）' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `未知 action: ${action}` });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
