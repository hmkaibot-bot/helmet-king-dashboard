import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { type LucideIcon } from 'lucide-react';

interface KpiCardProps {
  title: string;
  subtitle?: string;
  value: string;
  icon: LucideIcon;
  loading?: boolean;
  testId?: string;
}

export function KpiCard({ title, subtitle, value, icon: Icon, loading, testId }: KpiCardProps) {
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
          </div>
          <div className="ml-3 p-2 rounded-lg bg-primary/10 text-primary shrink-0">
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
