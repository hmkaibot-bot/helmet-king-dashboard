/**
 * Vercel serverless — 即時攞一個 SleekFlow 對話嘅訊息(查詢與轉換頁 drill-down 用)。
 *
 * 對話內容唔入庫(私隱)— 呢度每次即時問 SleekFlow,睇完就算。
 * API key:env SLEEKFLOW_API_KEY 優先,冇就用呼叫者 JWT 讀 Supabase app_config
 * (RLS:authenticated 先讀到,同 meta-campaign 同一套 zero-config 模式)。
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SF_KEY_ENV = process.env.SLEEKFLOW_API_KEY || '';
const SF_BASE = 'https://api.sleekflow.io/api';

export const config = { maxDuration: 20 };

let _keyCache = '';
async function getSleekflowKey(userJwt: string): Promise<string> {
  if (SF_KEY_ENV) return SF_KEY_ENV;
  if (_keyCache) return _keyCache;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/app_config?key=eq.SLEEKFLOW_API_KEY&select=value`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${userJwt}` } }
    );
    const rows: any = await r.json().catch(() => []);
    const v = Array.isArray(rows) && rows[0]?.value ? String(rows[0].value) : '';
    if (v) _keyCache = v;
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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });

  let body: any = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  // conversation id 係 SleekFlow UUID;webhook 合成嗰啲(contact:…)呢度接受唔到
  const convId = String(body?.conversationId ?? '');
  if (!/^[0-9a-fA-F-]{30,40}$/.test(convId)) return res.status(400).json({ error: 'conversationId 唔啱格式' });

  const key = await getSleekflowKey(token);
  if (!key) return res.status(500).json({ error: '搵唔到 SLEEKFLOW_API_KEY(env 同 app_config 都冇)' });

  try {
    const r = await fetch(`${SF_BASE}/conversation/message/${convId}?offset=0&limit=120`, {
      headers: { 'X-Sleekflow-Api-Key': key },
    });
    if (!r.ok) return res.status(200).json({ ok: false, error: `SleekFlow HTTP ${r.status}` });
    const msgs: any[] = await r.json().catch(() => []);
    const rows = (Array.isArray(msgs) ? msgs : [])
      .filter(m => String(m?.channel ?? '') !== 'note') // 同事內部 note 唔顯示
      .map(m => ({
        at: String(m?.createdAt ?? ''),
        fromShop: m?.isSentFromSleekflow === true,
        type: String(m?.messageType ?? ''),
        text:
          String(m?.messageType) === 'text'
            ? String(m?.messageContent ?? '')
            : `〔${String(m?.messageType || '附件')}〕`,
      }))
      .filter(m => m.at && m.text.trim())
      .sort((a, b) => a.at.localeCompare(b.at));
    return res.status(200).json({ ok: true, messages: rows });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
