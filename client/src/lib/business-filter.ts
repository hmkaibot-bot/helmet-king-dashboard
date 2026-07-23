/**
 * 業務分流 — 老闆「淨係要睇零售」。
 *
 * 同一個 Meta 廣告戶口 / SleekFlow workspace 其實孭住三盤生意:
 *   頭盔王零售(裝備/頭盔)、26King 賣車(現貨車/回收/寄賣)、租車。
 * 呢度負責將 campaign / 查詢分返落自己盤數。
 *
 * Campaign 分類:人手 override(meta_campaigns.business)優先,
 * 冇就按名稱關鍵字自動分 — 分錯可以喺活動表撳個業務 chip 一下反轉,
 * override 入 DB 之後以後都記得。
 */

// 非零售(賣車/租車)關鍵字 — 中英文都有;bike 型號淨係喺廣告名出現先算
const NONRETAIL_PATTERNS: RegExp[] = [
  /26\s*KING/i,
  /現貨車|新車|舊車|二手車|易手車|賣車|寄賣|回收|換車|銀行按揭|上會/,
  /TRADE\s*-?\s*IN/i,
  /租車|租借|RENTAL|RENT\s*A?\s*BIKE/i,
  /電單車出售|車行/,
  // 車房(維修/保養服務)— 老闆:「車房個d我都唔需要」。
  // 洗車用品係零售商品,唔好誤中 →「洗車」後面唔係「用品」先算車房
  /車房|維修|保養|驗車|洗車(?!用品)/,
  // 車款型號(廣告名有呢啲多數係賣車 post;零售裝備廣告名通常係頭盔/品牌)。
  // R1 剔走 — Scorpion EXO-R1 係頭盔,會誤中;R3/R7 保留(Yamaha 熱門現貨車款)。
  /\bGSX\b|GSX-?\d|\bNMAX\b|\bXMAX\b|\bPCX\b|\bADV\s?1\d0\b|\bCBR?\s?\d{3}\b|\bMT-?\d{1,2}\b|\bR[37]\b|\bZ\s?900\b|\bZX-?\d+\b|NINJA|\bREBEL\b|\bCT125\b|\bMSX\b|\bDAX\b|\bMONKEY\b|\bXSR\b|\bTMAX\b|\bNVX\b|\bAEROX\b|\bFORCE\s?155\b|TENERE|VESPA/i,
];

export type Business = 'retail' | 'nonretail';

/** 按 campaign 名稱自動分類(人手 override 由 caller 疊上去) */
export function classifyCampaignName(name: string | null | undefined): Business {
  const n = String(name || '');
  return NONRETAIL_PATTERNS.some((rx) => rx.test(n)) ? 'nonretail' : 'retail';
}

/** campaign 嘅有效業務:DB override 優先,冇就自動分類 */
export function campaignBusiness(c: { campaign_name?: string | null; business?: string | null }): Business {
  if (c.business === 'retail' || c.business === 'nonretail') return c.business;
  return classifyCampaignName(c.campaign_name);
}

/**
 * 查詢事件係咪零售 — inquiry_events.business 判定次序:
 * 1) SleekFlow 同事分隊(assignedTeam:Retail/26KING/Garage/RentalbikeHK/Tour)
 *    — 客人搵零售線但問車/維修嗰批,靠同事 triage 先分得出
 * 2) 冇分隊就按條線(零售 Main WhatsApp / @helmetking_hk / 頭盔王 FB = retail)
 * null = 舊行/未識別 — 當零售計。
 * tour(自駕團)暫時當零售 — 團係頭盔王品牌搞,老闆話唔要可以再拆。
 */
export function isRetailInquiry(e: { business?: string | null }): boolean {
  return !e.business || e.business === 'retail' || e.business === 'tour';
}

export const BUSINESS_LABELS: Record<string, string> = {
  retail: '零售',
  '26king': '26King 賣車',
  rental: '租車',
  garage: '車房',
  tour: '自駕團',
  nonretail: '非零售',
};
