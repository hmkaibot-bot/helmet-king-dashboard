import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';
import { type DateRange, type DateBounds, getDateBounds, getPreviousPeriodBounds } from './format';

interface DateContextType {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  customFrom: string;
  customTo: string;
  setCustomFrom: (d: string) => void;
  setCustomTo: (d: string) => void;
  bounds: DateBounds;
  prevBounds: DateBounds;
}

const DateContext = createContext<DateContextType | null>(null);

export function DateProvider({ children }: { children: ReactNode }) {
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const bounds = useMemo(
    () => getDateBounds(dateRange, customFrom, customTo),
    [dateRange, customFrom, customTo]
  );

  const prevBounds = useMemo(() => getPreviousPeriodBounds(bounds), [bounds]);

  return (
    <DateContext.Provider
      value={{ dateRange, setDateRange, customFrom, customTo, setCustomFrom, setCustomTo, bounds, prevBounds }}
    >
      {children}
    </DateContext.Provider>
  );
}

export function useDateRange() {
  const ctx = useContext(DateContext);
  if (!ctx) throw new Error('useDateRange must be used within DateProvider');
  return ctx;
}
