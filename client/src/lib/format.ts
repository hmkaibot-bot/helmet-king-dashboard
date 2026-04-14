export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return 'HK$0';
  return `HK$${value.toLocaleString('en-HK', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString('en-HK');
}

export function formatPercent(value: number | null | undefined): string {
  if (value == null) return '0%';
  return `${value.toFixed(1)}%`;
}

export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (value == null) return '0';
  return value.toFixed(digits);
}

export type DateRange = 'today' | '7d' | '30d' | '90d' | 'this_week' | 'this_month' | 'custom';

export interface DateBounds {
  from: string; // ISO date string YYYY-MM-DD
  to: string;   // ISO date string YYYY-MM-DD
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getDateBounds(range: DateRange, customFrom?: string, customTo?: string): DateBounds {
  const now = new Date();
  const todayStr = fmtDate(now);
  
  switch (range) {
    case 'today': {
      return { from: todayStr, to: todayStr };
    }
    case 'this_week': {
      const d = new Date(now);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      d.setDate(diff);
      return { from: fmtDate(d), to: todayStr };
    }
    case 'this_month': {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: fmtDate(d), to: todayStr };
    }
    case '7d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { from: fmtDate(d), to: todayStr };
    }
    case '30d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: fmtDate(d), to: todayStr };
    }
    case '90d': {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return { from: fmtDate(d), to: todayStr };
    }
    case 'custom': {
      return {
        from: customFrom || todayStr,
        to: customTo || todayStr,
      };
    }
  }
}

/** Get the previous period bounds for delta calculation */
export function getPreviousPeriodBounds(bounds: DateBounds): DateBounds {
  const fromDate = new Date(bounds.from + 'T00:00:00Z');
  const toDate = new Date(bounds.to + 'T23:59:59Z');
  const durationMs = toDate.getTime() - fromDate.getTime();
  const prevTo = new Date(fromDate.getTime() - 86400000); // day before
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  return {
    from: fmtDate(prevFrom),
    to: fmtDate(prevTo),
  };
}

/**
 * Filter an array of records by a date field within bounds.
 * Works as a JS-side replacement for .lte() which the proxy doesn't support.
 */
export function filterByDate<T>(records: T[], dateField: keyof T, bounds: DateBounds): T[] {
  const fromStr = bounds.from;
  const toStr = bounds.to + '\xff'; // ensures any time on the to-date is included
  return records.filter((r) => {
    const val = String(r[dateField] || '');
    return val >= fromStr && val <= toStr;
  });
}

export const DATE_RANGE_LABELS: Record<DateRange, { zh: string; en: string }> = {
  'today': { zh: '今天', en: 'Today' },
  'this_week': { zh: '本週', en: 'This Week' },
  'this_month': { zh: '本月', en: 'This Month' },
  '7d': { zh: '最近7天', en: 'Last 7d' },
  '30d': { zh: '最近30天', en: 'Last 30d' },
  '90d': { zh: '最近90天', en: 'Last 90d' },
  'custom': { zh: '自訂', en: 'Custom' },
};
