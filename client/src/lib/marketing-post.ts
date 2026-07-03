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
  dropped: { belowCost: string[]; outOfStock: number };
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
    },
  };
}

export interface LiveProduct {
  title: string;
  vendor: string;
  productType: string;
  descriptionText: string; // 已 strip HTML
  price: number | null;        // 最平 variant
  comparePrice: number | null; // 最高 compareAtPrice
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
    const prices = variants.map(v => Number(v.price)).filter(n => Number.isFinite(n) && n > 0);
    const compares = variants.map(v => Number(v.compareAtPrice)).filter(n => Number.isFinite(n) && n > 0);
    const totalQty = variants.reduce((s, v) => s + (Number(v.inventoryQuantity) || 0), 0);
    return {
      title: p.title || '',
      vendor: p.vendor || '',
      productType: p.productType || '',
      descriptionText: stripHtml(p.descriptionHtml || '').slice(0, 1500),
      price: prices.length ? Math.min(...prices) : null,
      comparePrice: compares.length ? Math.max(...compares) : null,
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
