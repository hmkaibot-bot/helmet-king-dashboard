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

export type DateRange = '7d' | '30d' | '90d' | '1y' | 'all';

export function getDateFrom(range: DateRange): string | null {
  if (range === 'all') return null;
  const d = new Date();
  switch (range) {
    case '7d': d.setDate(d.getDate() - 7); break;
    case '30d': d.setDate(d.getDate() - 30); break;
    case '90d': d.setDate(d.getDate() - 90); break;
    case '1y': d.setFullYear(d.getFullYear() - 1); break;
  }
  return d.toISOString();
}

export const DATE_RANGE_LABELS: Record<DateRange, string> = {
  '7d': '最近7天',
  '30d': '最近30天',
  '90d': '最近90天',
  '1y': '最近1年',
  'all': '全部時間',
};
