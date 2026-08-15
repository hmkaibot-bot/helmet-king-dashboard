import { lazy, Suspense, useEffect, useState } from "react";
import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DateProvider } from "@/lib/date-context";
import { ThemeProvider } from "@/lib/theme";
import { AppLayout } from "@/components/app-layout";
import { ErrorBoundary } from "@/components/error-boundary";
import LoginPage from "@/pages/login";
import { supabase } from "@/lib/supabase";
import { LogOut } from "lucide-react";

// 每頁獨立 chunk (lazy) — 首次載入唔使等成個 dashboard 嘅 JS
const OverviewPage = lazy(() => import("@/pages/overview"));
const RetailSalesPage = lazy(() => import("@/pages/retail-sales"));
const RetailInventoryPage = lazy(() => import("@/pages/retail-inventory"));
const RetailCustomersPage = lazy(() => import("@/pages/retail-customers"));
const RetailBrandsPage = lazy(() => import("@/pages/retail-brands"));
const GarageOrdersPage = lazy(() => import("@/pages/garage-orders"));
const GarageServicesPage = lazy(() => import("@/pages/garage-services"));
const MarketingPage = lazy(() => import("@/pages/marketing"));
const MarketingPostsPage = lazy(() => import("@/pages/marketing-posts"));
const MarketingPromoWatchPage = lazy(() => import("@/pages/marketing-promo-watch"));
const InquiryConversionPage = lazy(() => import("@/pages/inquiry-conversion"));
const RetailCommissionPage = lazy(() => import("@/pages/retail-commission"));
const FinancePage = lazy(() => import("@/pages/finance"));
const RestockPage = lazy(() => import("@/pages/restock"));
const DeadStockPage = lazy(() => import("@/pages/dead-stock"));
const StocktakePage = lazy(() => import("@/pages/stocktake"));
const PromotionsPage = lazy(() => import("@/pages/promotions"));
const PromotionsItemsPage = lazy(() => import("@/pages/promotions-items"));
const PromotionsHistoryPage = lazy(() => import("@/pages/promotions-history"));
const PromotionDetailPage = lazy(() => import("@/pages/promotions-detail"));
const VendorsPage = lazy(() => import("@/pages/vendors"));
const ReturnsPage = lazy(() => import("@/pages/returns"));
const DailyWeeklyPage = lazy(() => import("@/pages/daily-weekly"));
const VelocityPage = lazy(() => import("@/pages/velocity"));
const NewProductsPage = lazy(() => import("@/pages/new-products"));
const WeeklyReviewPage = lazy(() => import("@/pages/weekly-review"));
const MonthlyReviewPage = lazy(() => import("@/pages/monthly-review"));
const MarselloApprovalPage = lazy(() => import("@/pages/marsello-approval"));
const ProductAnalyticsPage = lazy(() => import("@/pages/product-analytics"));
const ForecastPage = lazy(() => import("@/pages/forecast"));
const CategoryQcPage = lazy(() => import("@/pages/category-qc"));
const ProductEditorPage = lazy(() => import("@/pages/product-editor"));
const PriceWatchPage = lazy(() => import("@/pages/price-watch"));
const SyncStatusPage = lazy(() => import("@/pages/sync-status"));
const NotFound = lazy(() => import("@/pages/not-found"));

function PageLoading() {
  return (
    <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
      載入中…
    </div>
  );
}

function AppRouter() {
  return (
    <AppLayout>
      <ErrorBoundary>
      <Suspense fallback={<PageLoading />}>
      <Switch>
        <Route path="/" component={OverviewPage} />
        <Route path="/retail/sales" component={RetailSalesPage} />
        <Route path="/retail/inventory" component={RetailInventoryPage} />
        <Route path="/retail/customers" component={RetailCustomersPage} />
        <Route path="/retail/brands" component={RetailBrandsPage} />
        <Route path="/garage/orders" component={GarageOrdersPage} />
        <Route path="/garage/services" component={GarageServicesPage} />
        <Route path="/marketing" component={MarketingPage} />
        <Route path="/marketing/posts" component={MarketingPostsPage} />
        <Route path="/marketing/promo-watch" component={MarketingPromoWatchPage} />
        <Route path="/marketing/inquiry-conversion" component={InquiryConversionPage} />
        <Route path="/finance" component={FinancePage} />
        <Route path="/finance/retail-commission" component={RetailCommissionPage} />
        <Route path="/retail/restock" component={RestockPage} />
        <Route path="/retail/dead-stock" component={DeadStockPage} />
        <Route path="/retail/stocktake" component={StocktakePage} />
        <Route path="/retail/promotions" component={PromotionsPage} />
        <Route path="/retail/promotions/items" component={PromotionsItemsPage} />
        <Route path="/retail/promotions/history" component={PromotionsHistoryPage} />
        <Route path="/retail/promotions/:id" component={PromotionDetailPage} />
        <Route path="/retail/returns" component={ReturnsPage} />
        <Route path="/retail/category-qc" component={CategoryQcPage} />
        <Route path="/retail/product-editor" component={ProductEditorPage} />
        <Route path="/retail/price-watch" component={PriceWatchPage} />
        <Route path="/procurement/vendors" component={VendorsPage} />
        <Route path="/performance/daily" component={DailyWeeklyPage} />
        <Route path="/performance/velocity" component={VelocityPage} />
        <Route path="/performance/new-products" component={NewProductsPage} />
        <Route path="/performance/weekly-review" component={WeeklyReviewPage} />
        <Route path="/performance/monthly-review" component={MonthlyReviewPage} />
        <Route path="/crm/marsello-approval" component={MarselloApprovalPage} />
        <Route path="/performance/product-analytics" component={ProductAnalyticsPage} />
        <Route path="/performance/forecast" component={ForecastPage} />
        <Route path="/system/sync-status" component={SyncStatusPage} />
        <Route component={NotFound} />
      </Switch>
      </Suspense>
      </ErrorBoundary>
    </AppLayout>
  );
}

// 盤點角色專用外殼:成個 app 淨係得盤點頁,冇側欄冇其他路由(第一步 UI 鎖)
function StocktakeOnlyApp() {
  const { logout } = useAuth();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 h-12 border-b border-border bg-background/95 backdrop-blur flex items-center justify-between px-4">
        <span className="font-bold text-sm">頭盔王 · 盤點 Stocktake</span>
        <button
          onClick={logout}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          data-testid="button-stocktake-logout"
        >
          <LogOut className="h-3.5 w-3.5" /> 登出
        </button>
      </header>
      <main className="p-4">
        <ErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <StocktakePage staffMode />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function AuthGate() {
  const { isAuthenticated, loading, userEmail } = useAuth();
  // 角色:null = 全功能;'stocktake' = 淨係盤點;undefined = 查緊
  const [role, setRole] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isAuthenticated || !userEmail) { setRole(undefined); return; }
    let cancelled = false;
    supabase.from('app_roles').select('role').eq('email', userEmail).maybeSingle()
      .then(({ data }) => { if (!cancelled) setRole((data as any)?.role ?? null); });
    return () => { cancelled = true; };
  }, [isAuthenticated, userEmail]);

  if (loading) return null;
  if (!isAuthenticated) return <LoginPage />;
  if (role === undefined) return <PageLoading />;
  if (role === 'stocktake') return <StocktakeOnlyApp />;
  return (
    <DateProvider>
      <Router hook={useHashLocation}>
        <AppRouter />
      </Router>
    </DateProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <Toaster />
            <AuthGate />
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
