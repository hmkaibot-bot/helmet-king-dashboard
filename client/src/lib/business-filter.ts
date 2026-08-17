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
  // 26Pack 套票係 26King 嗰邊嘅產品(老闆確認唔係零售)
  /26\s*KING|26\s*PACK/i,
  /現貨車|新車|舊車|二手車|易手車|賣車|寄賣|回收|換車|銀行按揭|上會/,
  /TRADE\s*-?\s*IN/i,
  /租車|租借|RENTAL|RENT\s*A?\s*BIKE/i,
  /電單車出售|車行/,
  // 車房(維修/保養服務)— 老闆:「車房個d我都唔需要」。
  // 洗車用品係零售商品,唔好誤中 →「洗車」後面唔係「用品」先算車房
  /車房|維修|保養|驗車|洗車(?!用品)/,
  // 老闆確認唔係零售:EK 鏈條(換鏈服務)、預約(車房排期)、MICHELIN(呔+安裝)
  /鏈條|EK\s*鏈|預約/,
  /MICHELIN|米芝蓮/i,
  // 自駕團/旅行團(老闆確認唔係零售)
  /自駕團|自駕遊|西藏團|蒙古團|旅行團/,
  // 車房服務(2026-08 老闆:呢類經常俾人當咗零售)——
  // 「愛車保養/回復狀態」呢種文青寫法冇「車房」二字,一樣係車房 post
  /愛車|座駕|回復.{0,4}狀態|換油|機油|波箱油|迫力油|逼力油|火咀|散熱|水箱|皮帶|避震|排氣|尾鼓|尾牙|製動|軚|呔(?!帽)/,
  /維修部|服務部|試業優惠|免人工|工時|師傅/,
  // 安裝/改裝服務(唔係賣件貨,係賣個安裝)
  /改裝|加裝|安裝|裝嵌|套餐(?=.{0,6}(安裝|升級|服務))|升級套餐/,
  /OHLINS|GILLES\s*TOOLING|VENTZ/i,
  // 車款型號(廣告名有呢啲多數係賣車 post;零售裝備廣告名通常係頭盔/品牌)。
  // R1 剔走 — Scorpion EXO-R1 係頭盔,會誤中;R3/R7 保留(Yamaha 熱門現貨車款)。
  /\bGSX\b|GSX-?\d|\bNMAX\b|\bXMAX\b|\bPCX\b|\bADV\s?1\d0\b|\bCBR?\s?\d{3}\b|\bMT-?\d{1,2}\b|\bR[37]\b|\bZ\s?900\b|\bZX-?\d+\b|NINJA|\bREBEL\b|\bCT125\b|\bMSX\b|\bDAX\b|\bMONKEY\b|\bXSR\b|\bTMAX\b|\bNVX\b|\bAEROX\b|\bFORCE\s?155\b|TENERE|VESPA/i,
];

export type Business = 'retail' | 'nonretail';

/** 零售正面訊號 — 有品牌名/裝備類字眼,先算「認得出係零售」 */
const RETAIL_PATTERNS: RegExp[] = [
  /頭盔|全罩|半罩|頭盔王|電單車服|騎士服|手套|護具|雨衣|風鏡|鏡片|眼鏡|背囊|袋|靴|鞋|對講/,
  /SHOEI|ARAI|SCORPION|BILMOLA|AGV|NOLAN|SHARK|LS2|CABERG|KUSHITANI|ROUGH\s*(AND|&)\s*ROAD|FURYGAN|ALPINESTARS|GAERNE|ELEVEIT|FIVE|MODER|FETURE|HILX|CARDO|SENA|INSTA360|DJI|FUJIKURABU|NANKAI|KOMINE|RS\s*TAICHI/i,
  /HELMET|GLOVE|JACKET|BOOT|VISOR|GEAR/i,
];

/**
 * 分類信心:
 *  'nonretail' — 認到係非零售(車房/賣車/租車/團)
 *  'retail'    — 認到係零售(有品牌或裝備字眼)
 *  'unknown'   — 兩樣都認唔到 → 頁面會叫老闆自己分,唔好靜靜當零售
 */
export function classifyConfidence(name: string | null | undefined): 'retail' | 'nonretail' | 'unknown' {
  const n = String(name || '');
  if (NONRETAIL_PATTERNS.some((rx) => rx.test(n))) return 'nonretail';
  if (RETAIL_PATTERNS.some((rx) => rx.test(n))) return 'retail';
  return 'unknown';
}

/** campaign 有冇人手分過類(有 override 就唔使再問老闆) */
export function hasBusinessOverride(c: { business?: string | null }): boolean {
  return c.business === 'retail' || c.business === 'nonretail';
}


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
 * null = 兩樣都認唔到(多數係 SleekFlow 未回傳欄位嘅早期 webhook 行)—— 唔當零售,
 * 寧願少計都唔好混入其他業務(老闆 2026-07-31 確認)。
 * tour(自駕團)都唔算零售 — 老闆 2026-07-23 確認。
 */
