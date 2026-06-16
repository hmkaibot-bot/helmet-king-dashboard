import Anthropic from '@anthropic-ai/sdk';

/**
 * Vercel serverless function — AI 文案校對。
 * 用 Claude Opus 4.8 + web_search 工具搵官方資料、核對現有產品簡介、列出錯漏、
 * 出更正後中英簡介 + 來源。唯讀分析,唔會自動寫 Shopify(由前端 review 後先 save)。
 *
 * 安全: 呼叫者要帶 Supabase 用戶 JWT。
 * env: ANTHROPIC_API_KEY (Vercel server-side; 未設時 graceful 回提示)
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

const stripHtml = (s: string) =>
  (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);

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
  const title = String(body?.title || '').slice(0, 300);
  const vendor = String(body?.vendor || '');
  const productType = String(body?.productType || '');
  const current = stripHtml(String(body?.descriptionHtml || ''));
  if (!title) return res.status(400).json({ error: '冇商品資料' });

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const prompt = `你係香港一間摩托車裝備(頭盔/手套/騎士服/配件)零售店嘅產品文案校對員,中英文俱佳。

商品名稱: ${title}
品牌: ${vendor || '(未知)'}
分類: ${productType || '(未知)'}
現有產品簡介(可能中英夾雜、有錯漏):
"""${current || '(空)'}"""

請:
1. 用 web_search 搵呢件商品(品牌 + 型號)嘅官方 / 權威資料,品牌官方網站優先。
2. 同現有簡介核對,列出錯漏(例如:殼料、安全認證 ECE/DOT/SNELL、重量、尺碼、功能特性講錯或缺漏)。
3. 寫出更正後嘅【中文】同【英文】產品簡介,準確、簡潔、唔好誇大,只寫有根據嘅嘢。
4. 如果搵唔到官方資料,confidence 要寫 "low",唔好作料。

**最後只輸出一個 JSON object**(前後唔好有任何其他文字),格式:
{"found": true, "confidence": "high|medium|low", "discrepancies": [{"field": "規格名", "current": "現有講法", "correct": "正確講法", "source": "url"}], "correctedZh": "更正後中文簡介", "correctedEn": "corrected English description", "sources": ["url1","url2"]}`;

  try {
    const messages: any[] = [{ role: 'user', content: prompt }];
    let final: any = null;
    for (let i = 0; i < 4; i++) {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        tools: [{ type: 'web_search_20260209', name: 'web_search' }] as any,
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
    const review = extractJson(text);
    if (!review) return res.status(200).json({ ok: false, error: 'AI 回覆解析失敗', raw: text.slice(0, 2000) });
    return res.status(200).json({ ok: true, review });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
