import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { type ReactNode } from 'react';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  note?: string;
  children: ReactNode;
  loading?: boolean;
  className?: string;
}

export function ChartCard({ title, subtitle, note, children, loading, className = '' }: ChartCardProps) {
  return (
    <Card className={`border-border/40 ${className}`}>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-medium">
          {title}
          {subtitle && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{subtitle}</span>}
        </CardTitle>
        {note && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{note}</p>}
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-[200px] w-full" />
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
