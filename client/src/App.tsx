import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DateProvider } from "@/lib/date-context";
import { AppLayout } from "@/components/app-layout";
import LoginPage from "@/pages/login";
import OverviewPage from "@/pages/overview";
import RetailSalesPage from "@/pages/retail-sales";
import RetailInventoryPage from "@/pages/retail-inventory";
import RetailCustomersPage from "@/pages/retail-customers";
import RetailBrandsPage from "@/pages/retail-brands";
import GarageOrdersPage from "@/pages/garage-orders";
import GarageServicesPage from "@/pages/garage-services";
import MarketingPage from "@/pages/marketing";
import FinancePage from "@/pages/finance";
import RestockPage from "@/pages/restock";
import VendorsPage from "@/pages/vendors";
import ReturnsPage from "@/pages/returns";
import DailyWeeklyPage from "@/pages/daily-weekly";
import VelocityPage from "@/pages/velocity";
import NewProductsPage from "@/pages/new-products";
import WeeklyReviewPage from "@/pages/weekly-review";
import MarselloApprovalPage from "@/pages/marsello-approval";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={OverviewPage} />
        <Route path="/retail/sales" component={RetailSalesPage} />
        <Route path="/retail/inventory" component={RetailInventoryPage} />
        <Route path="/retail/customers" component={RetailCustomersPage} />
        <Route path="/retail/brands" component={RetailBrandsPage} />
        <Route path="/garage/orders" component={GarageOrdersPage} />
        <Route path="/garage/services" component={GarageServicesPage} />
        <Route path="/marketing" component={MarketingPage} />
        <Route path="/finance" component={FinancePage} />
        <Route path="/retail/restock" component={RestockPage} />
        <Route path="/retail/returns" component={ReturnsPage} />
        <Route path="/procurement/vendors" component={VendorsPage} />
        <Route path="/performance/daily" component={DailyWeeklyPage} />
        <Route path="/performance/velocity" component={VelocityPage} />
        <Route path="/performance/new-products" component={NewProductsPage} />
        <Route path="/performance/weekly-review" component={WeeklyReviewPage} />
        <Route path="/crm/marsello-approval" component={MarselloApprovalPage} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function AuthGate() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <LoginPage />;
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
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <Toaster />
          <AuthGate />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
