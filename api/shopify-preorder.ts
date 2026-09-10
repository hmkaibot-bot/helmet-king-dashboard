/**
 * Vercel serverless function — 預訂 Pre-orders(訂金商品模式,飛 PreProduct)。
 *
 * 機制:每個預訂 campaign 喺 Shopify 開一件【預訂】商品 —
 *  - 價錢 = 訂金(客人網店照常 checkout 畀訂金,冇 app 冇 mandate)
 *  - 每個款式一個 variant,variant 庫存 = 接訂上限(inventoryPolicy DENY,
 *    訂滿 Shopify 原生斷數)
 *  - vendor='PREORDER' + product_type='PRE-ORDER DEPOSIT':dashboard 品牌/
 *    類別統計自動剔走(business-filter 認唔到佢係零售品牌/零售類型)
 * 到貨:客人到店 POS 補尾數(full_price − deposit);訂唔到貨先退訂金。
 *
 * actions:
 *  create { title, imageUrl?, depositPrice, fullPrice, eta?, realProductId?,
 *           variants: [{ label, sku, limit }] }
 *        → 開商品 + variants + 庫存 + 圖 + 上架 sales channels
 *  close  { productId }  → status DRAFT(落架)
 *  live   { productId }  → 實時 variants(sku/title/剩餘庫存)— 訂咗幾多 = limit − 剩餘
 *
 * 安全模型同 shopify-sync-price 一致:Shopify 認證只喺 server env;
 * 呼叫者必須帶有效 Supabase 用戶 JWT。
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
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw new Error(`HTTP ${r.status}${msg ? ` — ${msg}` : ''}`);
  }
  return j.data;
}

const errText = (errs: Array<{ message: string }> | undefined) =>
  (errs ?? []).map((e) => e.message).join('; ');

interface CreateVariant {
  label: string;
  sku: string;
  limit: number;
}

const fmtHK = (n: number) => `HK$${Math.round(n).toLocaleString('en-US')}`;

function descriptionHtml(deposit: number, full: number, eta?: string | null): string {
  const rest = Math.max(0, full - deposit);
  return [
    `<p><strong>【預訂商品 · 訂金】</strong>呢件係預訂訂金,唔係現貨即賣。</p>`,
    `<ul>`,
    `<li>訂金:<strong>${fmtHK(deposit)}</strong>(每件)</li>`,
    `<li>商品總價:<strong>${fmtHK(full)}</strong> — 到貨後到店取貨時補尾數 <strong>${fmtHK(rest)}</strong></li>`,
    eta ? `<li>預計到貨:<strong>${eta}</strong></li>` : '',
    `<li>每個款式限量接訂,訂滿即止</li>`,
    `<li>如最終未能訂到貨,訂金全數退還</li>`,
    `</ul>`,
  ].filter(Boolean).join('');
}

async function createPreorder(body: any) {
  const title = String(body.title || '').trim();
  const deposit = Number(body.depositPrice);
  const full = Number(body.fullPrice);
  const eta = body.eta ? String(body.eta) : null;
  const imageUrl = body.imageUrl ? String(body.imageUrl) : null;
  const variants: CreateVariant[] = Array.isArray(body.variants) ? body.variants : [];

  if (!title) throw new Error('冇商品名');
  if (!(deposit > 0)) throw new Error('訂金必須大過 0');
  if (!(full > deposit)) throw new Error('總價必須大過訂金');
  if (variants.length === 0) throw new Error('至少揀一個款式');
  for (const v of variants) {
    if (!v.label || !v.sku) throw new Error('款式要有名同 SKU');
    if (!(Number(v.limit) > 0)) throw new Error(`「${v.label}」接訂上限必須大過 0`);
  }

  const warnings: string[] = [];

  // 1) 攞主倉 location(variant 庫存 = 接訂上限,要指定倉)
  const locData = await gql(`{ locations(first: 1) { nodes { id } } }`, {});
  const locationId: string | undefined = locData?.locations?.nodes?.[0]?.id;
  if (!locationId) throw new Error('搵唔到 Shopify location');

  // 2) 開商品(vendor/product_type 特登用預訂專屬值 — 統計頁靠呢個剔走佢)
  const createData = await gql(
    `mutation($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id handle }
        userErrors { field message }
      }
    }`,
    {
      product: {
        title: `【預訂】${title}(訂金)`,
        descriptionHtml: descriptionHtml(deposit, full, eta),
        productType: 'PRE-ORDER DEPOSIT',
        vendor: 'PREORDER',
        status: 'ACTIVE',
        tags: ['preorder'],
        productOptions: [{ name: '款式', values: variants.map((v) => ({ name: v.label })) }],
      },
      media: imageUrl ? [{ originalSource: imageUrl, mediaContentType: 'IMAGE' }] : undefined,
    }
  );
  const pErr = errText(createData?.productCreate?.userErrors);
  if (pErr) throw new Error(`開商品失敗:${pErr}`);
  const productGid: string = createData.productCreate.product.id;
  const numericId = Number(productGid.split('/').pop());

  // 3) 開 variants:價=訂金、SKU、庫存=上限、DENY 超賣(訂滿自動買唔到)
  const varData = await gql(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
        productVariants { id sku }
        userErrors { field message }
      }
    }`,
    {
      productId: productGid,
      strategy: 'REMOVE_STANDALONE_VARIANT',
      variants: variants.map((v) => ({
        optionValues: [{ optionName: '款式', name: v.label }],
        price: deposit.toFixed(2),
        inventoryPolicy: 'DENY',
        inventoryItem: { sku: v.sku, tracked: true },
        inventoryQuantities: [{ availableQuantity: Math.floor(Number(v.limit)), locationId }],
      })),
    }
  );
  const vErr = errText(varData?.productVariantsBulkCreate?.userErrors);
  if (vErr) {
    // variants 開唔成,件商品冇用 — 熄咗佢免變孤兒
    await gql(
      `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { message field } } }`,
      { product: { id: productGid, status: 'DRAFT' } }
    ).catch(() => {});
    throw new Error(`開款式失敗:${vErr}`);
  }

  // 4) 上架 sales channels(冇 read_publications scope 就出 warning,唔炒)
  try {
    const pubData = await gql(`{ publications(first: 10) { nodes { id } } }`, {});
    const pubs: Array<{ id: string }> = pubData?.publications?.nodes ?? [];
    if (pubs.length > 0) {
      const pubRes = await gql(
        `mutation($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { userErrors { field message } }
        }`,
        { id: productGid, input: pubs.map((p) => ({ publicationId: p.id })) }
      );
      const pubErr = errText(pubRes?.publishablePublish?.userErrors);
      if (pubErr) warnings.push(`上架 sales channel 出錯:${pubErr} — 去 Shopify 商品頁人手剔返`);
    }
  } catch (e: any) {
    warnings.push(`未能自動上架 sales channel(${String(e?.message || e).slice(0, 80)})— 去 Shopify 商品頁人手剔「Online Store」`);
  }

  return { productId: numericId, handle: createData.productCreate.product.handle, warnings };
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
  const action = String(body?.action || '');

  try {
    if (action === 'create') {
      const out = await createPreorder(body);
      return res.status(200).json({ ok: true, ...out });
    }

    if (action === 'close') {
      const gid = `gid://shopify/Product/${body.productId}`;
      const d = await gql(
        `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id status } userErrors { field message } } }`,
        { product: { id: gid, status: 'DRAFT' } }
      );
      const err = errText(d?.productUpdate?.userErrors);
      if (err) throw new Error(err);
      return res.status(200).json({ ok: true });
    }

    if (action === 'live') {
      const gid = `gid://shopify/Product/${body.productId}`;
      const d = await gql(
        `query($id: ID!) { product(id: $id) { status onlineStorePreviewUrl
          variants(first: 100) { nodes { sku title inventoryQuantity price } } } }`,
        { id: gid }
      );
      if (!d?.product) return res.status(404).json({ error: '搵唔到預訂商品(可能已刪除)' });
      return res.status(200).json({
        ok: true,
        status: d.product.status,
        url: d.product.onlineStorePreviewUrl || null,
        variants: (d.product.variants?.nodes ?? []).map((v: any) => ({
          sku: v.sku || '',
          title: v.title || '',
          remaining: v.inventoryQuantity ?? 0,
          price: v.price,
        })),
      });
    }

    return res.status(400).json({ error: `未知 action:${action}` });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
