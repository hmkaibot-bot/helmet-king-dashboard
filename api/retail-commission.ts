/**
 * Vercel serverless — 零售佣金計算(門市全職同事)。
 * 數據源:Shopify Analytics / ShopifyQL(staff_member_name 等 attribution 只喺呢層有,
 * 唔喺 order 物件)。需要 app token 有 read_reports scope。
 *
 * 規則(2026-07 與老闆 confirm):
 *  ① 門市月結 net_sales ≥ $1,400,000 → 每位全職 +$1,000
 *  ② 代理品牌(9 隻)當月 net 總額分級:<100k→1% / 100k–<130k→1.5% / ≥130k→2%(rate × 全額)
 *  ③ 非代理品牌當月 net 總額 ≥ $200,000 → 全額 × 0.5%(唔夠 = $0)
 *  ④ 平均件數 = (net_items_sold 扣走 DRINK/beverages/膠袋) ÷ 該同事訂單數
 *     ≥2.6→$1,100 / ≥2.2→$900 / ≥1.8→$700
 *  ⑤ 只計全職:Kenny Chu / Dicky Leung / Zoe Lau / Bean Tang
 *  ⑥ Assisting staff:order 有 assisting 就將筆數計落 assisting(冇就計 primary)
 *
 * 全部以 NET SALES 計。門市 = pos_location_name = 'Helmet King Shop'。
 *
 * env: SHOPIFY_SHOP + (SHOPIFY_CLIENT_ID/SECRET 或 SHOPIFY_ADMIN_TOKEN), scope 需 read_reports
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const API_VERSION = '2026-07';

const SHOPIFY_READY =
  !!SHOPIFY_SHOP && (!!SHOPIFY_TOKEN || (!!SHOPIFY_CLIENT_ID && !!SHOPIFY_CLIENT_SECRET));

export const config = { maxDuration: 60 };

// ── 規則常數 ─────────────────────────────────────────────────────────────────
const POS_LOCATION = 'Helmet King Shop';
const STORE_TARGET = 1_400_000;
const STORE_BONUS = 1_000;
const NONAGENT_TARGET = 200_000;
const NONAGENT_RATE = 0.005;
const EXCLUDE_TITLES = ['DRINK', 'beverages', 'Enhanced Plastic Shopping Bag Charging Scheme'];

const AGENT_VENDORS = new Set([
  'SCORPION', 'FETURE', 'MODER', 'JOHN DOE', 'PANDO',
  'ROUGH AND ROAD', 'ELEVEIT', 'FURYGAN', 'HELSTONS',
]);

// Shopify staff 全名 → dashboard 顯示 code。只呢 4 位納入 scheme。
const FULLTIME: Record<string, string> = {
  'Kenny Chu': 'KENNY',
  'Dicky Leung': 'DICKY',
  'Zoe Lau': 'ZOE',
  'Bean Tang': 'BEAN',
};

function agentTierRate(total: number): number {
  if (total < 100_000) return 0.01;
  if (total < 130_000) return 0.015; // 100k ≤ x < 130k
  return 0.02;                        // ≥ 130k
}
function avgItemsBonus(avg: number): number {
  if (avg >= 2.6) return 1100;
  if (avg >= 2.2) return 900;
  if (avg >= 1.8) return 700;
  return 0;
}

/**
 * ⑥ 有 assisting 就歸 assisting,冇就歸 primary(跟足規則字面)。
 * 只保留 4 位全職;assisting 若係非全職(例如 HMK Admin)→ 返 null(剔出)。
 * 想改成「assisting 唔係全職時保留 primary」只需改呢一個 function。
 */
function effectiveStaffCode(primary: string, assisting: string): string | null {
  const eff = (assisting && assisting.trim()) ? assisting.trim() : (primary || '').trim();
  return FULLTIME[eff] ?? null;
}

// ── auth / shopify ───────────────────────────────────────────────────────────
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

const QL_GRAPHQL = `query RetailCommission($q: String!) {
  shopifyqlQuery(query: $q) {
    parseErrors
    tableData { columns { name } rows }
  }
}`;

interface QLTable { cols: Record<string, number>; rows: any[][]; }

async function runQL(ql: string): Promise<QLTable> {
  const accessToken = await getShopifyToken();
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: QL_GRAPHQL, variables: { q: ql } }),
  });
  const j = await r.json().catch(() => ({} as any));
  if (!r.ok || j.errors) {
    const detail = j?.errors ? JSON.stringify(j.errors) : `HTTP ${r.status}`;
    // read_reports scope 缺失通常喺呢度以 ACCESS_DENIED 出現
    throw new Error(`ShopifyQL 請求失敗 — ${detail}`);
  }
  const resp = j?.data?.shopifyqlQuery;
  if (resp?.parseErrors?.length) throw new Error(`ShopifyQL parse error: ${resp.parseErrors.join('; ')}`);
  const td = resp?.tableData;
  const cols: Record<string, number> = {};
  (td?.columns || []).forEach((c: any, i: number) => { cols[c.name] = i; });
  const rows: any[][] = Array.isArray(td?.rows) ? td.rows : [];
  return { cols, rows };
}

const money = (v: any): number => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int = (v: any): number => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

// ── 日期 ─────────────────────────────────────────────────────────────────────
function hkTodayYM(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // HKT
  return d.toISOString().slice(0, 7);
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 係 1-based
}

