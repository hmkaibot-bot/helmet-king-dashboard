/**
 * 營銷貼文 prompt 模板 — 由 api/marketing-post.ts 引用。
 * 檔名以 _ 開頭 → Vercel 唔會當佢係 endpoint。
 *
 * 每種 postType 一個模板;語氣/語言/平台只係共用段落嘅參數。
 * 安全欄由 handler 做,呢度只負責「講清楚規則俾 Claude 聽」。
 */

export type PostType =
  | 'new_arrival'
  | 'brand_story'
  | 'weekly_deal'
  | 'scenario'
  | 'clearance'
  | 'price_beat'
  | 'last_size';

export type Tone = 'value' | 'pro' | 'hype';
export type Lang = 'yue' | 'yue_en';
export type Platform = 'ig_post' | 'ig_story' | 'fb';

export interface PromptProduct {
  title: string;
  vendor: string;
  productType: string;
  price: number;
  comparePrice: number | null;
  promoPrice: number | null;
  promoEndDate: string | null;
  qty: number;
  sellingPoints: string; // 已校對簡介純文字(handler 已 strip HTML + 截長)
}

export const POST_TYPES: PostType[] = [
  'new_arrival', 'brand_story', 'weekly_deal', 'scenario', 'clearance', 'price_beat', 'last_size',
];
export const TONES: Tone[] = ['value', 'pro', 'hype'];
export const LANGS: Lang[] = ['yue', 'yue_en'];
export const PLATFORMS: Platform[] = ['ig_post', 'ig_story', 'fb'];

const TONE_DESC: Record<Tone, string> = {
  value: '「抵買」導向 — 強調價錢、折扣、性價比,口語化,似街坊熟客同你報料',
  pro: '「專業」導向 — 強調規格、認證、安全性,語氣可靠,似店員專業推介',
  hype: '「熱血」導向 — 強調騎行體驗、型格、渴望感,有能量但唔浮誇',
};

const LANG_DESC: Record<Lang, string> = {
  yue: '純廣東話(香港口語,可用 emoji;產品名/品牌名保留原文)',
  yue_en: '廣東話為主、自然夾雜英文(香港人日常 social media 風格)',
};

const SCENARIO_DESC: Record<string, string> = {
  rainy: '雨天出車 — 痛點:濕身、視線差、跣軚。裝備賣點圍繞防水、防霧、抓地',
  summer: '夏日出車 — 痛點:焗、汗、曬。裝備賣點圍繞透氣 mesh、涼感、輕量',
  night: '夜騎 — 痛點:見唔到、被撞。裝備賣點圍繞反光、燈、淺色鏡片',
  touring: '長途旅行 — 痛點:攰、周身痛、行李。裝備賣點圍繞舒適、人體工學、儲物',
  beginner: '新手上路 — 痛點:唔識揀、怕跌。裝備賣點圍繞保護、認證、入門價',
};
// handler 用嚟做 whitelist — 防止 'constructor' 呢類 prototype-chain key 混入 prompt
export const SCENARIO_KEYS = Object.keys(SCENARIO_DESC);

/** 每個 postType 嘅「角度」段落 */
const TYPE_ANGLE: Record<PostType, string> = {
  new_arrival:
    '貼文類型:【新品到港】。開頭要有新鮮感(新貨到/啱啱返貨),核心係 2-3 個最強賣點 + 安全認證(如有提供)。如產品有建議零售價無折扣,唔好提折扣。',
  brand_story:
    '貼文類型:【品牌介紹】。用 web_search 搵呢個品牌嘅官方背景(創立年份/國家/專長領域),寫一段簡短品牌故事,再自然帶出店內呢幾件貨。品牌資料搵唔到就只寫產品,唔好作。',
  weekly_deal:
    '貼文類型:【本周優惠】。折扣數字行先(如有 promoPrice 同 comparePrice 先可以講折扣)。如產品數據有「優惠期至」就必須寫明期限;冇提供期限嘅唔好作一個出嚟。庫存 ≤3 件嘅可以講「最後 N 件」製造合理急迫感。',
  scenario:
    '貼文類型:【情境貼】。開頭先講場景痛點(唔好一開波就 sell 嘢),中段先自然帶出裝備點樣解決,將幾件產品串成一套裝備組合。',
  clearance:
    '貼文類型:【清倉最後機會】。重點係「最後 N 件」(qty 係真數,照用)同清貨價,語氣直接,唔使遮掩係清貨 — 香港人鍾意執平貨。',
  price_beat:
    '貼文類型:【格價擂台】。重點係「香港行貨、門市現貨即買即取,價錢仲要有優勢」。唔好點名講對手,只講自己抵。',
  last_size:
    '貼文類型:【斷碼最後尺寸】。重點係呢個款已斷碼、剩返少量尺碼,呼籲啱 size 嘅人即刻入手。產品數據冇列明具體 size 嘅話,只可以講「剩返最後幾個尺碼」,唔准自己作 size 出嚟。',
};

