import { supabase } from './supabase';
import type { DateBounds } from './format';

/**
 * Query a Supabase table with date range filtering.
 * Uses only .gte() since the proxy doesn't support .lte() on timestamptz.
 * Applies upper bound filtering in JS.
 */
export async function queryWithDateRange(
  table: string,
  columns: string,
  dateCol: string,
  bounds: DateBounds,
  extraFilters?: { column: string; op: 'eq'; value: string }[],
  limit = 5000
): Promise<any[]> {
  let query = supabase
    .from(table)
    .select(columns)
    .gte(dateCol, bounds.from);

  if (extraFilters) {
    for (const f of extraFilters) {
      if (f.op === 'eq') {
        query = query.eq(f.column, f.value);
      }
    }
  }

  query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error(`Query error on ${table}:`, error);
    return [];
  }

  // JS-side upper bound filter
  const toStr = bounds.to + '\xff';
  return (data || []).filter((row: any) => {
    const val = String(row[dateCol] || '');
    return val <= toStr;
  });
}

/**
 * Query all records from a table (no date filter).
 */
export async function queryAll(
  table: string,
  columns: string,
  extraFilters?: { column: string; op: 'eq'; value: string }[],
  limit = 5000
): Promise<any[]> {
  let query = supabase.from(table).select(columns);

  if (extraFilters) {
    for (const f of extraFilters) {
      if (f.op === 'eq') {
        query = query.eq(f.column, f.value);
      }
    }
  }

  query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error(`Query error on ${table}:`, error);
    return [];
  }
  return data || [];
}

/**
 * Query records from a table using batched 'in' filters.
 * Splits the IDs into batches to avoid URL length limits.
 */
export async function queryInBatches(
  table: string,
  columns: string,
  filterCol: string,
  ids: string[],
  batchSize = 40
): Promise<any[]> {
  if (ids.length === 0) return [];
  const results: any[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .in(filterCol, batch)
      .limit(5000);
    if (error) {
      console.error(`Batch query error on ${table}:`, error);
      continue;
    }
    if (data) results.push(...data);
  }
  return results;
}

/**
 * Query ALL records from a table using paginated requests.
 * 單次回傳上限由 PostgREST max-rows 設定決定 — 首頁實際回傳行數會被用作
 * page size,之後剩餘頁並行拉,自動適應任何 max-rows 值。
 */
// In-memory cache shared across pages so that switching back to a previously
// viewed page (e.g. inventory → dead-stock → inventory) does not re-fetch the
// same large tables. Entries auto-expire after TTL_MS.
const _cache = new Map<string, { ts: number; data: any[]; pending?: Promise<any[]> }>();
const CACHE_TTL_MS = 5 * 60 * 1000;       // 5 minutes "fresh"
const CACHE_KEEP_MS = 30 * 60 * 1000;     // serve cached data up to 30 min on error

function _makeKey(table: string, columns: string, extraFilters: any): string {
  return `${table}|${columns}|${extraFilters ? JSON.stringify(extraFilters) : ''}`;
}

/** Manually invalidate cache (call after data sync or user clicks refresh). */
export function clearQueryCache(tablePrefix?: string) {
  if (!tablePrefix) { _cache.clear(); return; }
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(`${tablePrefix}|`)) _cache.delete(k);
  }
}

