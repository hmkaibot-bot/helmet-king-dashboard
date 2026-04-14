/** Time intelligence utilities for MoM / YoY / MTD / YTD comparisons */

export interface DateRange {
  start: string; // ISO string
  end: string;
}

/** Get date range boundaries in HKT (UTC+8) */
export function getDateRanges() {
  const now = new Date();
  // Approximate HKT
  const hktOffset = 8 * 3600000;
  const utcNow = now.getTime() + now.getTimezoneOffset() * 60000;
  const today = new Date(utcNow + hktOffset);

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
  const startOfYear = new Date(today.getFullYear(), 0, 1);
  const startOfLastYear = new Date(today.getFullYear() - 1, 0, 1);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 86400000);
  const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400000);
  const oneEightyDaysAgo = new Date(today.getTime() - 180 * 86400000);

  // How far we are into the current month (for prev MTD comparison)
  const dayOfMonth = today.getDate();
  const prevMtdEnd = new Date(startOfLastMonth.getFullYear(), startOfLastMonth.getMonth(), dayOfMonth);

  // How far into the year
  const dayOfYear = Math.floor((today.getTime() - startOfYear.getTime()) / 86400000);
  const prevYtdEnd = new Date(startOfLastYear.getTime() + dayOfYear * 86400000);

  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return {
    today: fmt(today),
    mtd: { start: fmt(startOfMonth), end: fmt(today) },
    prevMtd: { start: fmt(startOfLastMonth), end: fmt(prevMtdEnd) },
    lastMonth: { start: fmt(startOfLastMonth), end: fmt(endOfLastMonth) },
    ytd: { start: fmt(startOfYear), end: fmt(today) },
    prevYtd: { start: fmt(startOfLastYear), end: fmt(prevYtdEnd) },
    last30: { start: fmt(thirtyDaysAgo), end: fmt(today) },
    prev30: { start: fmt(sixtyDaysAgo), end: fmt(thirtyDaysAgo) },
    last90: { start: fmt(ninetyDaysAgo), end: fmt(today) },
    prev90: { start: fmt(oneEightyDaysAgo), end: fmt(ninetyDaysAgo) },
  };
}

/** Calculate percent change between two values */
export function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

/** Format percentage with sign: +12.3% or -5.1% */
export function formatPctChange(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}
