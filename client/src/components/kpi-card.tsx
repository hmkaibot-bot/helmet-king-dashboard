import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { type LucideIcon } from 'lucide-react';

interface KpiCardProps {
  title: string;
  subtitle?: string;
  value: string;
  icon: LucideIcon;
  loading?: boolean;
  testId?: string;
  delta?: number | null; // percent change
}

export function KpiCard({ title, subtitle, value, icon: Icon, loading, testId, delta }: KpiCardProps) {
  const deltaColor =
    delta == null ? ''
    : delta > 0 ? 'text-emerald-400'
    : delta < 0 ? 'text-red-400'
    : 'text-muted-foreground';

  const DeltaIcon =
    delta == null ? null
    : delta > 0 ? TrendingUp
    : delta < 0 ? TrendingDown
    : Minus;

  return (
    <Card className="border-border/40" data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="space-y-1 min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground truncate">
              {title}
              {subtitle && <span className="ml-1 opacity-70">{subtitle}</span>}
            </p>
            {loading ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <p className="text-xl font-semibold tabular-nums tracking-tight" data-testid={testId ? `${testId}-value` : undefined}>
                {value}
              </p>
            )}
            {!loading && delta != null && (
              <div className={`flex items-center gap-1 text-xs ${deltaColor}`}>
                {DeltaIcon && <DeltaIcon className="h-3 w-3" />}
                <span className="tabular-nums">{delta > 0 ? '+' : ''}{delta.toFixed(1)}%</span>
                <span className="text-muted-foreground ml-0.5">vs prev</span>
              </div>
            )}
          </div>
          <div className="ml-3 p-2 rounded-lg bg-primary/10 text-primary shrink-0">
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
