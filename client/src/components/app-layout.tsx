import { type ReactNode, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { HelmetLogo } from './helmet-logo';
import { DataFreshnessBadge } from './data-freshness';
import { useDateRange } from '@/lib/date-context';
import { useAuth } from '@/lib/auth';
import { DATE_RANGE_LABELS, type DateRange } from '@/lib/format';
import {
  LayoutDashboard,
  ShoppingBag,
  BarChart3,
  Warehouse,
  Users,
  Tag,
  Wrench,
  ClipboardList,
  Cog,
  Megaphone,
  Receipt,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  LogOut,
  Calendar,
  PackageSearch,
  RotateCcw,
  Truck,
  Building2,
  CalendarCheck,
  TrendingUp,
  Activity,
  Sparkles,
  ClipboardCheck,
  Award,
  Sun,
  Moon,
  LineChart,
  Archive,
  History,
  Package,
  RefreshCw,
  Tags,
  FileEdit,
  Scale,
  PenLine,
  Coins,
  Radar,
  MessageCircle,
} from 'lucide-react';
import { clearQueryCache } from '@/lib/query-helpers';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface NavItem {
  path: string;
  label: string;
  sublabel: string;
  icon: any;
  children?: NavItem[];
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '總覽', sublabel: 'Overview', icon: LayoutDashboard },
  {
    path: '/retail',
    label: '零售',
    sublabel: 'Retail',
    icon: ShoppingBag,
    children: [
      { path: '/retail/sales', label: '銷售', sublabel: 'Sales', icon: BarChart3 },
      { path: '/retail/inventory', label: '庫存', sublabel: 'Inventory', icon: Warehouse },
      { path: '/retail/customers', label: '客戶', sublabel: 'Customers', icon: Users },
      { path: '/retail/brands', label: '品牌分析', sublabel: 'Brands', icon: Tag },
      { path: '/retail/category-qc', label: '分類清理', sublabel: 'Category QC', icon: Tags },
      { path: '/retail/product-editor', label: '商品編輯', sublabel: 'Product Editor', icon: FileEdit },
      { path: '/retail/price-watch', label: '格價', sublabel: 'Price Watch', icon: Scale },
      { path: '/retail/restock', label: '補貨管理', sublabel: 'Restock', icon: PackageSearch },
      { path: '/retail/dead-stock', label: '庫存管理', sublabel: 'Stock Status', icon: Archive },
      { path: '/retail/promotions', label: '推廣活動', sublabel: 'Promotions', icon: Megaphone },
      { path: '/retail/promotions/items', label: '推廣商品', sublabel: 'Promo Items', icon: Package },
      { path: '/retail/promotions/history', label: '推廣歷史', sublabel: 'Promo History', icon: History },
      { path: '/retail/returns', label: '退貨', sublabel: 'Returns', icon: RotateCcw },
    ],
  },
  {
    path: '/garage',
    label: '車房',
    sublabel: 'Garage',
    icon: Wrench,
    children: [
      { path: '/garage/orders', label: '工單', sublabel: 'Work Orders', icon: ClipboardList },
      { path: '/garage/services', label: '服務分析', sublabel: 'Services', icon: Cog },
    ],
  },
  {
    path: '/procurement',
    label: '採購',
    sublabel: 'Procurement',
    icon: Truck,
    children: [
      { path: '/procurement/vendors', label: '供應商', sublabel: 'Vendors', icon: Building2 },
    ],
  },
  {
    path: '/performance',
    label: '報告',
    sublabel: 'Reports',
    icon: CalendarCheck,
    children: [
      { path: '/performance/daily',         label: '昨日/本週',   sublabel: 'Daily/Weekly',      icon: Calendar },
      { path: '/performance/weekly-review',  label: '週報',        sublabel: 'Weekly Review',     icon: ClipboardCheck },
      { path: '/performance/velocity',       label: '銷售速率',    sublabel: 'Sales Velocity',    icon: TrendingUp },
      { path: '/performance/new-products',   label: '新品表現',    sublabel: 'New Products',      icon: Sparkles },
      { path: '/performance/product-analytics', label: '商品分析', sublabel: 'Product Analytics',  icon: BarChart3 },
      { path: '/performance/forecast',          label: '需求預測',   sublabel: 'Demand Forecast',    icon: LineChart },
    ],
  },
  {
    path: '/crm',
    label: '會員/CRM',
    sublabel: 'CRM',
    icon: Award,
    children: [
      { path: '/crm/marsello-approval', label: 'Marsello 積分', sublabel: 'Points Approval', icon: Award },
    ],
  },
  {
    path: '/marketing',
    label: '營銷',
    sublabel: 'Marketing',
    icon: Megaphone,
    children: [
      { path: '/marketing', label: '營銷效果', sublabel: 'Marketing', icon: BarChart3 },
      { path: '/marketing/posts', label: '營銷貼文', sublabel: 'Post Studio', icon: PenLine },
      { path: '/marketing/promo-watch', label: '推廣監察', sublabel: 'Promo Watch', icon: Radar },
      { path: '/marketing/inquiry-conversion', label: '查詢與轉換', sublabel: 'Conversion', icon: MessageCircle },
    ],
  },
  {
    path: '/finance',
    label: '財務',
    sublabel: 'Finance',
    icon: Receipt,
    children: [
      { path: '/finance', label: '財務概覽', sublabel: 'Overview', icon: Receipt },
      { path: '/finance/retail-commission', label: '零售佣金', sublabel: 'Retail Commission', icon: Coins },
    ],
  },
  { path: '/system/sync-status', label: '同步狀態', sublabel: 'Sync Status', icon: Activity },
];

