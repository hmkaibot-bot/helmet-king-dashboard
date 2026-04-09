import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { DateProvider } from "@/lib/date-context";
import { AppLayout } from "@/components/app-layout";
import LoginPage from "@/pages/login";
import SalesPage from "@/pages/sales";
import ProductsPage from "@/pages/products";
import CustomersPage from "@/pages/customers";
import MarketingPage from "@/pages/marketing";
import FinancePage from "@/pages/finance";
import InventoryPage from "@/pages/inventory";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={SalesPage} />
        <Route path="/products" component={ProductsPage} />
        <Route path="/customers" component={CustomersPage} />
        <Route path="/marketing" component={MarketingPage} />
        <Route path="/finance" component={FinancePage} />
        <Route path="/inventory" component={InventoryPage} />
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