interface StaffAgg {
  code: string;
  agentTotal: number;
  nonAgentTotal: number;
  orders: number;
  items: number;
  brands: Map<string, { net: number; agent: boolean }>;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SHOPIFY_READY)
    return res.status(500).json({ error: 'Shopify 未設定(Vercel 需 SHOPIFY_SHOP + SHOPIFY_CLIENT_ID/SECRET,scope 要 read_reports)' });

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });

  let body: any = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  // month 'YYYY-MM';預設當月
  const monthRaw = String(body?.month || '').match(/^\d{4}-\d{2}$/) ? String(body.month) : hkTodayYM();
  const [y, mo] = monthRaw.split('-').map(Number);
  const start = `${monthRaw}-01`;
  const isCurrent = monthRaw === hkTodayYM();
  const endClause = isCurrent ? 'today' : `${monthRaw}-${String(lastDayOfMonth(y, mo)).padStart(2, '0')}`;
  const WHERE_POS = `WHERE pos_location_name = '${POS_LOCATION}'`;
  const PERIOD = `SINCE ${start} UNTIL ${endClause}`;
  const excludeClause = EXCLUDE_TITLES.map(t => `AND product_title != '${t.replace(/'/g, "''")}'`).join(' ');

  try {
    const [qStore, qBrand, qOrders, qItems] = await Promise.all([
      runQL(`FROM sales SHOW net_sales ${WHERE_POS} ${PERIOD}`),
      runQL(`FROM sales SHOW net_sales GROUP BY staff_member_name, assisting_staff_member_name, product_vendor ${WHERE_POS} ${PERIOD}`),
      runQL(`FROM sales SHOW orders GROUP BY staff_member_name, assisting_staff_member_name ${WHERE_POS} ${PERIOD}`),
      runQL(`FROM sales SHOW net_items_sold GROUP BY staff_member_name, assisting_staff_member_name ${WHERE_POS} ${excludeClause} ${PERIOD}`),
    ]);

    // 門市總額
    const storeTotal = qStore.rows.reduce((s, r) => s + money(r[qStore.cols['net_sales']]), 0);
    const storeHit = storeTotal >= STORE_TARGET;

    // 初始化 4 位全職
    const agg = new Map<string, StaffAgg>();
    for (const code of Object.values(FULLTIME)) {
      agg.set(code, { code, agentTotal: 0, nonAgentTotal: 0, orders: 0, items: 0, brands: new Map() });
    }

    // ② + ③ 品牌 net(reattribute 落 effective staff)
    {
      const { cols, rows } = qBrand;
      for (const r of rows) {
        const code = effectiveStaffCode(r[cols['staff_member_name']], r[cols['assisting_staff_member_name']]);
        if (!code) continue;
        const vendor = String(r[cols['product_vendor']] ?? '').trim();
        const net = money(r[cols['net_sales']]);
        const a = agg.get(code)!;
        const isAgent = AGENT_VENDORS.has(vendor.toUpperCase());
        if (isAgent) a.agentTotal += net; else a.nonAgentTotal += net;
        const b = a.brands.get(vendor) ?? { net: 0, agent: isAgent };
        b.net += net;
        a.brands.set(vendor, b);
      }
    }
    // ④ 訂單數(分母,唔扣 title)
    {
      const { cols, rows } = qOrders;
      for (const r of rows) {
        const code = effectiveStaffCode(r[cols['staff_member_name']], r[cols['assisting_staff_member_name']]);
        if (!code) continue;
        agg.get(code)!.orders += int(r[cols['orders']]);
      }
    }
    // ④ 件數(分子,已扣 DRINK/beverages/膠袋)
    {
      const { cols, rows } = qItems;
      for (const r of rows) {
        const code = effectiveStaffCode(r[cols['staff_member_name']], r[cols['assisting_staff_member_name']]);
        if (!code) continue;
        agg.get(code)!.items += int(r[cols['net_items_sold']]);
      }
    }

    const staff = Array.from(agg.values()).map(a => {
      const agentRate = agentTierRate(a.agentTotal);
      const agentComm = a.agentTotal * agentRate;
      const nonAgentComm = a.nonAgentTotal >= NONAGENT_TARGET ? a.nonAgentTotal * NONAGENT_RATE : 0;
      // 平均件數 4捨5入到 1 個小數位,tier(1.8/2.2/2.6)以呢個 rounded 值判斷(同老闆 sheet 一致)
      const avgItems = a.orders > 0 ? Math.round((a.items / a.orders) * 10) / 10 : 0;
      const avgBonus = avgItemsBonus(avgItems);
      const targetBonus = storeHit ? STORE_BONUS : 0;
      const total = agentComm + nonAgentComm + avgBonus + targetBonus;
      const brands = Array.from(a.brands.entries())
        .map(([vendor, v]) => ({ vendor, net: v.net, agent: v.agent }))
        .sort((x, z) => z.net - x.net);
      return {
        code: a.code,
        agentTotal: a.agentTotal, agentRate, agentComm,
        nonAgentTotal: a.nonAgentTotal, nonAgentComm, nonAgentTargetHit: a.nonAgentTotal >= NONAGENT_TARGET,
        items: a.items, orders: a.orders, avgItems, avgBonus,
        targetBonus, total, brands,
      };
    });

    return res.status(200).json({
      ok: true,
      month: monthRaw,
      period: { start, end: isCurrent ? 'today' : endClause, isCurrentMonth: isCurrent },
      store: { total: storeTotal, target: STORE_TARGET, hit: storeHit, bonus: STORE_BONUS },
      staff,
    });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
