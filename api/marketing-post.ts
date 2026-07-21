import Anthropic from '@anthropic-ai/sdk';
import {
  buildPrompt,
  POST_TYPES, TONES, LANGS, PLATFORMS, SCENARIO_KEYS,
  type PostType, type Tone, type Lang, type Platform, type PromptProduct,
// 一定要帶 .js 副檔名 — package.json 係 "type":"module",Vercel node runtime 以
// ESM 執行,無副檔名相對 import 會 ERR_MODULE_NOT_FOUND,成支 function 一 load
// 就死 (FUNCTION_INVOCATION_FAILED)。tsc/esbuild 會自動將 .js 對應返 .ts 原檔。
} from './_marketing-prompts.js';

/**
 * Vercel serverless function — 營銷貼文文案生成。
 * 骨架同 api/ai-copy-review.ts 一致:Supabase JWT 驗證 → Claude → 抽 JSON。
 * 只有 brand_story 先開 web_search(搵品牌官方背景);其他類型唔使,快好多。
 *
 * 安全欄(server 再驗一次,唔靠 client):
 *  - 缺貨 (qty<=0) 產品直接剔走;全部缺貨就報錯
 *  - 有成本數據時,售價低過成本就擋(cost 只用嚟檢查,唔會入 prompt)
 *
 * env: ANTHROPIC_API_KEY (同 ai-copy-review 共用)
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; RLS 保護) — 唔可以空, 否則 verifyUser 401 "No API key found"
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

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

// 所有 regex 之前先硬 slice 一刀 — 唔好俾未截斷嘅超長 input 落 regex(quadratic DoS)
const stripHtml = (s: string) =>
  String(s || '').slice(0, 20000)
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// 短欄位:單行化 + 收乾空白 — 防止 title/vendor 內嘅換行扮 prompt 結構(prompt injection)
const cleanLine = (v: any, n: number) =>
  String(v ?? '').slice(0, n * 4).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fence ? fence[1] : text;
  const s = c.indexOf('{');
  const e = c.lastIndexOf('}');
  const slice = s >= 0 && e > s ? c.slice(s, e + 1) : c;
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: '未設定 ANTHROPIC_API_KEY（請喺 Vercel 加）' });

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  // ── 驗證輸入 ──────────────────────────────────────────────
  const postType = String(body?.postType || '') as PostType;
  if (!POST_TYPES.includes(postType)) return res.status(400).json({ error: `未知貼文類型: ${postType}` });

  const tone = (TONES.includes(body?.tone) ? body.tone : 'value') as Tone;
  const lang = (LANGS.includes(body?.lang) ? body.lang : 'yue') as Lang;
  const platforms: Platform[] = Array.isArray(body?.platforms)
    ? body.platforms.filter((p: any) => PLATFORMS.includes(p)).slice(0, 3)
    : [];
  if (platforms.length === 0) return res.status(400).json({ error: '至少揀一個平台' });
  // scenario 一定要喺 whitelist 內 — 防 'constructor' 等 prototype-chain key 混入 prompt
  const scenario = SCENARIO_KEYS.includes(String(body?.scenario)) ? String(body.scenario) : null;
  if (postType === 'scenario' && !scenario) {
    return res.status(400).json({ error: `情境貼要指定有效情境(${SCENARIO_KEYS.join('/')})` });
  }

  const rawProducts: any[] = Array.isArray(body?.products) ? body.products.slice(0, 6) : [];
  if (rawProducts.length === 0) return res.status(400).json({ error: '冇產品資料' });

  // ── 安全欄(server-side 再驗)──────────────────────────────
  // 信任模型:呼叫者係已登入嘅內部員工 dashboard,數據可信度由 client 攞 live 數保證;
  // 呢度嘅檢查係「防止出錯」多過「防惡意」— 惡意員工本身有 Shopify 權限,唔係呢層防到。
  const blockedBelowCost: string[] = [];
  let droppedNoPrice = 0;
  let droppedOos = 0;
  const products: PromptProduct[] = [];
  for (const p of rawProducts) {
    const qty = num(p?.qty);
    if (qty <= 0) { droppedOos++; continue; } // 缺貨直接剔走
    const price = num(p?.price);
    const promoPrice = p?.promoPrice != null && num(p.promoPrice) > 0 ? num(p.promoPrice) : null;
    const effective = promoPrice ?? price;
    if (effective <= 0) { droppedNoPrice++; continue; } // 冇有效價 — 費事出「HK$0」
    const cost = p?.cost != null ? num(p.cost) : 0; // 只用嚟檢查,唔入 prompt
    if (cost > 0 && effective < cost) {
      blockedBelowCost.push(cleanLine(p?.title, 100));
      continue;
    }
    const comparePrice = p?.comparePrice != null ? num(p.comparePrice) : null;
    products.push({
      title: cleanLine(p?.title, 300),
      vendor: cleanLine(p?.vendor, 100),
      productType: cleanLine(p?.productType, 100),
      price,
      // 折扣聲明合規:compare 要真係高過售價先入 prompt
      comparePrice: comparePrice && comparePrice > effective ? comparePrice : null,
      promoPrice,
      promoEndDate: p?.promoEndDate ? cleanLine(p.promoEndDate, 20) : null,
      qty,
      sellingPoints: stripHtml(String(p?.sellingPoints || '')).slice(0, 1500),
    });
  }
  if (products.length === 0) {
    const reason = blockedBelowCost.length > 0
      ? `全部產品被安全欄擋住(售價低過成本): ${blockedBelowCost.join('、')}`
      : droppedNoPrice > 0
        ? '所揀產品冇有效售價 — 請先喺 Shopify 補返價錢'
        : '所揀產品全部缺貨 — 缺貨產品唔可以出貼文';
    return res.status(400).json({ error: reason });
  }

  const prompt = buildPrompt({ postType, products, scenario, tone, lang, platforms });
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  // 只有品牌介紹先要 web_search 搵官方背景
  const tools = postType === 'brand_story'
    ? ([{ type: 'web_search_20260209', name: 'web_search' }] as any)
    : undefined;

  try {
    const messages: any[] = [{ role: 'user', content: prompt }];
    let final: any = null;
    for (let i = 0; i < 4; i++) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        // adaptive thinking 同 output 共用 budget — 3 個平台 variants 嘅 JSON 可以幾長,
        // 4000 有機會中途截斷(表徵係「AI 回覆解析失敗」),俾鬆啲
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        ...(tools ? { tools } : {}),
        messages,
      });
      final = await stream.finalMessage();
      if (final.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: final.content });
        continue;
      }
      break;
    }
    const text = (final?.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    const parsed = extractJson(text);
    const variants = Array.isArray(parsed?.variants) ? parsed.variants : null;
    if (!variants) return res.status(200).json({ ok: false, error: 'AI 回覆解析失敗', raw: text.slice(0, 2000) });
    return res.status(200).json({
      ok: true,
      variants,
      // 俾前端顯示邊啲產品被剔走
      dropped: { belowCost: blockedBelowCost, outOfStock: droppedOos, noPrice: droppedNoPrice },
    });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
