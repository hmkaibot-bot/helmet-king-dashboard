import { supabase } from './supabase';

/**
 * 營銷貼文 — 前端 lib。
 * generateMarketingPost 經 /api/marketing-post (Claude);
 * fetchLiveProduct 經 /api/shopify-product action:get(生成嗰刻攞 live 價 + 已校對簡介)。
 */

export type PostType =
  | 'new_arrival' | 'brand_story' | 'weekly_deal' | 'scenario'
  | 'clearance' | 'price_beat' | 'last_size';
export type Tone = 'value' | 'pro' | 'hype';
export type Lang = 'yue' | 'yue_en';
export type Platform = 'ig_post' | 'ig_story' | 'fb';
export type ScenarioKey = 'rainy' | 'summer' | 'night' | 'touring' | 'beginner';

export interface GenProduct {
  title: string;
  vendor: string;
  productType: string;
  price: number;
  comparePrice: number | null;
  promoPrice: number | null;
  promoEndDate: string | null;
  qty: number;
  sellingPoints: string;
  cost: number | null; // 只俾 server 做安全欄檢查,唔會入 prompt
}

export interface PostVariant {
  platform: Platform;
  headline: string;
  body: string;
  hashtags: string[];
  cta: string;
  altText: string;
}

export interface GenResult {
  variants: PostVariant[];
  dropped: { belowCost: string[]; outOfStock: number; noPrice: number };
}

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('未登入 — 請重新登入 dashboard');
  return token;
}

