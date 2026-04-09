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
