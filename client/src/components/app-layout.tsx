import { type ReactNode, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { HelmetLogo } from './helmet-logo';
import { useDateRange } from '@/lib/date-context';
import { useAuth } from '@/lib/auth';
import { DATE_RANGE_LABELS, type DateRange } from '@/lib/format';
import {
  BarChart3,
  Package,
  Users,
  Megaphone,
  Receipt,
  Warehouse,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Calendar,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const NAV_ITEMS = [
  { path: '/', label: '銷售總覽', sublabel: 'Sales', icon: BarChart3 },
  { path: '/products', label: '產品分析', sublabel: 'Products', icon: Package },
  { path: '/customers', label: '客戶分析', sublabel: 'Customers', icon: Users },
  { path: '/marketing', label: '營銷效果', sublabel: 'Marketing', icon: Megaphone },
  { path: '/finance', label: '財務概覽', sublabel: 'Finance', icon: Receipt },
  { path: '/inventory', label: '庫存管理', sublabel: 'Inventory', icon: Warehouse },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [location] = useLocation();
  const { dateRange, setDateRange } = useDateRange();
  const { logout } = useAuth();

  const currentPage = NAV_ITEMS.find((item) => item.path === location) || NAV_ITEMS[0];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={`flex flex-col border-r border-border/50 bg-sidebar transition-all duration-200 shrink-0 ${
          collapsed ? 'w-16' : 'w-52'
        }`}
      >
        {/* Logo area */}
        <div className="flex items-center gap-2.5 px-3 h-14 border-b border-border/50 shrink-0">
          <HelmetLogo size={28} className="shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate leading-tight">頭盔王</p>
              <p className="text-[10px] text-muted-foreground leading-tight">Helmet King</p>
            </div>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.path;
            return (
              <Link key={item.path} href={item.path}>
                <div
                  data-testid={`nav-${item.sublabel.toLowerCase()}`}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  }`}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {!collapsed && (
                    <div className="min-w-0">
                      <span className="block text-sm leading-tight truncate">{item.label}</span>
                      <span className="block text-[10px] opacity-60 leading-tight">{item.sublabel}</span>
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Bottom controls */}
        <div className="border-t border-border/50 p-2 space-y-1 shrink-0">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center justify-center w-full py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            data-testid="button-toggle-sidebar"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
          <button
            onClick={logout}
            className="flex items-center justify-center w-full gap-2 py-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-accent/50 transition-colors text-xs"
            data-testid="button-logout"
          >
            <LogOut className="h-3.5 w-3.5" />
            {!collapsed && <span>登出 Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between h-14 px-4 border-b border-border/50 shrink-0 bg-background/80 backdrop-blur-sm">
          <div>
            <h1 className="text-base font-semibold leading-tight">{currentPage.label}</h1>
            <p className="text-xs text-muted-foreground">{currentPage.sublabel} Overview</p>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
              <SelectTrigger className="w-[130px] h-8 text-xs" data-testid="select-date-range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DATE_RANGE_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4">
          {children}
        </main>
      </div>
    </div>
  );
}