export function isRetailInquiry(e: { business?: string | null }): boolean {
  return e.business === 'retail';
}

export const BUSINESS_LABELS: Record<string, string> = {
  retail: '零售',
  '26king': '26King 賣車',
  rental: '租車',
  garage: '車房',
  tour: '自駕團',
  nonretail: '非零售',
};

// ── 部門細分(廣告 post 牆用)────────────────────────────────────────────
// 老闆 2026-08-04:「廣告 Post 一覽旁我想分返開唔同部門」。
// 比 retail/nonretail 細:通告/尻片/工作坊呢啲 post 唔想溝埋喺零售廣告度睇。
// 淨係睇 campaign 名+廣告名(唔睇文案 — 零售文案成日有「預約試戴」會誤中車房)。

export type Dept =
  | 'retail' | 'garage' | 'bikesale' | 'tour' | 'rental'
  | 'video' | 'notice' | 'workshop' | 'other';

export const DEPT_LABELS: Record<Dept, string> = {
  retail: '零售',
  garage: '車房',
  bikesale: '賣車',
  tour: '旅行團',
  rental: '租車',
  video: '尻片',
  notice: '通告',
  workshop: '工作坊',
  other: '其他',
};

export const DEPT_ORDER: Dept[] = [
  'retail', 'garage', 'bikesale', 'tour', 'rental', 'video', 'notice', 'workshop', 'other',
];

// 次序有意思:specific 行先(工作坊/通告/尻片),旅行團行喺租車前
// (團名可能夾住 Rental819),對唔中任何 pattern 先當零售。
const DEPT_PATTERNS: Array<[RegExp, Dept]> = [
  [/工作坊|WORKSHOP|體驗班|講座|課程/i, 'workshop'],
  [/通告|公告|通知|營業時間|休息|放假|颱風|暴雨|搬遷|停業|NOTICE|ANNOUNCEMENT/i, 'notice'],
  [/尻片|遊車河|短片|新片|影片|拍片|VLOG|YOUTUBE|\bYT\b/i, 'video'],
  [/自駕團|自駕遊|旅行團|導賞團|白川鄉|昇龍道|西藏團|蒙古團/i, 'tour'],
  // 偈油/換呔呢啲係車房服務 promo(老闆 2026-08-04:「仲有車房POST係零售」)
  [/車房|維修|保養|驗車|洗車(?!用品)|鏈條|EK\s*鏈|預約|MICHELIN|米芝蓮|偈油|機油|波箱油|換呔|補呔|輪呔|BEL-?RAY|愛車回復|回復最佳狀態/i, 'garage'],
  // 26Pack 套票係 26King 嗰邊嘅產品(老闆確認)→ 跟賣車部門
  [/26\s*KING|26\s*PACK/i, 'bikesale'],
  [/現貨車|新車|舊車|二手車|易手車|賣車|寄賣|回收|換車|銀行按揭|上會|電單車出售|車行/, 'bikesale'],
  [/TRADE\s*-?\s*IN/i, 'bikesale'],
  // 車款型號(同 NONRETAIL_PATTERNS 同一套;R1 剔走 — Scorpion EXO-R1 係頭盔)
  [/\bGSX\b|GSX-?\d|\bNMAX\b|\bXMAX\b|\bPCX\b|\bADV\s?1\d0\b|\bCBR?\s?\d{3}\b|\bMT-?\d{1,2}\b|\bR[37]\b|\bZ\s?900\b|\bZX-?\d+\b|NINJA|\bREBEL\b|\bCT125\b|\bMSX\b|\bDAX\b|\bMONKEY\b|\bXSR\b|\bTMAX\b|\bNVX\b|\bAEROX\b|\bFORCE\s?155\b|TENERE|VESPA/i, 'bikesale'],
  [/租車|租借|RENTAL|RENT\s*A?\s*BIKE/i, 'rental'],
  [/招聘|請人|HIRING|JOIN\s*US/i, 'other'],
];

/**
 * 廣告歸邊個部門 — campaign 業務 override(meta_campaigns.business)優先:
 * override 話 retail 就 retail;話 nonretail 但 pattern 認唔出邊瓣 → 其他。
 */
export function adDepartment(name: string | null | undefined, override?: string | null): Dept {
  if (override === 'retail') return 'retail';
  const n = String(name || '');
  const hit = DEPT_PATTERNS.find(([rx]) => rx.test(n));
  const dept = hit ? hit[1] : 'retail';
  if (override === 'nonretail' && dept === 'retail') return 'other';
  return dept;
}
