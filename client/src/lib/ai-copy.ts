import { supabase } from './supabase';

export interface CopyDiscrepancy {
  field: string;
  current: string;
  correct: string;
  source?: string;
}
export interface CopyReview {
  found: boolean;
  confidence: 'high' | 'medium' | 'low';
  discrepancies: CopyDiscrepancy[];
  correctedZh: string;
  correctedEn: string;
  sources: string[];
}

/**
 * AI 文案校對 — 經 /api/ai-copy-review (Claude Opus 4.8 + web_search)。
 * 帶用戶 Supabase JWT 認證；唯讀分析,結果由前端 review 後先 save。
 */
export async function reviewCopy(input: {
  title: string;
  vendor: string;
  productType: string;
  descriptionHtml: string;
}): Promise<CopyReview> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('未登入 — 請重新登入 dashboard');
  const resp = await fetch('/api/ai-copy-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  let j: any = null;
  try { j = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) throw new Error(j?.error || `校對服務回應 ${resp.status}（部署後先可用）`);
  if (j?.ok === false) throw new Error(j.error || 'AI 校對失敗');
  const r = j?.review || {};
  return {
    found: !!r.found,
    confidence: (r.confidence as CopyReview['confidence']) || 'low',
    discrepancies: Array.isArray(r.discrepancies) ? r.discrepancies : [],
    correctedZh: r.correctedZh || '',
    correctedEn: r.correctedEn || '',
    sources: Array.isArray(r.sources) ? r.sources : [],
  };
}
