export const KPI_TARGETS = {
  monthlyRevenue:   1400000,
  grossMarginPct:   37,
  aov:              1500,
  newMembersMonth:  200,
  metaRoas:         8,
};

/** Returns traffic-light status for a KPI value vs target */
export function kpiStatus(value: number, target: number, higherIsBetter = true) {
  const pct = target > 0 ? (value / target) * 100 : 0;
  const achieved = higherIsBetter ? value >= target : value <= target;
  const color = achieved ? 'text-green-400' : pct >= 80 ? 'text-yellow-400' : 'text-red-400';
  const bgColor = achieved ? 'bg-green-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-red-500';
  const icon = achieved ? '🟢' : pct >= 80 ? '🟡' : '🔴';
  return { achieved, pct: Math.round(pct), color, bgColor, icon, gap: Math.abs(target - value) };
}
