/**
 * Vercel serverless function — 將 dashboard 嘅推廣價推上 / 還原 Shopify。
 *
 * 安全模型:
 *  - Shopify 認證資料只存喺 server-side env var, 永遠唔會落前端 bundle。
 *  - 呼叫者必須帶住有效嘅 Supabase 用戶 JWT (Authorization: Bearer <jwt>),
 *    即係只有登入咗 dashboard 嘅用戶先 call 到 → 防止公開 endpoint 被濫用改價。
 *
 * 需要嘅 Vercel 環境變數:
 *  - SHOPIFY_SHOP            e.g. helmetking-0001.myshopify.com
 *  - Shopify 認證 (二揀一):
 *      A) Dev Dashboard app (建議): SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *         → 用 client credentials grant 即時換領 access token (需 write_products scope)
 *      B) 舊式 admin custom app: SHOPIFY_ADMIN_TOKEN (shpat_...)
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
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = '2026-01';

// 有靜態 token, 或者有 Client ID + Secret (Dev Dashboard app) 就算設定好。
const SHOPIFY_READY =
  !!SHOPIFY_SHOP && (!!SHOPIFY_TOKEN || (!!SHOPIFY_CLIENT_ID && !!SHOPIFY_CLIENT_SECRET));

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

async function shopifyGraphQL(query: string, variables: Record<string, unknown>): Promise<any> {
  const accessToken = await getShopifyToken();
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({} as any));
  if (!r.ok || j.errors) {
    // Shopify 嘅錯誤可以係 string (e.g. 401 "[API] Invalid API key or access token")
    // 或 object (GraphQL userErrors) — 兩種都要顯示出嚟, 否則淨係見到 "HTTP 401" 好難 debug。
    const detail = j?.errors ?? j?.error ?? '';
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw new Error(`HTTP ${r.status}${msg ? ` — ${msg}` : ''}`);
  }
  return j.data;
}

// 推廣快照 metafield — apply 時記低 variant 嘅 (原售價, 原建議零售價),令 restore
// 可以精準還原。舊 bug: restore 當 compareAt 一定係 promo 撐起嘅原價 → 會將真正嘅
// 建議零售價 (MSRP) / 死貨手動減價當成 promo 還原,毁掉劃線價兼推高售價。
const SNAP_NS = 'hk_promo';
const SNAP_KEY = 'snapshot';

const VARIANTS_QUERY = `query($id: ID!) {
  product(id: $id) {
    id
    variants(first: 100) {
      nodes {
        id
        price
        compareAtPrice
        metafield(namespace: "${SNAP_NS}", key: "${SNAP_KEY}") { value }
      }
    }
  }
}`;

const BULK_UPDATE = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

interface VariantNode {
  id: string;
  price: string | null;
  compareAtPrice: string | null;
  metafield: { value: string | null } | null;
}

// 解析快照 → { p: 原售價, c: 原建議零售價|null }。冇 / 已清走 ('{}') / 壞 JSON
// 一律當 null,即「未被本工具 apply 過」。
function parseSnapshot(v: VariantNode): { p: number; c: number | null } | null {
  const raw = v.metafield?.value;
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o.p === 'number') {
      return { p: o.p, c: typeof o.c === 'number' ? o.c : null };
    }
  } catch {
    /* 壞 JSON → 當未 apply */
  }
  return null;
}

async function syncOneProduct(item: SyncItem, action: 'apply' | 'restore') {
  const gid = `gid://shopify/Product/${item.productId}`;
  const data = await shopifyGraphQL(VARIANTS_QUERY, { id: gid });
  const product = data?.product;
  if (!product) throw new Error('搵唔到商品');

  const variants: VariantNode[] = product.variants?.nodes ?? [];
  if (variants.length === 0) throw new Error('冇 variant');

  const variantInputs: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const v of variants) {
    const curPrice = Number(v.price) || 0;
    const cmp = Number(v.compareAtPrice);
    const curCompare = v.compareAtPrice != null && cmp > 0 ? cmp : null;
    const snap = parseSnapshot(v);

    if (action === 'restore') {
      // 只還原本工具 apply 過 (有 snapshot) 嘅 variant;其餘一概唔郁,
      // 杜絕毁掉手動建議零售價 / 死貨減價。
      if (!snap) {
        skipped++;
        continue;
      }
      variantInputs.push({
        id: v.id,
        price: snap.p.toFixed(2),
        compareAtPrice: snap.c != null ? snap.c.toFixed(2) : null,
        // 清走快照 (空 object) → 下次 restore 會當佢未 apply,避免重複還原
        metafields: [{ namespace: SNAP_NS, key: SNAP_KEY, type: 'json', value: '{}' }],
      });
      continue;
    }

    // ── apply ──
    // 第一次 apply 先 capture 真正 pre-promo 狀態;已 apply 過就沿用原快照,
    // 避免再 apply 時將「原價」覆蓋成上次嘅 promo 價 (idempotent)。
    const baseP = snap ? snap.p : curPrice;
    const baseC = snap ? snap.c : curCompare;
    const strike = Math.max(baseP, baseC ?? 0); // 劃線價 = 原售價同建議零售價取大者
    variantInputs.push({
      id: v.id,
      price: Number(item.promoPrice).toFixed(2),
      compareAtPrice: strike > 0 ? strike.toFixed(2) : null,
      metafields: [
        {
          namespace: SNAP_NS,
          key: SNAP_KEY,
          type: 'json',
          value: JSON.stringify({ p: baseP, c: baseC }),
        },
      ],
    });
  }

  if (variantInputs.length === 0) return { updated: 0, skipped };

  const res = await shopifyGraphQL(BULK_UPDATE, { productId: gid, variants: variantInputs });
  const ue = res?.productVariantsBulkUpdate?.userErrors ?? [];
  if (ue.length) throw new Error(ue.map((e: any) => e.message).join('; '));
  return { updated: variantInputs.length, skipped };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!SHOPIFY_READY) {
    res.status(500).json({ error: 'Shopify 未設定 (請喺 Vercel 加 SHOPIFY_SHOP + SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)' });
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

  const results: { productId: string; ok: boolean; updated?: number; skipped?: number; error?: string }[] = [];
  for (const it of items) {
    try {
      const { updated, skipped } = await syncOneProduct(it, action);
      results.push({ productId: it.productId, ok: true, updated, skipped });
    } catch (e: any) {
      results.push({ productId: it.productId, ok: false, error: e?.message || String(e) });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const skipped = results.reduce((s, r) => s + (r.skipped || 0), 0);
  res.status(200).json({ action, total: items.length, ok, failed: items.length - ok, skipped, results });
}