export async function generateMarketingPost(input: {
  postType: PostType;
  products: GenProduct[];
  scenario: ScenarioKey | null;
  tone: Tone;
  lang: Lang;
  platforms: Platform[];
}): Promise<GenResult> {
  const token = await getToken();
  const resp = await fetch('/api/marketing-post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  let j: any = null;
  try { j = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) throw new Error(j?.error || `生成服務回應 ${resp.status}（部署後先可用）`);
  if (j?.ok === false) throw new Error(j.error || 'AI 生成失敗');
  const variants: PostVariant[] = (Array.isArray(j?.variants) ? j.variants : []).map((v: any) => ({
    platform: v?.platform || 'ig_post',
    headline: String(v?.headline || ''),
    body: String(v?.body || ''),
    hashtags: Array.isArray(v?.hashtags) ? v.hashtags.map(String) : [],
    cta: String(v?.cta || ''),
    altText: String(v?.altText || ''),
  }));
  if (variants.length === 0) throw new Error('AI 冇回覆任何 variant');
  return {
    variants,
    dropped: {
      belowCost: Array.isArray(j?.dropped?.belowCost) ? j.dropped.belowCost : [],
      outOfStock: Number(j?.dropped?.outOfStock) || 0,
      noPrice: Number(j?.dropped?.noPrice) || 0,
    },
  };
}

export interface LiveProduct {
  title: string;
  vendor: string;
  productType: string;
  descriptionText: string; // 已 strip HTML
  // 價格三兄弟一律嚟自「最平嗰個 variant」— 唔准跨 variant 溝數,
  // 否則會出現「min 價配 max 劃線價」嘅誇大折扣(折扣聲明合規)
  price: number | null;
  comparePrice: number | null;
  sku: string; // 同一個 variant 嘅 sku,配對成本用
  totalQty: number;
  imageUrls: string[];
}

const stripHtml = (s: string) =>
  (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/** 生成嗰刻由 Shopify 攞 live 數據;失敗回 null(caller 用 snapshot fallback + 警告) */
export async function fetchLiveProduct(productId: string): Promise<LiveProduct | null> {
  try {
    const token = await getToken();
    const resp = await fetch('/api/shopify-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'get', productId }),
    });
    const j: any = await resp.json().catch(() => null);
    const p = j?.product;
    if (!resp.ok || !p) return null;
    const variants: any[] = Array.isArray(p.variants) ? p.variants : [];
    const priced = variants
      .map(v => ({ price: Number(v.price), compare: Number(v.compareAtPrice), sku: String(v.sku || '') }))
      .filter(v => Number.isFinite(v.price) && v.price > 0);
    // 揀最平嗰個 variant,price/compare/sku 全部用佢一個嘅 — 唔跨 variant 溝數
    const cheapest = priced.length
      ? priced.reduce((a, b) => (b.price < a.price ? b : a))
      : null;
    const totalQty = variants.reduce((s, v) => s + (Number(v.inventoryQuantity) || 0), 0);
    return {
      title: p.title || '',
      vendor: p.vendor || '',
      productType: p.productType || '',
      descriptionText: stripHtml(p.descriptionHtml || '').slice(0, 1500),
      price: cheapest?.price ?? null,
      comparePrice: cheapest && Number.isFinite(cheapest.compare) && cheapest.compare > 0 ? cheapest.compare : null,
      sku: cheapest?.sku ?? '',
      totalQty,
      imageUrls: (Array.isArray(p.media) ? p.media : [])
        .map((m: any) => m?.url)
        .filter(Boolean)
        .slice(0, 4),
    };
  } catch {
    return null;
  }
}


/**
 * 基本模板文案(唔靠 AI)— ANTHROPIC_API_KEY 未設定時嘅 fallback。
 * 規則式:貨名 + 價錢(優惠/原價)+ 語氣 CTA + hashtags,照改照出得。
 */
export function buildTemplateVariants(input: {
  postType: PostType;
  products: GenProduct[];
  scenario: ScenarioKey | null;
  tone: Tone;
  lang: Lang;
  platforms: Platform[];
}): PostVariant[] {
  const { postType, products, scenario, tone, lang, platforms } = input;

  const HEADLINES: Record<PostType, string> = {
    new_arrival: '新品到港 🔥',
    brand_story: `${products[0]?.vendor || ''} 精選推介`,
    weekly_deal: '今期優惠 ⏰',
    scenario:
      scenario === 'rainy' ? '雨季裝備準備好未?☔️' :
      scenario === 'summer' ? '夏日出車裝備 ☀️' :
      scenario === 'night' ? '夜騎裝備推介 🌙' :
      scenario === 'touring' ? '長途 Touring 裝備 🛣' : '新手上路裝備 ✅',
    clearance: '清貨價 最後機會',
    price_beat: '價格保證 抵買之選',
    last_size: '最後碼數 售完即止',
  };

  const fmtP = (n: number) => `HK$${Math.round(n).toLocaleString('en-US')}`;
  const productLine = (g: GenProduct): string => {
    const eff = g.promoPrice ?? g.price;
    let price: string;
    if (g.promoPrice != null && g.promoPrice < g.price) {
      price = `優惠價 ${fmtP(g.promoPrice)}(原價 ${fmtP(g.price)}${g.promoEndDate ? `,至 ${g.promoEndDate.slice(5).replace('-', '/')}` : ''})`;
    } else if (g.comparePrice != null && g.comparePrice > eff) {
      price = `${fmtP(eff)}(原價 ${fmtP(g.comparePrice)})`;
    } else {
      price = fmtP(eff);
    }
    return `▸ ${g.title} — ${price}`;
  };

  const closing =
    tone === 'value' ? '門市現貨,先到先得!' :
    tone === 'pro' ? '規格細節歡迎查詢,專人為你講解。' : '手快有手慢冇 🔥';
  const cta =
    tone === 'value' ? '親臨門市或 DM 訂購' :
    tone === 'pro' ? 'DM 查詢詳細規格' : 'DM 即刻留貨!';
  const enLine = lang === 'yue_en' ? '\nDM us or visit our store to order!' : '';

  const vendors = [...new Set(products.map(g => g.vendor).filter(Boolean))];
  const hashtags = [
    '#頭盔王', '#HelmetKing',
    ...vendors.map(v => '#' + v.replace(/\s+/g, '')),
    '#電單車裝備',
    ...(postType === 'new_arrival' ? ['#新品'] : postType === 'weekly_deal' ? ['#優惠'] : []),
  ];
  const altText = products.map(g => g.title).join('、');

  return platforms.map((platform): PostVariant => {
    if (platform === 'ig_story') {
      const g = products[0];
      return {
        platform,
        headline: HEADLINES[postType],
        body: g ? `${g.title}\n${productLine(g).replace(/^▸ .*? — /, '')}${enLine}` : '',
        hashtags: hashtags.slice(0, 4),
        cta: '⬆️ DM 落單/查詢',
        altText,
      };
    }
    return {
      platform,
      headline: HEADLINES[postType],
      body: `${products.map(productLine).join('\n')}\n\n${closing}${enLine}`,
      hashtags,
      cta,
      altText,
    };
  });
}

/** 組合一個 variant 做可以直接貼落 IG/FB 嘅純文字 */
export function variantToClipboard(v: PostVariant): string {
  const parts = [v.headline, '', v.body];
  if (v.cta) parts.push('', v.cta);
  if (v.hashtags.length) parts.push('', v.hashtags.join(' '));
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  ig_post: 'IG Post',
  ig_story: 'IG Story',
  fb: 'Facebook',
};
export const TONE_LABEL: Record<Tone, string> = { value: '抵買', pro: '專業', hype: '熱血' };
export const LANG_LABEL: Record<Lang, string> = { yue: '廣東話', yue_en: '中英混' };
export const SCENARIO_LABEL: Record<ScenarioKey, string> = {
  rainy: '☔ 雨天出車', summer: '☀️ 夏日出車', night: '🌙 夜騎',
  touring: '🛣️ 長途旅行', beginner: '🔰 新手上路',
};