export async function queryAllPages(
  table: string,
  columns: string,
  extraFilters?: { column: string; op: 'eq' | 'gte' | 'lte'; value: string }[],
  maxRows = 200000
): Promise<any[]> {
  const cacheKey = _makeKey(table, columns, extraFilters);
  const cached = _cache.get(cacheKey);
  const now = Date.now();
  // Serve fresh cache directly
  if (cached && !cached.pending && now - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  // De-duplicate concurrent identical requests
  if (cached?.pending) return cached.pending;

  const promise = _queryAllPagesUncached(table, columns, extraFilters, maxRows);
  _cache.set(cacheKey, { ts: cached?.ts ?? 0, data: cached?.data ?? [], pending: promise });
  try {
    const data = await promise;
    _cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (err) {
    // Fall back to stale cache if available (≤ 30 min old)
    if (cached?.data && now - cached.ts < CACHE_KEEP_MS) {
      _cache.set(cacheKey, { ts: cached.ts, data: cached.data });
      console.warn(`queryAllPages(${table}) failed, returning stale cache`, err);
      return cached.data;
    }
    _cache.delete(cacheKey);
    throw err;
  }
}

async function _queryAllPagesUncached(
  table: string,
  columns: string,
  extraFilters?: { column: string; op: 'eq' | 'gte' | 'lte'; value: string }[],
  maxRows = 200000
): Promise<any[]> {
  // 每次 request 想攞嘅行數。實際單次回傳上限由 PostgREST max-rows 決定
  // (Supabase 預設 1000,可以喺 DB 度 alter role authenticator set pgrst.db_max_rows
  //  調高) — 以下邏輯用「首頁實際回傳行數」自動適應,所以兩種設定都正確。
  const DESIRED_PAGE_SIZE = 10000;
  // Retry with backoff — Supabase REST (Cloudflare 前面) 大量分頁請求時
  // 偶然會 rate limit / 斷線,唔 retry 嘅話成頁數據會缺一截。
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [500, 1500, 4000];

  // 單頁 fetch + retry。withCount = true 時順便攞 exact total。
  const fetchRange = async (
    from: number,
    to: number,
    withCount: boolean,
  ): Promise<{ rows: any[]; count: number | null }> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
      }
      let query = supabase
        .from(table)
        .select(columns, withCount ? { count: 'exact' } : undefined)
        .range(from, to);
      if (extraFilters) {
        for (const f of extraFilters) {
          if (f.op === 'eq')  query = (query as any).eq(f.column, f.value);
          if (f.op === 'gte') query = (query as any).gte(f.column, f.value);
          if (f.op === 'lte') query = (query as any).lte(f.column, f.value);
        }
      }
      const res = await query;
      if (!res.error) return { rows: res.data ?? [], count: res.count ?? null };
      lastError = res.error;
      console.warn(`Pagination error on ${table} range=${from}-${to} (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, res.error);
    }
    // 唔好靜靜回傳半截數據當完整 — throw 俾上層 (queryAllPages 有 stale cache fallback)
    throw new Error(`queryAllPages(${table}) failed after ${MAX_RETRIES + 1} attempts: ${(lastError as any)?.message ?? lastError}`);
  };

  // 首頁攞埋 exact count — 知道 total 之後,剩餘頁可以一次過並行拉,
  // 唔使逐輪「拉到唔滿一頁先知到尾」。
  const first = await fetchRange(0, DESIRED_PAGE_SIZE - 1, true);
  const all: any[] = [...first.rows];
  const total = Math.min(first.count ?? all.length, maxRows);
  if (all.length === 0 || all.length >= total) return all;

  // 首頁實際回傳行數 = server 單次上限 (PostgREST max-rows),用佢做 page size
  const pageSize = first.rows.length;
  const offsets: number[] = [];
  for (let o = pageSize; o < total; o += pageSize) offsets.push(o);

  // 並行拉剩餘頁 — 並行度保守 (6) 避免觸發 Supabase / Cloudflare rate limit
  const CONCURRENCY = 6;
  const results: any[][] = new Array(offsets.length);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < offsets.length) {
      const i = nextIdx++;
      const o = offsets[i];
      const { rows } = await fetchRange(o, o + pageSize - 1, false);
      results[i] = rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, worker));
  for (const rows of results) all.push(...rows);
  return all.length > maxRows ? all.slice(0, maxRows) : all;
}

/**
 * 試用 server-side 聚合 view (sql/perf-views.sql)。
 * View 未建立時 (probe 即刻 error) 回 null,俾 caller fallback 行舊嘅
 * client-side 聚合路徑 — 所以未跑 SQL 之前 app 照行。
 */
export async function tryView(view: string, columns: string): Promise<any[] | null> {
  const probe = await supabase.from(view).select(columns).limit(1);
  if (probe.error) return null;
  try {
    return await queryAllPages(view, columns);
  } catch {
    return null;
  }
}

/**
 * Helper: build product_id → { product_type, vendor } map from shopify_products.
 * Cached via queryAllPages.
 */
export async function getProductMeta(): Promise<Record<string, { product_type: string; vendor: string }>> {
  const rows = await queryAllPages('shopify_products', 'id,product_type,vendor');
  const map: Record<string, { product_type: string; vendor: string }> = {};
  for (const r of rows as any[]) {
    if (r?.id != null) {
      map[String(r.id)] = {
        product_type: r.product_type || '',
        vendor: r.vendor || '',
      };
    }
  }
  return map;
}

/**
 * Count records in a table.
 */
export async function queryCount(
  table: string,
  extraFilters?: { column: string; op: 'eq'; value: string }[]
): Promise<number> {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });

  if (extraFilters) {
    for (const f of extraFilters) {
      if (f.op === 'eq') {
        query = query.eq(f.column, f.value);
      }
    }
  }

  const { count, error } = await query;
  if (error) {
    console.error(`Count error on ${table}:`, error);
    return 0;
  }
  return count || 0;
}
