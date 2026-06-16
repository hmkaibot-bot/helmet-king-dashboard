/**
 * Vercel serverless function — 觸發「Price Watch」GitHub Actions workflow (一鍵刷新對手價)。
 * 安全: 需 Supabase 用戶 JWT。env: GH_DISPATCH_TOKEN (GitHub PAT, scope: actions:write)。
 */
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; RLS 保護) — 唔可以空, 否則 verifyUser 401 "No API key found"
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const GH_TOKEN = process.env.GH_DISPATCH_TOKEN || '';
const REPO = process.env.GH_REPO || 'hmkaibot-bot/helmet-king-dashboard';
const WORKFLOW = process.env.GH_WORKFLOW || 'price-watch.yml';

export const config = { maxDuration: 20 };

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
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !(await verifyUser(token))) return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });
  if (!GH_TOKEN) return res.status(500).json({ error: '未設定 GH_DISPATCH_TOKEN（請喺 Vercel 加 GitHub PAT，scope: actions:write）' });

  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'helmet-king-dashboard',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (r.status === 204) return res.status(200).json({ ok: true });
    const t = await r.text();
    return res.status(200).json({ ok: false, error: `GitHub ${r.status}: ${t.slice(0, 200)}` });
  } catch (e: any) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
}