const PLATFORM_RULES = `## 平台格式
- ig_post: headline ≤ 30 字吸睛;body 200-350 字,開頭 125 字內要有 hook(IG 摺疊位);適量 emoji
- ig_story: headline 一句 punchy;body ≤ 40 字;CTA 明確(「上滑」/「DM 留貨」)
- fb: headline 可略長;body 300-550 字,講故仔講細節;段落之間空行`;

const STYLE_EXAMPLE = `## 風格範文(結構同筆觸參考 — 內容係另一件貨,唔准照抄字句)
呢篇係本店出街效果最好嘅 post 結構,盡量跟:
1. 【】括住嘅有力標題
2. 開場一句定調:「唔只係一件裝備,而係…」— 講件貨背後嘅文化/故事/品牌淵源(只可用產品數據或 web_search 核實到嘅資料,唔准作)
3. 中段:產品細節同亮點,逐樣講(材質/認證/限量/配件)
4. 收尾:講俾邊類人聽(「無論你係…抑或…」),點出收藏/實用價值
5. 最後一句急迫感:「數量有限,售完即止!」
語感示範(節錄):「唔只係一頂裝備,而係一段由 JDM、速度與改裝文化交織而成的故事。…全球限量 700 頂,真正屬於收藏家的聯乘。…無論你係金色 Supra 的擁躉,抑或著迷於日本改裝黃金年代,呢頂都唔係普通聯名帽。數量有限,售完即止!」

## 店舖資料
唔使寫店舖地址/連結/WhatsApp 尾巴 — 系統會喺 copy/send 時自動加,你淨係寫正文。`;

const COMMON_RULES = `## 鐵律(違反即廢)
1. 只可以用「產品數據」入面提供嘅規格、認證、賣點 — 冇提供嘅嘢一律唔准寫,唔准靠估
2. 價錢、折扣、庫存數字照抄數據,唔准四捨五入、唔准誇大
3. 冇 comparePrice 或 promoPrice 嘅產品,唔准出現「原價/劃線價/折」字眼
4. hashtags: 2-3 個品牌/產品類 + 2-3 個香港電單車社群類(例 #香港電單車 #hkbiker),唔好 hashtag 海
5. 語氣自然似真人小編 — 避免「快啲嚟啦」「唔好錯過啦」呢類 AI 味疊句
6. 每個平台 variant 嘅內容要有分別,唔係同一段嘢裁短`;

export function buildPrompt(opts: {
  postType: PostType;
  products: PromptProduct[];
  scenario: string | null;
  tone: Tone;
  lang: Lang;
  platforms: Platform[];
}): string {
  const { postType, products, scenario, tone, lang, platforms } = opts;

  const productLines = products.map((p, i) => {
    const parts = [
      `產品${i + 1}: ${p.title}`,
      `品牌: ${p.vendor || '(未知)'} | 分類: ${p.productType || '(未知)'}`,
      `現售價: HK$${p.price}`,
    ];
    if (p.comparePrice && p.comparePrice > p.price) parts.push(`建議零售價: HK$${p.comparePrice}`);
    if (p.promoPrice) parts.push(`推廣價: HK$${p.promoPrice}`);
    if (p.promoEndDate) parts.push(`優惠期至: ${p.promoEndDate}`);
    parts.push(`庫存: ${p.qty} 件`);
    if (p.sellingPoints) parts.push(`賣點(已核實,只可用呢度嘅內容): ${p.sellingPoints}`);
    return parts.join('\n');
  }).join('\n\n');

  const scenarioLine =
    postType === 'scenario' && scenario && Object.prototype.hasOwnProperty.call(SCENARIO_DESC, scenario)
      ? `\n## 情境\n${SCENARIO_DESC[scenario]}\n`
      : '';

  const variantsSpec = platforms
    .map(pl => `{"platform":"${pl}","headline":"...","body":"...","hashtags":["#..."],"cta":"...","altText":"圖片無障礙描述"}`)
    .join(', ');

  return `你係香港一間電單車裝備(頭盔/手套/騎士服/配件)零售店嘅 social media 小編,中英文俱佳,好熟香港車友文化。

${TYPE_ANGLE[postType]}

## 風格
- 語氣:${TONE_DESC[tone]}
- 語言:${LANG_DESC[lang]}
${scenarioLine}
## 產品數據(全部真實)
${productLines}

${PLATFORM_RULES}

${STYLE_EXAMPLE}

${COMMON_RULES}

**最後只輸出一個 JSON object**(前後唔好有任何其他文字),格式:
{"variants": [${variantsSpec}]}`;
}
