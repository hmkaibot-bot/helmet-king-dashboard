/**
 * Vercel serverless function — SleekFlow inbound webhook → inquiry_events。
 *
 * SleekFlow 側設定(Flow Builder):收到訊息 → HTTP Request →
 *   POST https://<dashboard-domain>/api/sleekflow-inquiry?s=<SLEEKFLOW_WEBHOOK_SECRET>
 *   Body: 該訊息事件 JSON(欄位名版本略有差異,normalize() 集中對映)
 *
 * 安全模型:呢個 endpoint 冇 Supabase service key —— 寫入行 DB 嘅
 * SECURITY DEFINER function ingest_sleekflow_inquiry(anon 可 call),function
 * 內部對 app_config 條 shared secret,啱先落數。錯 secret 回 401(等老闆喺
 * Flow Builder 測試時即刻見到配置錯)。
 *
 * 原則:只存 metadata(id/channel/時間/電話),唔存訊息內容;outbound 唔計。
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY ||
  // 公開 anon key (同 config.ts; 寫入權限由 DB function 嘅 secret 驗證把關)
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';

export const config = { maxDuration: 10 };

interface Normalized {
  messageId: string;
  conversationId: string | null;
  contactId: string | null;
  phone: string | null;
  channel: string | null;
  team: string | null;
  direction: 'inbound' | 'outbound';
  timestamp: string | null;
  source: string | null; // 'ctwa' = 經 Meta 廣告(Click-to-WhatsApp)入嚟;null = 直接
}

// SleekFlow webhook payload 欄位名各版本有出入 — 對映集中一處,方便日後照 payload 調整
function normalize(b: any): Normalized {
  const msg = b?.message ?? b; // 有啲版本包一層 message
  return {
    messageId: String(msg?.messageId ?? msg?.id ?? msg?.messageUniqueID ?? ''),
    conversationId: msg?.conversationId ?? msg?.conversation?.id ?? b?.conversationId ?? null,
    contactId: msg?.contactId ?? b?.contact?.id ?? b?.userProfile?.id ?? null,
    phone:
      msg?.from ?? b?.contact?.phoneNumber ?? b?.userProfile?.phoneNumber ?? b?.phoneNumber ?? null,
    channel: String(msg?.channel ?? msg?.channelType ?? b?.channel ?? '').toLowerCase() || null,
    team: msg?.assignedTeam ?? b?.assignedTeam?.teamName ?? b?.team ?? null,
    direction:
      msg?.isSentFromSleekflow === true ||
      msg?.direction === 'outbound' ||
      msg?.isFromUser === false
        ? 'outbound'
        : 'inbound',
    timestamp: msg?.createdAt ?? msg?.timestamp ?? b?.createdAt ?? null,
    source: String(b?.source ?? msg?.source ?? '').toLowerCase() || null,
  };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = String(req.query?.s ?? req.query?.secret ?? '');
  if (!secret) return res.status(401).json({ error: '缺 secret（URL 要帶 ?s=…）' });

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const e = normalize(body ?? {});
  // outbound(店方覆)唔計 — 照 200,免 SleekFlow 重推
  if (e.direction !== 'inbound') return res.status(200).json({ ok: true, skipped: 'outbound' });
  // Flow Builder 通常只有 contact 級 variables — 冇 conversation id 時用
  // 「同一個客 × 同一日」做對話 proxy(dashboard 查詢量計 distinct 對話):
  // 一個客一日內連環問十句 = 1 單查詢;隔日再問 = 新一單。
  if (!e.conversationId && e.contactId) {
    e.conversationId = `contact:${e.contactId}:${new Date().toISOString().slice(0, 10)}`;
  }
  // SleekFlow HTTP 節點唔一定有 message id variable — 冇就合成一個:
  // 有 conversation+時間 就用佢哋砌(webhook 重推都 dedup 到);再冇就隨機
  // (隨機 id 極端情況會多一兩行 message,但查詢量計 distinct 對話,唔會谷大個數)。
  if (!e.messageId) {
    e.messageId =
      e.conversationId && e.timestamp
        ? `synth:${e.conversationId}:${e.timestamp}`
        : `synth:${(globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_sleekflow_inquiry`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_secret: secret,
        p_message_id: e.messageId,
        p_conversation_id: e.conversationId,
        p_contact_id: e.contactId,
        p_contact_phone: e.phone,
        p_channel: e.channel,
        p_team: e.team,
        p_occurred_at: e.timestamp,
        p_source: e.source,
      }),
    });
    if (!r.ok) {
      const j: any = await r.json().catch(() => ({}));
      const msg = String(j?.message ?? '');
      if (/invalid secret/i.test(msg)) return res.status(401).json({ error: 'secret 唔啱' });
      return res.status(200).json({ ok: false, error: msg || `HTTP ${r.status}` });
    }
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    // 已收到 payload 但落數失敗 — 照 200 免無限重推,錯誤入 log
    console.error('sleekflow inquiry ingest failed', err);
    return res.status(200).json({ ok: false, error: err?.message || String(err) });
  }
}
