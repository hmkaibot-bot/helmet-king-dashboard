// Chart colors for Recharts — amber-centric palette
export const CHART_COLORS = {
  primary: '#f59e0b',
  secondary: '#3b82f6',
  tertiary: '#10b981',
  quaternary: '#8b5cf6',
  fifth: '#ef4444',
  sixth: '#ec4899',
  seventh: '#06b6d4',
  eighth: '#84cc16',
};

export const CHART_PALETTE = [
  CHART_COLORS.primary,
  CHART_COLORS.secondary,
  CHART_COLORS.tertiary,
  CHART_COLORS.quaternary,
  CHART_COLORS.fifth,
  CHART_COLORS.sixth,
  CHART_COLORS.seventh,
  CHART_COLORS.eighth,
];

export const DONUT_PALETTE = [
  '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ef4444', '#ec4899', '#06b6d4', '#84cc16',
];

export const AXIS_STYLE = {
  fontSize: 11,
  fill: 'hsl(215, 10%, 55%)',
  fontFamily: 'Inter, sans-serif',
};

export const GRID_STYLE = {
  strokeDasharray: '3 3',
  stroke: 'hsl(220, 15%, 16%)',
  opacity: 0.5,
};

export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: 'hsl(225, 22%, 11%)',
    border: '1px solid hsl(220, 15%, 18%)',
    borderRadius: '8px',
    fontSize: '12px',
    fontFamily: 'Inter, sans-serif',
    color: 'hsl(210, 15%, 90%)',
    padding: '8px 12px',
  },
  itemStyle: {
    color: 'hsl(210, 15%, 90%)',
    fontSize: '12px',
    padding: '2px 0',
  },
  labelStyle: {
    color: 'hsl(215, 10%, 55%)',
    fontSize: '11px',
    marginBottom: '4px',
  },
};