function findCurrentPage(location: string): { label: string; sublabel: string } {
  // child 行先 — '/marketing' 同時係 group path 同 child path,header 應該顯示 child 個名
  for (const item of NAV_ITEMS) {
    if (item.children) {
      for (const child of item.children) {
        if (child.path === location) return child;
      }
    }
  }
  for (const item of NAV_ITEMS) {
    if (item.path === location) return item;
  }
  return NAV_ITEMS[0];
}

function isParentActive(item: NavItem, location: string): boolean {
  if (item.path === location) return true;
  return item.children?.some((c) => c.path === location) ?? false;
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({ '/retail': true, '/garage': true, '/procurement': true, '/performance': true, '/crm': true, '/marketing': true, '/finance': true });
  const [location] = useLocation();
  const { dateRange, setDateRange, customFrom, customTo, setCustomFrom, setCustomTo } = useDateRange();

  // 呢啲頁面冇 subscribe date filter (見 useDateRange / bounds usage)，所以隱藏 dropdown 避免誤導
  const PAGES_WITHOUT_DATE_FILTER = [
    '/retail/dead-stock',
    '/retail/promotions',
    '/retail/promotions/items',
    '/retail/promotions/history',
    '/marketing/posts',
    '/marketing/promo-watch',
    '/retail/inventory',
    '/retail/restock',
    '/performance/daily',
    '/performance/velocity',
    '/performance/new-products',
    '/performance/weekly-review',
    '/finance/retail-commission',
    '/performance/product-analytics',
    '/performance/forecast',
    '/crm/marsello-approval',
  ];
  const showDateFilter = !PAGES_WITHOUT_DATE_FILTER.includes(location);
  const { logout } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();

  const currentPage = findCurrentPage(location);

  const toggleGroup = (path: string) => {
    setExpandedGroups((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={`flex flex-col border-r border-border/50 bg-sidebar transition-all duration-200 shrink-0 ${
          collapsed ? 'w-16' : 'w-56'
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
            const hasChildren = !!item.children;
            const isActive = isParentActive(item, location);
            const isExpanded = expandedGroups[item.path] ?? false;

            if (hasChildren) {
              return (
                <div key={item.path}>
                  <button
                    onClick={() => toggleGroup(item.path)}
                    className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm cursor-pointer transition-colors w-full ${
                      isActive
                        ? 'text-primary font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    }`}
                    data-testid={`nav-${item.sublabel.toLowerCase()}`}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {!collapsed && (
                      <>
                        <div className="min-w-0 flex-1 text-left">
                          <span className="block text-sm leading-tight truncate">{item.label}</span>
                          <span className="block text-[10px] opacity-60 leading-tight">{item.sublabel}</span>
                        </div>
                        <ChevronDown
                          className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                        />
                      </>
                    )}
                  </button>
                  {!collapsed && isExpanded && (
                    <div className="ml-4 pl-2 border-l border-border/30 space-y-0.5 mt-0.5">
                      {item.children!.map((child) => {
                        const childActive = location === child.path;
                        return (
                          <Link key={child.path} href={child.path}>
                            <div
                              data-testid={`nav-${child.sublabel.toLowerCase()}`}
                              className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors ${
                                childActive
                                  ? 'bg-primary/10 text-primary font-medium'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                              }`}
                            >
                              <child.icon className="h-3.5 w-3.5 shrink-0" />
                              <div className="min-w-0">
                                <span className="block text-xs leading-tight truncate">{child.label}</span>
                                <span className="block text-[9px] opacity-60 leading-tight">{child.sublabel}</span>
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            // Top-level item without children
            const itemActive = location === item.path;
            return (
              <Link key={item.path} href={item.path}>
                <div
                  data-testid={`nav-${item.sublabel.toLowerCase()}`}
                  className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm cursor-pointer transition-colors ${
                    itemActive
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
        <header className="flex items-center justify-between h-14 px-4 border-b border-border/50 shrink-0 bg-background/80 backdrop-blur-sm sticky top-0 z-10">
          <div>
            <h1 className="text-base font-semibold leading-tight">{currentPage.label}</h1>
            <p className="text-xs text-muted-foreground">{currentPage.sublabel}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Data freshness badge — 讀取 shopify_orders 最新 updated_at */}
            <DataFreshnessBadge />
            {/* 強制刷新 — 清晒 memory + IndexedDB cache 再重新載入 (手動觸發 sync 之後用) */}
            <button
              onClick={() => { clearQueryCache(); window.location.reload(); }}
              title="刷新數據 (清除本地 cache 重新載入)"
              className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              data-testid="button-refresh-data"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            {/* Light / Dark toggle */}
            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? '切換白天模式' : '切換深色模式'}
              className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {theme === 'dark'
                ? <Sun className="h-4 w-4" />
                : <Moon className="h-4 w-4" />
              }
            </button>
            {showDateFilter && dateRange === 'custom' && (
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-8 px-2 text-xs rounded-md border border-border bg-background"
                  data-testid="input-custom-from"
                />
                <span className="text-xs text-muted-foreground">–</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-8 px-2 text-xs rounded-md border border-border bg-background"
                  data-testid="input-custom-to"
                />
              </div>
            )}
            {showDateFilter && (
              <>
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
                  <SelectTrigger className="w-[130px] h-8 text-xs" data-testid="select-date-range">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DATE_RANGE_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key} className="text-xs">
                        {label.zh} {label.en}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
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
