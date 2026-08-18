/**
 * Vercel serverless — 廣告 post 牆:每個廣告嘅 post 圖 + 文案 + 成效。
 * 查詢與轉換頁用:左邊見到自己個 IG/FB 廣告 post 樣,右邊對住數據。
 *
 * Meta /act/ads 一鋪攞 creative(thumbnail_url 512px + body/title)同該
 * date preset 嘅 insights。token 同 meta-campaign 一樣:env 優先,
 * 冇就用呼叫者 JWT 讀 Supabase app_config(zero-config)。
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const META_TOKEN_ENV = process.env.META_ACCESS_TOKEN || '';
const AD_ACCOUNT = process.env.META_AD_ACCOUNT || 'act_1632943856935233';
const GRAPH = 'https://graph.facebook.com/v25.0';

export const config = { maxDuration: 30 };

const PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'last_90d', 'maximum', 'this_month']);
const MSG_KEYS = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.total_messaging_connection',
];

let _metaTokCache = '';
async function getMetaToken(userJwt: string): Promise<string> {
  if (META_TOKEN_ENV) return META_TOKEN_ENV;
  if (_metaTokCache) return _metaTokCache;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_config?key=eq.META_ACCESS_TOKEN&select=value`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${userJwt}` } }
    );
    const rows: any = await r.json().catch(() => []);
    const v = Array.isArray(rows) && rows[0]?.value ? String(rows[0].value) : '';
    if (v) _metaTokCache = v;
    return v;
  } catch {
    return '';
  }
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

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// warm serverless instance 內嘅 response cache(key = 日期範圍)
const WALL_CACHE_TTL = 10 * 60 * 1000;
const _wallCache = new Map<string, { t: number; body: any }>();

// page token map(page id → token)— 用嚟讀 post 原相;1 小時 cache
let _pageTokCache: { t: number; map: Record<string, string> } | null = null;
async function getPageTokens(metaToken: string): Promise<Record<string, string>> {
  if (_pageTokCache && Date.now() - _pageTokCache.t < 60 * 60 * 1000) return _pageTokCache.map;
  try {
    const r = await fetch(
      `${GRAPH}/me/accounts?fields=id,access_token&limit=100&access_token=${encodeURIComponent(metaToken)}`
    );
    const j: any = await r.json().catch(() => ({}));
    const map: Record<string, string> = {};
    for (const p of j?.data ?? []) if (p?.id && p?.access_token) map[String(p.id)] = String(p.access_token);
    if (Object.keys(map).length) _pageTokCache = { t: Date.now(), map };
    return map;
  } catch {
    return {};
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });

  const metaToken = await getMetaToken(token);
  if (!metaToken)
    return res.status(500).json({ error: '搵唔到 Meta token — env 同 Supabase app_config 都未設定' });

  let body: any = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const preset = PRESETS.has(String(body?.datePreset)) ? String(body.datePreset) : 'last_30d';
  // 精確日期範圍優先(老闆用日歷自訂)— preset 係由「今日」倒數,對唔準自訂範圍
  const RX_DATE = /^\d{4}-\d{2}-\d{2}$/;
  let since = String(body?.since ?? '');
  let until = String(body?.until ?? '');
  const useRange = RX_DATE.test(since) && RX_DATE.test(until);
  if (useRange && since > until) [since, until] = [until, since];

  // 10 分鐘 cache — Meta ads 帳戶有 rate limit,狂 refresh/轉日期會俾佢落閘
  const cacheKey = useRange ? `${since}|${until}` : `preset:${preset}`;
  const hit = _wallCache.get(cacheKey);
  if (hit && Date.now() - hit.t < WALL_CACHE_TTL) return res.status(200).json(hit.body);

  try {
    const insightsField = useRange
      ? `insights.time_range({"since":"${since}","until":"${until}"}){spend,impressions,reach,clicks,actions}`
      : `insights.date_preset(${preset}){spend,impressions,reach,clicks,actions}`;
    const fields =
      'name,campaign_id,effective_status,created_time,adset{start_time,end_time,optimization_goal},' +
      'creative.thumbnail_width(1080).thumbnail_height(1080){thumbnail_url,image_url,body,title,object_story_spec,effective_object_story_id},' +
      insightsField;
    const ads: any[] = [];
    let url = `${GRAPH}/${AD_ACCOUNT}/ads?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(metaToken)}`;
    for (let page = 0; page < 5 && url; page++) {
      const r = await fetch(url);
      const j: any = await r.json().catch(() => ({}));
      if (j?.error) throw new Error(`Meta API: ${j.error.message || JSON.stringify(j.error)}`);
      ads.push(...(j?.data ?? []));
      url = j?.paging?.next ?? '';
    }

    // dark post / link ad 嘅 creative 圖係裁過嘅(特賣場原圖其實 1080×1350)—
    // 用 image_hash 去 adimages 攞返當初上載嘅原檔
    const hashes = new Set<string>();
    for (const a of ads) {
      const s = a?.creative?.object_story_spec;
      const h = s?.link_data?.image_hash || s?.photo_data?.image_hash;
      if (h) hashes.add(String(h));
    }
    const urlByHash: Record<string, string> = {};
    try {
      const list = [...hashes];
      for (let i = 0; i < list.length; i += 40) {
        const r = await fetch(
          `${GRAPH}/${AD_ACCOUNT}/adimages?fields=hash,url,width&hashes=${encodeURIComponent(JSON.stringify(list.slice(i, i + 40)))}&access_token=${encodeURIComponent(metaToken)}`
        );
        const j: any = await r.json().catch(() => ({}));
        for (const img of j?.data ?? []) if (img?.hash && img?.url) urlByHash[String(img.hash)] = String(img.url);
      }
    } catch {
      /* 攞唔到原檔就照用 creative 嗰張 */
    }

    const rows = ads
      .map((a) => {
        const ins = a?.insights?.data?.[0];
        if (!ins) return null; // 該時段冇投放
        const acts: Record<string, number> = {};
        for (const x of ins.actions ?? []) acts[String(x.action_type)] = num(x.value);
        const inquiries = MSG_KEYS.reduce((s, k) => (acts[k] != null && s === 0 ? acts[k] : s), 0);
        const story = a?.creative?.object_story_spec;
        const copy =
          a?.creative?.body ||
          story?.link_data?.message ||
          story?.video_data?.message ||
          story?.photo_data?.message ||
          '';
        return {
          adId: String(a.id ?? ''),
          name: String(a.name ?? ''),
          campaignId: String(a.campaign_id ?? ''),
          status: String(a.effective_status ?? ''),
          storyId: String(a?.creative?.effective_object_story_id ?? ''),
          goal: String(a?.adset?.optimization_goal ?? ''), // ad 類型(互動/對話/流量…)
          // 投放期:adset 排程優先,冇就用廣告建立日;end null = 冇設結束日
          start: String(a?.adset?.start_time || a?.created_time || '').slice(0, 10) || null,
          end: a?.adset?.end_time ? String(a.adset.end_time).slice(0, 10) : null,
          // 大圖優先次序:上載原檔(hash)→ creative 原圖 → 片封面 → link 圖 → thumbnail
          image:
            (() => {
              const h = story?.link_data?.image_hash || story?.photo_data?.image_hash;
              return (h && urlByHash[String(h)]) || '';
            })() ||
            a?.creative?.image_url ||
            story?.video_data?.image_url ||
            story?.link_data?.picture ||
            a?.creative?.thumbnail_url ||
            null,
          origImg: !!((story?.link_data?.image_hash || story?.photo_data?.image_hash) && urlByHash[String(story?.link_data?.image_hash || story?.photo_data?.image_hash)]),
          copy: String(copy).slice(0, 400),
          spend: num(ins.spend),
          impressions: num(ins.impressions),
          reach: num(ins.reach),
          clicks: num(ins.clicks),
          inquiries,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x && (x.spend > 0 || x.impressions > 0));

    // post 原相(唔裁邊):creative thumbnail 一定係方形裁圖,所以用 page token
    // 直接讀返個 post 嘅 attachment 圖(720+ 原比例)。冇相 post 會回 page 頭像
    // (200×200 / t39.30808-1)— 濾走,維持 creative 嗰張。
    try {
      const pageToks = await getPageTokens(metaToken);
      const byPage = new Map<string, string[]>();
      for (const r of rows) {
        const m = /^(\d+)_\d+$/.exec(r.storyId);
        if (m && pageToks[m[1]]) {
          if (!byPage.has(m[1])) byPage.set(m[1], []);
          byPage.get(m[1])!.push(r.storyId);
        }
      }
      const picByStory: Record<string, string> = {};
      const PIC_FIELDS = encodeURIComponent('full_picture,attachments{media{image}}');
      for (const [pageId, ids] of byPage) {
        const tok = pageToks[pageId];
        const uniq = [...new Set(ids)];
        for (let i = 0; i < uniq.length; i += 50) {
          const batch = uniq.slice(i, i + 50);
          const r = await fetch(
            `${GRAPH}/?ids=${batch.join(',')}&fields=${PIC_FIELDS}&access_token=${encodeURIComponent(tok)}`
          );
          const j: any = await r.json().catch(() => ({}));
          for (const [sid, v] of Object.entries<any>(j ?? {})) {
            if (!v || v.error) continue;
            const img = v?.attachments?.data?.[0]?.media?.image;
            const src = img && Number(img.width) >= 300 ? String(img.src) : '';
            const pic = src || (v.full_picture ? String(v.full_picture) : '');
            if (pic && !/t39\.30808-1\//.test(pic)) picByStory[sid] = pic;
          }
        }
      }
      for (const r of rows) {
        const pic = picByStory[r.storyId];
        if (pic && !r.origImg) r.image = pic; // 已有上載原檔嘅唔好覆蓋(原檔通常仲高清)
      }
    } catch {
      /* 攞唔到原相就照用 creative 嗰張 */
    }

    // 同一個 post 可能 boost 咗幾次(幾個 ad),甚至同 campaign 開兩個 ad 各出一個 post —
    // 老闆見到「重複」。合併條件:同一個 story id,或者 同 campaign + 同文案。數字加埋。
    const groups: (typeof rows)[] = [];
    const byStory = new Map<string, number>();
    const byCampCopy = new Map<string, number>();
    for (const r of rows) {
      const copyKey = r.copy.replace(/\s+/g, ' ').trim().slice(0, 120);
      const ck = copyKey ? `${r.campaignId}|${copyKey}` : '';
      let gi = -1;
      if (r.storyId && byStory.has(r.storyId)) gi = byStory.get(r.storyId)!;
      else if (ck && byCampCopy.has(ck)) gi = byCampCopy.get(ck)!;
      if (gi < 0) { gi = groups.length; groups.push([]); }
      groups[gi].push(r);
      if (r.storyId) byStory.set(r.storyId, gi);
      if (ck) byCampCopy.set(ck, gi);
    }
    const merged = groups
      .map((g) => {
        const rep = g.reduce((a, b) => (b.spend > a.spend ? b : a));
        let start: string | null = null;
        let end: string | null = null;
        let openEnd = false;
        for (const x of g) {
          if (x.start && (!start || x.start < start)) start = x.start;
          if (!x.end) openEnd = true;
          else if (!end || x.end > end) end = x.end;
        }
        return {
          ...rep,
          image: rep.image ?? g.find((x) => x.image)?.image ?? null,
          status: g.some((x) => x.status === 'ACTIVE') ? 'ACTIVE' : rep.status,
          start,
          end: openEnd ? null : end,
          spend: g.reduce((s, x) => s + x.spend, 0),
          impressions: g.reduce((s, x) => s + x.impressions, 0),
          reach: g.reduce((s, x) => s + x.reach, 0),
          clicks: g.reduce((s, x) => s + x.clicks, 0),
          inquiries: g.reduce((s, x) => s + x.inquiries, 0),
          adCount: g.length,
          // 合併前每個 ad 嘅 id — 前端用嚟同 inquiry_conversions.ctwa_ad_ids
          // (SleekFlow referral 歸因)對數,顯示「呢個 post 追到幾多個電話」
          adIds: g.map((x) => x.adId),
          // 連結推廣活動用嘅穩定 key(story id 排序取最細,合併點變都認得返)
          postKey: (() => {
            const sids = g.map((x) => x.storyId).filter(Boolean).sort();
            return sids[0]
              ? `sid:${sids[0]}`
              : `cc:${rep.campaignId}|${rep.copy.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
          })(),
          // 每個 ad 自己嘅一行(老闆要逐個類型分開睇)— 大花費行先
          parts: [...g]
            .sort((x, y) => y.spend - x.spend)
            .map((x) => ({
              goal: x.goal,
              name: x.name,
              status: x.status,
              start: x.start,
              end: x.end,
              spend: x.spend,
              impressions: x.impressions,
              clicks: x.clicks,
              inquiries: x.inquiries,
            })),
        };
      })
      .sort((a, b) => b.spend - a.spend);

    const out = { ok: true, preset: useRange ? null : preset, since: useRange ? since : null, until: useRange ? until : null, ads: merged };
    _wallCache.set(cacheKey, { t: Date.now(), body: out });
    return res.status(200).json(out);
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Meta ads 帳戶限流(error 17 / 80004)— 有過期 cache 就照用,冇就叫老闆等陣
    if (/too many calls|request limit|User request limit|80004/i.test(msg)) {
      if (hit) return res.status(200).json({ ...hit.body, stale: true });
      return res.status(200).json({
        ok: false,
        error: 'Meta 暫時限流(一個鐘內問得太密)— 唔係壞咗,等 5–10 分鐘再 refresh 就返嚟。',
      });
    }
    return res.status(200).json({ ok: false, error: msg });
  }
}
