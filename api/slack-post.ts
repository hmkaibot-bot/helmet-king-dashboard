/**
 * Post Studio → Slack #po-stream
 * 收 {caption, images:[{filename,dataUrl}]},用 SLACK_BOT_TOKEN 上載圖 + 文案。
 *
 * 一次過設定(Vercel env):
 *   SLACK_BOT_TOKEN    — api.slack.com 開 app「HK Post Studio」,OAuth scopes:
 *                        files:write, chat:write, channels:read, groups:read
 *                        install 落 workspace,copy 個 xoxb- token
 *   SLACK_POST_CHANNEL — channel 名,預設 po-stream(要先喺 Slack 開咗
 *                        呢條 channel,並且 /invite 個 bot 入去)
 * 未設定 → 回 501,前端顯示設定指示,download 功能唔受影響。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; RLS 保護)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_CHANNEL = process.env.SLACK_POST_CHANNEL || 'po-stream';

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '4mb' } } };

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

async function slack(method: string, body: Record<string, unknown> | URLSearchParams): Promise<any> {
  const isForm = body instanceof URLSearchParams;
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
    },
    body: isForm ? body : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Slack ${method} 失敗:${j.error || r.status}`);
  return j;
}

let _channelId: string | null = null;
async function resolveChannelId(): Promise<string> {
  if (_channelId) return _channelId;
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel', limit: '200', exclude_archived: 'true',
    });
    if (cursor) params.set('cursor', cursor);
    const j = await slack('conversations.list', params);
    const hit = (j.channels || []).find((ch: any) => ch.name === SLACK_CHANNEL);
    if (hit) { _channelId = hit.id; return hit.id; }
    cursor = j.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  throw new Error(`搵唔到 Slack channel #${SLACK_CHANNEL} — 開咗未?bot 邀請咗入去未?`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth || !(await verifyUser(auth))) {
    return res.status(401).json({ error: '未授權 — 請先登入 dashboard' });
  }
  if (!SLACK_TOKEN) {
    return res.status(501).json({
      error: 'SLACK_BOT_TOKEN 未設定',
      setup: true,
    });
  }

  const { caption, images } = (req.body ?? {}) as {
    caption?: string;
    images?: { filename?: string; dataUrl?: string }[];
  };
  const imgs = (images || []).filter(i => typeof i.dataUrl === 'string' && i.dataUrl.startsWith('data:image/')).slice(0, 6);
  if (imgs.length === 0 && !caption) return res.status(400).json({ error: '冇嘢好 send' });

  try {
    const channelId = await resolveChannelId();

    if (imgs.length === 0) {
      await slack('chat.postMessage', { channel: channelId, text: caption });
      return res.status(200).json({ ok: true, channel: SLACK_CHANNEL });
    }

    // files.uploadV2 三步曲:攞 upload URL → PUT bytes → complete(綁 channel + caption)
    const fileIds: { id: string; title: string }[] = [];
    for (const [i, img] of imgs.entries()) {
      const b64 = img.dataUrl!.split(',')[1] || '';
      const buf = Buffer.from(b64, 'base64');
      const filename = img.filename || `post-card-${i + 1}.png`;
      const urlResp = await slack('files.getUploadURLExternal', new URLSearchParams({
        filename, length: String(buf.length),
      }));
      const up = await fetch(urlResp.upload_url, { method: 'POST', body: buf as any });
      if (!up.ok) throw new Error(`圖片上載失敗 (${up.status})`);
      fileIds.push({ id: urlResp.file_id, title: filename });
    }
    await slack('files.completeUploadExternal', {
      files: fileIds,
      channel_id: channelId,
      initial_comment: caption || '',
    });

    return res.status(200).json({ ok: true, channel: SLACK_CHANNEL, files: fileIds.length });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
