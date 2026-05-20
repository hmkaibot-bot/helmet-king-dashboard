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
 * Query ALL records from a table using 1000-per-page pagination.
 * Supabase REST API caps responses at 1000 rows — this loops through all pages.
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
  const PAGE_SIZE = 1000;
  let all: any[] = [];
  let offset = 0;
  while (all.length < maxRows) {
    let query = supabase
      .from(table)
      .select(columns)
      .range(offset, offset + PAGE_SIZE - 1);
    if (extraFilters) {
      for (const f of extraFilters) {
        if (f.op === 'eq')  query = (query as any).eq(f.column, f.value);
        if (f.op === 'gte') query = (query as any).gte(f.column, f.value);
        if (f.op === 'lte') query = (query as any).lte(f.column, f.value);
      }
    }
    const { data, error } = await query;
    if (error) { console.error(`Pagination error on ${table}:`, error); break; }
    if (!data || data.length === 0) break;
    all = [...all, ...data];
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
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
