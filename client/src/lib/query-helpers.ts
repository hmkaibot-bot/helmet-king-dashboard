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
 * 批次並行拉 (6 workers) — 以前逐批串行,id 一多 (長 date range) 就變幾百個
 * request 排隊,一頁等成分鐘。
 */
export async function queryInBatches(
  table: string,
  columns: string,
  filterCol: string,
  ids: string[],
  batchSize = 150
): Promise<any[]> {
  if (ids.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }
  const results: any[][] = new Array(batches.length).fill(null).map(() => []);
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < batches.length) {
      const i = nextIdx++;
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .in(filterCol, batches[i])
        .limit(50000);
      if (error) {
        console.error(`Batch query error on ${table}:`, error);
        continue;
      }
      if (data) results[i] = data;
    }
  };
  const CONCURRENCY = 6;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return results.flat();
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

// ── Persistent cache (IndexedDB) ─────────────────────────────────────────────
// 數據每日 02:00–03:00 HKT 先由 GitHub Actions / n8n 同步一次,日間根本唔變 —
// 將每日同步嘅大表持久化落 IndexedDB,同一個「數據日」之內 reload / 開新 tab
// 都唔使再拉幾 MB,直接即開。用戶手動改嘅表 (dead_stock_reviews 等) 唔持久化。
const PERSIST_PREFIXES = ['shopify_', 'bc_', 'marsello_', 'sku_', 'variant_', 'monthly_'];
const IDB_NAME = 'hk-query-cache';
const IDB_STORE = 'tables';

function _isPersistable(table: string): boolean {
  return PERSIST_PREFIXES.some(p => table.startsWith(p));
}

/** 最近一次同步邊界 = 04:00 HKT (= 20:00 UTC 前一日)。cache 喺邊界之後寫入先算新鮮。 */
function _lastSyncBoundary(): number {
  const b = new Date();
  b.setUTCHours(20, 0, 0, 0);
  if (b.getTime() > Date.now()) b.setUTCDate(b.getUTCDate() - 1);
  return b.getTime();
}

function _openIdb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // e.g. sandboxed iframe / private mode without IDB
    }
  });
}

async function _idbGet(key: string): Promise<{ ts: number; data: any[] } | null> {
  const db = await _openIdb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function _idbSet(key: string, value: { ts: number; data: any[] }): Promise<void> {
  const db = await _openIdb();
  if (!db) return;
  try {
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(value, key);
  } catch { /* quota / private mode — degrade to memory-only */ }
}

// 每個 session 清一次過期 entry (上次同步邊界之前嘅) — 防止 IDB 積垃圾
let _purged = false;
async function _purgeStaleIdb(): Promise<void> {
  if (_purged) return;
  _purged = true;
  const db = await _openIdb();
  if (!db) return;
  try {
    const boundary = _lastSyncBoundary();
    const store = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!cursor.value?.ts || cursor.value.ts < boundary) cursor.delete();
      cursor.continue();
    };
  } catch { /* ignore */ }
}

async function _idbClear(prefix?: string): Promise<void> {
  const db = await _openIdb();
  if (!db) return;
  try {
    const store = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
    if (!prefix) { store.clear(); return; }
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) {
        if (String(k).startsWith(`${prefix}|`)) store.delete(k);
      }
    };
  } catch { /* ignore */ }
}

/** Manually invalidate cache (call after data sync or user clicks refresh). */
export function clearQueryCache(tablePrefix?: string) {
  if (!tablePrefix) {
    _cache.clear();
  } else {
    for (const k of Array.from(_cache.keys())) {
      if (k.startsWith(`${tablePrefix}|`)) _cache.delete(k);
    }
  }
  void _idbClear(tablePrefix); // fire-and-forget
}

export async function queryAllPages(
  table: string,
  columns: string,
  extraFilters?: { column: string; op: 'eq' | 'gt' | 'gte' | 'lte'; value: string }[],
  maxRows = 200000
): Promise<any[]> {
  const cacheKey = _makeKey(table, columns, extraFilters);
  const cached = _cache.get(cacheKey);
  const now = Date.now();
  const persistable = _isPersistable(table);
  // 每日同步表: 同一個數據日之內 (上次同步邊界之後寫入) 一律算新鮮;
  // 其他表 (用戶手動改): 沿用 5 分鐘 TTL
  const isFresh = (ts: number) =>
    persistable ? ts >= _lastSyncBoundary() : now - ts < CACHE_TTL_MS;
  // Serve fresh memory cache directly
  if (cached && !cached.pending && cached.ts > 0 && isFresh(cached.ts)) {
    return cached.data;
  }
  // De-duplicate concurrent identical requests
  if (cached?.pending) return cached.pending;

  const promise = (async () => {
    // 持久 cache: reload / 新 tab 之後 memory 係空嘅,先試 IndexedDB
    if (persistable && !cached) {
      void _purgeStaleIdb();
      const idbHit = await _idbGet(cacheKey);
      if (idbHit && isFresh(idbHit.ts)) return idbHit.data;
    }
    const data = await _queryAllPagesUncached(table, columns, extraFilters, maxRows);
    if (persistable) void _idbSet(cacheKey, { ts: Date.now(), data });
    return data;
  })();
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
  extraFilters?: { column: string; op: 'eq' | 'gt' | 'gte' | 'lte'; value: string }[],
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
          if (f.op === 'gt')  query = (query as any).gt(f.column, f.value);
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
