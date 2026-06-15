/**
 * Vercel serverless function — 商品編輯器嘅讀取 + 圖片 + collection 操作。
 * 文字欄 (title / 描述 / product_type / tags) 用另一支 api/shopify-update-product.ts。
 *
 * 安全: Shopify token 留 server-side; 呼叫者要帶 Supabase 用戶 JWT。
 * env: SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN (需 write_products scope)
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
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const API_VERSION = '2026-01';

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

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(typeof j.errors === 'object' ? JSON.stringify(j.errors) : `HTTP ${r.status}`);
  return j.data;
}

const pid = (id: string) => `gid://shopify/Product/${id}`;
const firstErr = (arr: any[]) => (arr && arr.length ? arr.map((e) => e.message).join('; ') : '');

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN)
    return res.status(500).json({ error: 'Shopify 未設定 (請喺 Vercel 加 SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN)' });

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
            id title descriptionHtml productType tags status handle onlineStoreUrl
            media(first: 50) { nodes { id mediaContentType status preview { image { url } } } }
            collections(first: 50) { nodes { id title } }
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
