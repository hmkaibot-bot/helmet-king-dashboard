import { createContext, useContext, useState, type ReactNode } from 'react';
import { type DateRange } from './format';

interface DateContextType {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
}

const DateContext = createContext<DateContextType | null>(null);

export function DateProvider({ children }: { children: ReactNode }) {
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  return (
    <DateContext.Provider value={{ dateRange, setDateRange }}>
      {children}
    </DateContext.Provider>
  );
}

export function useDateRange() {
  const ctx = useContext(DateContext);
  if (!ctx) throw new Error('useDateRange must be used within DateProvider');
  return ctx;
}
