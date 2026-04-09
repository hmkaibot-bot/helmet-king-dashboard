import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { queryAll, queryWithDateRange } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { Package, AlertTriangle, XCircle, DollarSign, Clock, RefreshCw, Leaf, Skull, Tag, ChevronRight, ChevronDown, History, Search, X, Filter } from 'lucide-react';
import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ── Types ──────────────────────────────────────────────────

interface ProcurementEvent {
  date: string;
  invoiceNumber: string;
  qty: number;
  unitCost: number;
}

interface ItemProcurement {
  firstPurchaseDate: string;
  restockCount: number;
  events: ProcurementEvent[];
}

interface FilterState {
  vendors: string[];
  productTypes: string[];
  stockStatus: 'all' | 'in_stock' | 'out_of_stock' | 'low_stock';
  minPrice: string;
  maxPrice: string;
  search: string;
}

const DEFAULT_FILTERS: FilterState = {
  vendors: [],
  productTypes: [],
  stockStatus: 'all',
  minPrice: '',
  maxPrice: '',
  search: '',
};

// ── Paginated Supabase fetch ──────────────────────────────

async function fetchAllInventory(): Promise<any[]> {
  let allInventory: any[] = [];
  let from = 0;
  const pageSize = 1000; // Supabase REST API max is 1000 rows per request
  while (true) {
    const { data } = await supabase
      .from('shopify_inventory')
      .select('variant_id, product_id, product_title, sku, price, inventory_quantity, vendor, product_type')
      .gt('price', 0)
      .range(from, from + pageSize - 1);
    if (!data || data.length === 0) break;
    allInventory = [...allInventory, ...data];
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allInventory;
}

// ── MultiSelect Component ─────────────────────────────────

function MultiSelect({ label, options, selected, onChange }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = searchTerm
    ? options.filter(o => (o || '').toLowerCase().includes(searchTerm.toLowerCase()))
    : options;

  const displayText = selected.length === 0
    ? label
    : selected.length === 1
      ? selected[0] || 'Unknown'
      : `${selected[0] || 'Unknown'} (+${selected.length - 1})`;

  const hasSelection = selected.length > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border transition-colors whitespace-nowrap ${
          hasSelection
            ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
            : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600'
        }`}
      >
        <Filter className="h-3 w-3 shrink-0 opacity-60" />
        <span className="max-w-[140px] truncate">{displayText}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl w-60" style={{ maxHeight: 320, display: 'flex', flexDirection: 'column' }}>
          <div className="p-2 border-b border-gray-700">
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-600 rounded text-gray-300 placeholder-gray-500 focus:outline-none focus:border-gray-500"
              autoFocus
            />
          </div>
          <div className="overflow-y-auto flex-1" style={{ maxHeight: 256 }}>
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-500 text-center">No matches</div>
            )}
            {filtered.map(opt => (
              <label key={opt} className="flex items-center px-3 py-1.5 hover:bg-gray-700/60 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => {
                    onChange(selected.includes(opt) ? selected.filter(s => s !== opt) : [...selected, opt]);
                  }}
                  className="mr-2 accent-amber-500 h-3 w-3"
                />
                <span className="text-xs text-gray-300 truncate">{opt || 'Unknown'}</span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button
              className="w-full px-3 py-1.5 text-[10px] text-gray-400 hover:text-gray-200 border-t border-gray-700 text-center"
              onClick={() => { onChange([]); }}
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Procurement History Sub-Row ────────────────────────────

function ProcurementRow({ procurement, colSpan }: { procurement: ItemProcurement; colSpan: number }) {
  return (
    <tr className="bg-accent/5">
      <td colSpan={colSpan} className="px-4 py-2">
        <div className="flex items-center gap-1.5 mb-1.5">
          <History className="h-3 w-3 text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">
            First purchased: <span className="text-foreground font-medium">{procurement.firstPurchaseDate?.slice(0, 10) || '—'}</span>
            {' | '}Restocked: <span className="text-foreground font-medium">{procurement.restockCount} time{procurement.restockCount !== 1 ? 's' : ''}</span>
          </span>
        </div>
        {procurement.events.length > 0 ? (
          <table className="w-full text-[11px] ml-4">
            <thead>
              <tr className="text-muted-foreground/70">
                <th className="py-1 text-left font-medium">Date</th>
                <th className="py-1 text-left font-medium">Invoice#</th>
                <th className="py-1 text-right font-medium">Qty Purchased</th>
                <th className="py-1 text-right font-medium">Unit Cost</th>
              </tr>
            </thead>
            <tbody>
              {procurement.events.map((e, j) => (
                <tr key={j} className="border-t border-border/10">
                  <td className="py-1 tabular-nums">{e.date?.slice(0, 10) || '—'}</td>
                  <td className="py-1 font-mono">{e.invoiceNumber || '—'}</td>
                  <td className="py-1 text-right tabular-nums">{e.qty}</td>
                  <td className="py-1 text-right tabular-nums">{formatCurrency(e.unitCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[11px] text-muted-foreground/60 ml-4">No procurement records found</p>
        )}
      </td>
    </tr>
  );
}

// ── Main Component ─────────────────────────────────────────

export default function RetailInventoryPage() {
  const [loading, setLoading] = useState(true);
  const [inventory, setInventory] = useState<any[]>([]);
  const [bcInventory, setBcInventory] = useState<any[]>([]);
  const [purchaseCountByItem, setPurchaseCountByItem] = useState<Record<string, number>>({});
  const [lastPurchaseDateByItem, setLastPurchaseDateByItem] = useState<Record<string, string>>({});
  const [salesByProduct, setSalesByProduct] = useState<Record<string, { qty: number; lastSaleDate: string }>>({});
  const [procurementByItem, setProcurementByItem] = useState<Record<string, ItemProcurement>>({});

  // Filter state
  const [filters, setFilters] = useState<FilterState>({ ...DEFAULT_FILTERS });

  // Track which SKU row is expanded (only one at a time)
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const toggleExpand = useCallback((sku: string) => {
    setExpandedSku((prev) => prev === sku ? null : sku);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [inv, bcInv, purchaseLines, purchaseInvoices, orderLines, orders] = await Promise.all([
          fetchAllInventory(),
          queryAll('bc_inventory', 'number,display_name,unit_price,unit_cost,item_category_code', undefined, 50000),
          queryAll('bc_purchase_invoice_lines', 'invoice_id,invoice_number,item_number,quantity,unit_cost', undefined, 50000),
          queryAll('bc_purchase_invoices', 'id,posting_date,number', undefined, 50000),
          queryAll('shopify_order_lines', 'order_id,product_id,title,sku,vendor,quantity', undefined, 50000),
          queryAll('shopify_orders', 'id,created_at,financial_status,cancelled_at', undefined, 50000),
        ]);
        if (cancelled) return;

        setInventory(inv);
        setBcInventory(bcInv);

        // Build invoice lookup: id → { posting_date, number }
        const invoiceLookup: Record<string, { posting_date: string; number: string }> = {};
        purchaseInvoices.forEach((pi: any) => {
          invoiceLookup[pi.id] = { posting_date: pi.posting_date || '', number: pi.number || '' };
        });

        // Purchase count per item (from bc_purchase_invoice_lines)
        const pcMap: Record<string, Set<string>> = {};
        purchaseLines.forEach((l: any) => {
          if (!l.item_number) return;
          if (!pcMap[l.item_number]) pcMap[l.item_number] = new Set();
          pcMap[l.item_number].add(l.invoice_id || l.invoice_number);
        });
        const countMap: Record<string, number> = {};
        Object.entries(pcMap).forEach(([k, v]) => { countMap[k] = v.size; });
        setPurchaseCountByItem(countMap);

        // Last purchase date per item
        const lpMap: Record<string, string> = {};
        purchaseLines.forEach((l: any) => {
          if (!l.item_number) return;
          const inv = invoiceLookup[l.invoice_id];
          const date = inv?.posting_date || '';
          if (date && (!lpMap[l.item_number] || date > lpMap[l.item_number])) {
            lpMap[l.item_number] = date;
          }
        });
        setLastPurchaseDateByItem(lpMap);

        // ── Build full procurement history per item ──
        const historyMap: Record<string, ProcurementEvent[]> = {};
        purchaseLines.forEach((l: any) => {
          if (!l.item_number) return;
          const inv = invoiceLookup[l.invoice_id];
          if (!historyMap[l.item_number]) historyMap[l.item_number] = [];
          historyMap[l.item_number].push({
            date: inv?.posting_date || '',
            invoiceNumber: l.invoice_number || inv?.number || '',
            qty: l.quantity || 0,
            unitCost: parseFloat(l.unit_cost) || 0,
          });
        });

        const procMap: Record<string, ItemProcurement> = {};
        Object.entries(historyMap).forEach(([itemNumber, events]) => {
          events.sort((a, b) => b.date.localeCompare(a.date));
          const firstDate = events.length > 0 ? events[events.length - 1].date : '';
          const distinctInvoices = new Set(events.map((e) => e.invoiceNumber || e.date));
          procMap[itemNumber] = {
            firstPurchaseDate: firstDate,
            restockCount: distinctInvoices.size,
            events,
          };
        });
        setProcurementByItem(procMap);

        // Sales by product
        const validOrders = orders.filter((o: any) => o.financial_status !== 'refunded' && !o.cancelled_at);
        const orderDateMap: Record<string, string> = {};
        validOrders.forEach((o: any) => { orderDateMap[o.id] = o.created_at; });
        const validIds = new Set(validOrders.map((o: any) => o.id));

        const salesMap: Record<string, { qty: number; lastSaleDate: string }> = {};
        orderLines.filter((l: any) => validIds.has(l.order_id)).forEach((l: any) => {
          const key = l.sku || l.title;
          const date = orderDateMap[l.order_id] || '';
          if (!salesMap[key]) salesMap[key] = { qty: 0, lastSaleDate: '' };
          salesMap[key].qty += l.quantity || 0;
          if (date > salesMap[key].lastSaleDate) salesMap[key].lastSaleDate = date;
        });
        setSalesByProduct(salesMap);
      } catch (e) {
        console.error('Inventory error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Filter logic ────────────────────────────────────────

  const applyFilters = useCallback((items: any[]) => {
    const { vendors, productTypes, stockStatus, minPrice, maxPrice, search } = filters;
    const minP = minPrice ? parseFloat(minPrice) : null;
    const maxP = maxPrice ? parseFloat(maxPrice) : null;
    const searchLower = search.trim().toLowerCase();
    return items.filter(item => {
      if (vendors.length > 0 && !vendors.includes(item.vendor)) return false;
      if (productTypes.length > 0 && !productTypes.includes(item.product_type)) return false;
      if (stockStatus === 'in_stock' && (item.inventory_quantity || 0) <= 0) return false;
      if (stockStatus === 'out_of_stock' && (item.inventory_quantity || 0) > 0) return false;
      if (stockStatus === 'low_stock' && ((item.inventory_quantity || 0) === 0 || (item.inventory_quantity || 0) > 2)) return false;
      if (minP !== null && (parseFloat(item.price) || 0) < minP) return false;
      if (maxP !== null && (parseFloat(item.price) || 0) > maxP) return false;
      if (searchLower) {
        const title = (item.product_title || '').toLowerCase();
        const sku = (item.sku || '').toLowerCase();
        if (!title.includes(searchLower) && !sku.includes(searchLower)) return false;
      }
      return true;
    });
  }, [filters]);

  // Filtered inventory (applies to all tabs)
  const filteredInventory = useMemo(() => applyFilters(inventory), [inventory, applyFilters]);

  // Distinct filter options from full dataset
  const vendorOptions = useMemo(() => {
    const set = new Set<string>();
    inventory.forEach((i: any) => { if (i.vendor) set.add(i.vendor); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [inventory]);

  const productTypeOptions = useMemo(() => {
    const set = new Set<string>();
    inventory.forEach((i: any) => { if (i.product_type) set.add(i.product_type); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [inventory]);

  const hasActiveFilters = filters.vendors.length > 0 || filters.productTypes.length > 0 || filters.stockStatus !== 'all' || filters.minPrice !== '' || filters.maxPrice !== '' || filters.search !== '';

  // BC cost lookup
  const bcCostMap = useMemo(() => {
    const map: Record<string, { unitPrice: number; unitCost: number }> = {};
    bcInventory.forEach((item: any) => {
      if (item.number) map[item.number] = { unitPrice: parseFloat(item.unit_price) || 0, unitCost: parseFloat(item.unit_cost) || 0 };
    });
    return map;
  }, [bcInventory]);

  // Basic KPIs — based on filtered inventory
  const active = filteredInventory.filter((i: any) => (i.inventory_quantity || 0) > 0);
  const oos = filteredInventory.filter((i: any) => (i.inventory_quantity || 0) === 0);
  const low = filteredInventory.filter((i: any) => (i.inventory_quantity || 0) > 0 && (i.inventory_quantity || 0) <= 2);
  const totalValue = filteredInventory.reduce((s: number, i: any) => {
    const p = parseFloat(i.price) || 0;
    const q = i.inventory_quantity || 0;
    return s + (p > 0 && q > 0 ? p * q : 0);
  }, 0);

  // Evergreen vs Seasonal classification
  const classifyItem = (sku: string) => {
    const count = purchaseCountByItem[sku] || 0;
    if (count >= 3) return 'evergreen';
    if (count >= 1) return 'seasonal';
    return 'one-time';
  };

  const evergreenItems = useMemo(() => filteredInventory.filter((i: any) => classifyItem(i.sku) === 'evergreen'), [filteredInventory, purchaseCountByItem]);
  const seasonalItems = useMemo(() => filteredInventory.filter((i: any) => classifyItem(i.sku) === 'seasonal'), [filteredInventory, purchaseCountByItem]);

  const stockStatus = [
    { name: '有貨 In Stock', value: active.length - low.length },
    { name: '低庫存 Low', value: low.length },
    { name: '缺貨 Out', value: oos.length },
  ];

  const stockTypeData = [
    { name: '常規 Evergreen', value: evergreenItems.length },
    { name: '季節性 Seasonal', value: seasonalItems.length },
    { name: '一次性 One-time', value: filteredInventory.length - evergreenItems.length - seasonalItems.length },
  ];

  // Brand grouping
  const brandData = useMemo(() => {
    const map: Record<string, { skus: number; stock: number; value: number; oos: number }> = {};
    filteredInventory.forEach((i: any) => {
      const brand = i.vendor || 'Unknown';
      if (!map[brand]) map[brand] = { skus: 0, stock: 0, value: 0, oos: 0 };
      map[brand].skus++;
      const qty = i.inventory_quantity || 0;
      map[brand].stock += qty > 0 ? qty : 0;
      map[brand].value += (parseFloat(i.price) || 0) * (qty > 0 ? qty : 0);
      if (qty === 0) map[brand].oos++;
    });
    return Object.entries(map).map(([brand, d]) => ({ brand, ...d })).sort((a, b) => b.value - a.value);
  }, [filteredInventory]);

  // By Value
  const byValueData = useMemo(() => {
    return filteredInventory
      .filter((i: any) => (i.inventory_quantity || 0) > 0)
      .map((i: any) => {
        const qty = i.inventory_quantity || 0;
        const price = parseFloat(i.price) || 0;
        const cost = bcCostMap[i.sku];
        const unitCost = cost ? cost.unitCost : 0;
        const totalRetail = price * qty;
        const totalCost = unitCost * qty;
        const margin = price > 0 && cost ? ((price - unitCost) / price) * 100 : null;
        return { product: i.product_title, sku: i.sku, vendor: i.vendor, qty, unitPrice: price, unitCost: cost ? unitCost : null, totalRetail, totalCost, margin, hasCost: !!cost };
      })
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 50);
  }, [filteredInventory, bcCostMap]);

  // Dead Stock
  const now = new Date();
  const deadStockData = useMemo(() => {
    return filteredInventory
      .filter((i: any) => (i.inventory_quantity || 0) > 0)
      .map((i: any) => {
        const sku = i.sku || '';
        const sales = salesByProduct[sku] || salesByProduct[i.product_title] || { qty: 0, lastSaleDate: '' };
        const lastSaleDate = sales.lastSaleDate ? sales.lastSaleDate.slice(0, 10) : '';
        const daysSinceLastSale = lastSaleDate ? Math.floor((now.getTime() - new Date(lastSaleDate).getTime()) / 86400000) : 9999;
        const purchaseDate = lastPurchaseDateByItem[sku] || '';
        const daysOnShelf = purchaseDate ? Math.floor((now.getTime() - new Date(purchaseDate).getTime()) / 86400000) : 9999;
        const qty = i.inventory_quantity || 0;
        const price = parseFloat(i.price) || 0;
        const cost = bcCostMap[sku];
        const unitCost = cost ? cost.unitCost : price * 0.5;
        const totalCostAtRisk = unitCost * qty;

        let status: 'DEAD' | 'WARNING' | null = null;
        if (daysSinceLastSale >= 180 || daysSinceLastSale === 9999) status = 'DEAD';
        else if (daysSinceLastSale >= 90) status = 'WARNING';

        let action = '監察 Monitor';
        if (price > 2000 && qty > 3) action = '建議降價 Consider discount';
        else if (daysOnShelf > 365) action = '可考慮退貨 Consider return';
        else if (qty > 10 && daysSinceLastSale === 9999) action = '促銷清貨 Clearance needed';

        return { product: i.product_title, sku, vendor: i.vendor || '', qty, daysSinceLastSale, daysOnShelf, unitCost, totalCostAtRisk, status, action, price };
      })
      .filter((d) => d.status !== null)
      .sort((a, b) => b.totalCostAtRisk - a.totalCostAtRisk);
  }, [filteredInventory, salesByProduct, lastPurchaseDateByItem, bcCostMap]);

  const deadCount = deadStockData.filter((d) => d.status === 'DEAD').length;
  const warningCount = deadStockData.filter((d) => d.status === 'WARNING').length;
  const totalCostAtRisk = deadStockData.reduce((s, d) => s + d.totalCostAtRisk, 0);
  const avgDaysOnShelf = deadStockData.length > 0 ? Math.round(deadStockData.reduce((s, d) => s + (d.daysOnShelf < 9999 ? d.daysOnShelf : 0), 0) / deadStockData.length) : 0;

  // Brand detail expansion
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null);
  const brandProducts = useMemo(() => {
    if (!expandedBrand) return [];
    return filteredInventory
      .filter((i: any) => (i.vendor || 'Unknown') === expandedBrand)
      .map((i: any) => ({
        product: i.product_title,
        sku: i.sku,
        qty: i.inventory_quantity || 0,
        price: parseFloat(i.price) || 0,
        type: classifyItem(i.sku),
      }))
      .sort((a, b) => b.qty - a.qty);
  }, [expandedBrand, filteredInventory, purchaseCountByItem]);

  // Helper: get procurement badge text for a SKU
  const procBadge = (sku: string) => {
    const proc = procurementByItem[sku];
    if (!proc || proc.events.length === 0) return null;
    return proc;
  };

  // Small inline indicator showing first purchase + restock count
  const ProcurementBadge = ({ sku }: { sku: string }) => {
    const proc = procBadge(sku);
    if (!proc) return <span className="text-muted-foreground/50 text-[10px]">No procurement data</span>;
    return (
      <span className="text-[10px] text-muted-foreground">
        First: {proc.firstPurchaseDate?.slice(0, 10) || '?'} | ×{proc.restockCount}
      </span>
    );
  };

  // Expand chevron
  const ExpandIcon = ({ sku }: { sku: string }) => {
    const isOpen = expandedSku === sku;
    return isOpen
      ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
      : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />;
  };

  return (
    <div className="space-y-4">
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-6 h-9" data-testid="inventory-tabs">
          <TabsTrigger value="overview" className="text-xs">概覽 Overview</TabsTrigger>
          <TabsTrigger value="evergreen" className="text-xs">常規 Evergreen</TabsTrigger>
          <TabsTrigger value="seasonal" className="text-xs">季節性 Seasonal</TabsTrigger>
          <TabsTrigger value="brand" className="text-xs">按品牌 By Brand</TabsTrigger>
          <TabsTrigger value="value" className="text-xs">按價值 By Value</TabsTrigger>
          <TabsTrigger value="dead" className="text-xs">死貨 Dead Stock</TabsTrigger>
        </TabsList>

        {/* ═══ FILTER BAR ═══ */}
        <div className="sticky top-0 z-20 mt-2 rounded-lg bg-gray-900 border border-gray-800 px-3 py-2" data-testid="filter-bar">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500" />
              <input
                type="text"
                placeholder="搜尋產品/SKU..."
                value={filters.search}
                onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
                className={`pl-7 pr-2 py-1.5 rounded text-xs border w-44 focus:outline-none focus:border-gray-500 ${
                  filters.search ? 'bg-amber-500/10 border-amber-500/40 text-amber-300 placeholder-amber-400/40' : 'bg-gray-800 border-gray-700 text-gray-300 placeholder-gray-500'
                }`}
                data-testid="filter-search"
              />
            </div>

            {/* Brand/Vendor */}
            <MultiSelect
              label="All Brands"
              options={vendorOptions}
              selected={filters.vendors}
              onChange={v => setFilters(f => ({ ...f, vendors: v }))}
            />

            {/* Product Type */}
            <MultiSelect
              label="All Categories"
              options={productTypeOptions}
              selected={filters.productTypes}
              onChange={v => setFilters(f => ({ ...f, productTypes: v }))}
            />

            {/* Stock Status */}
            <select
              value={filters.stockStatus}
              onChange={e => setFilters(f => ({ ...f, stockStatus: e.target.value as FilterState['stockStatus'] }))}
              className={`px-2 py-1.5 rounded text-xs border focus:outline-none appearance-none cursor-pointer ${
                filters.stockStatus !== 'all'
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-gray-800 border-gray-700 text-gray-300'
              }`}
              data-testid="filter-stock-status"
            >
              <option value="all">Stock: All</option>
              <option value="in_stock">In Stock (qty&gt;0)</option>
              <option value="out_of_stock">Out of Stock (0)</option>
              <option value="low_stock">Low Stock (1-2)</option>
            </select>

            {/* Price Range */}
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="Min HKD"
                value={filters.minPrice}
                onChange={e => setFilters(f => ({ ...f, minPrice: e.target.value }))}
                className={`w-20 px-2 py-1.5 rounded text-xs border focus:outline-none ${
                  filters.minPrice ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-gray-800 border-gray-700 text-gray-300 placeholder-gray-500'
                }`}
                data-testid="filter-min-price"
              />
              <span className="text-gray-600 text-[10px]">–</span>
              <input
                type="number"
                placeholder="Max HKD"
                value={filters.maxPrice}
                onChange={e => setFilters(f => ({ ...f, maxPrice: e.target.value }))}
                className={`w-20 px-2 py-1.5 rounded text-xs border focus:outline-none ${
                  filters.maxPrice ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-gray-800 border-gray-700 text-gray-300 placeholder-gray-500'
                }`}
                data-testid="filter-max-price"
              />
            </div>

            {/* Spacer + Results count + Clear */}
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap" data-testid="filter-count">
                Showing <span className={hasActiveFilters ? 'text-amber-400 font-medium' : ''}>{formatNumber(filteredInventory.length)}</span> / {formatNumber(inventory.length)} items
              </span>
              {hasActiveFilters && (
                <button
                  onClick={() => setFilters({ ...DEFAULT_FILTERS })}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                  data-testid="filter-clear"
                >
                  <X className="h-3 w-3" />
                  Clear All
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ═══ OVERVIEW TAB ═══ */}
        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard title="有效 SKU" subtitle="Active" value={formatNumber(active.length)} icon={Package} loading={loading} testId="kpi-active" />
            <KpiCard title="缺貨" subtitle="Out of Stock" value={formatNumber(oos.length)} icon={XCircle} loading={loading} testId="kpi-oos" />
            <KpiCard title="低庫存 ≤2" subtitle="Low Stock" value={formatNumber(low.length)} icon={AlertTriangle} loading={loading} testId="kpi-low" />
            <KpiCard title="庫存總值" subtitle="Value" value={formatCurrency(totalValue)} icon={DollarSign} loading={loading} testId="kpi-val" />
            <KpiCard title="常規品" subtitle="Evergreen" value={formatNumber(evergreenItems.length)} icon={RefreshCw} loading={loading} testId="kpi-eg" />
            <KpiCard title="季節性品" subtitle="Seasonal" value={formatNumber(seasonalItems.length)} icon={Leaf} loading={loading} testId="kpi-seasonal" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="庫存狀態" subtitle="Stock Status" loading={loading}>
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={stockStatus} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" nameKey="name" paddingAngle={2}>
                    <Cell fill={CHART_COLORS.tertiary} />
                    <Cell fill={CHART_COLORS.primary} />
                    <Cell fill={CHART_COLORS.fifth} />
                  </Pie>
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="庫存類型" subtitle="Evergreen vs Seasonal vs One-time" loading={loading}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={stockTypeData}>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="name" tick={AXIS_STYLE} />
                  <YAxis tick={AXIS_STYLE} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Bar dataKey="value" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </TabsContent>

        {/* ═══ EVERGREEN TAB ═══ */}
        <TabsContent value="evergreen" className="space-y-4 mt-4">
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">常規產品 <span className="text-xs font-normal text-muted-foreground">Evergreen Items (3+ purchase records) — click row to expand procurement history</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[400px] w-full" /> : (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-xs" data-testid="table-evergreen">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 w-5"></th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-left font-medium">品牌 Vendor</th>
                        <th className="py-2 text-right font-medium">庫存 Stock</th>
                        <th className="py-2 text-right font-medium">成本 Cost</th>
                        <th className="py-2 text-right font-medium">庫存值 Value</th>
                        <th className="py-2 text-left font-medium">進貨記錄 Procurement</th>
                        <th className="py-2 text-right font-medium">天數 Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evergreenItems
                        .map((i: any) => {
                          const cost = bcCostMap[i.sku];
                          const unitCost = cost ? cost.unitCost : 0;
                          const lastPurchase = lastPurchaseDateByItem[i.sku] || '';
                          const daysSince = lastPurchase ? Math.floor((now.getTime() - new Date(lastPurchase).getTime()) / 86400000) : null;
                          return { ...i, unitCost, invValue: unitCost * (i.inventory_quantity || 0), lastPurchase, daysSince };
                        })
                        .sort((a: any, b: any) => (b.daysSince || 0) - (a.daysSince || 0))
                        .map((i: any, idx: number) => {
                          const rowKey = i.sku || `eg-${idx}`;
                          const isExpanded = expandedSku === rowKey;
                          const proc = procurementByItem[i.sku];
                          return (
                            <>
                              <tr key={rowKey} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => toggleExpand(rowKey)}>
                                <td className="py-2 pl-1"><ExpandIcon sku={rowKey} /></td>
                                <td className="py-2 max-w-[200px] truncate">{i.product_title}</td>
                                <td className="py-2 font-mono text-[11px]">{i.sku || '—'}</td>
                                <td className="py-2 text-muted-foreground">{i.vendor || '—'}</td>
                                <td className="py-2 text-right tabular-nums">{i.inventory_quantity}</td>
                                <td className="py-2 text-right tabular-nums">{i.unitCost > 0 ? formatCurrency(i.unitCost) : '—'}</td>
                                <td className="py-2 text-right tabular-nums">{i.invValue > 0 ? formatCurrency(i.invValue) : '—'}</td>
                                <td className="py-2"><ProcurementBadge sku={i.sku} /></td>
                                <td className="py-2 text-right tabular-nums">
                                  {i.daysSince !== null ? (
                                    <span className={i.daysSince > 90 ? 'text-red-400' : i.daysSince > 60 ? 'text-amber-400' : ''}>{i.daysSince}d</span>
                                  ) : '—'}
                                </td>
                              </tr>
                              {isExpanded && proc && <ProcurementRow procurement={proc} colSpan={9} />}
                            </>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══ SEASONAL TAB ═══ */}
        <TabsContent value="seasonal" className="space-y-4 mt-4">
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">季節性產品 <span className="text-xs font-normal text-muted-foreground">Seasonal Items (1-2 purchase records) — click row to expand</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[400px] w-full" /> : (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-xs" data-testid="table-seasonal">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 w-5"></th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-left font-medium">品牌 Vendor</th>
                        <th className="py-2 text-right font-medium">庫存 Stock</th>
                        <th className="py-2 text-right font-medium">成本 Cost</th>
                        <th className="py-2 text-left font-medium">進貨記錄 Procurement</th>
                        <th className="py-2 text-right font-medium">天數 Days</th>
                        <th className="py-2 text-left font-medium">補貨? Restock?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {seasonalItems
                        .map((i: any) => {
                          const sku = i.sku || '';
                          const cost = bcCostMap[sku];
                          const unitCost = cost ? cost.unitCost : 0;
                          const lastPurchase = lastPurchaseDateByItem[sku] || '';
                          const daysSince = lastPurchase ? Math.floor((now.getTime() - new Date(lastPurchase).getTime()) / 86400000) : null;
                          const sales = salesByProduct[sku] || salesByProduct[i.product_title];
                          const hasSold = sales && sales.qty > 0;
                          const pCount = purchaseCountByItem[sku] || 0;
                          const needsRestock = pCount === 1 && hasSold && (i.inventory_quantity || 0) <= 2;
                          return { ...i, unitCost, lastPurchase, daysSince, needsRestock };
                        })
                        .sort((a: any, b: any) => (b.daysSince || 0) - (a.daysSince || 0))
                        .map((i: any, idx: number) => {
                          const rowKey = i.sku || `se-${idx}`;
                          const isExpanded = expandedSku === rowKey;
                          const proc = procurementByItem[i.sku];
                          return (
                            <>
                              <tr key={rowKey} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => toggleExpand(rowKey)}>
                                <td className="py-2 pl-1"><ExpandIcon sku={rowKey} /></td>
                                <td className="py-2 max-w-[200px] truncate">{i.product_title}</td>
                                <td className="py-2 font-mono text-[11px]">{i.sku || '—'}</td>
                                <td className="py-2 text-muted-foreground">{i.vendor || '—'}</td>
                                <td className="py-2 text-right tabular-nums">{i.inventory_quantity}</td>
                                <td className="py-2 text-right tabular-nums">{i.unitCost > 0 ? formatCurrency(i.unitCost) : '—'}</td>
                                <td className="py-2"><ProcurementBadge sku={i.sku} /></td>
                                <td className="py-2 text-right tabular-nums">
                                  {i.daysSince !== null ? <span>{i.daysSince}d</span> : '—'}
                                </td>
                                <td className="py-2">
                                  {i.needsRestock ? <Badge variant="default" className="text-[10px]">建議補貨</Badge> : <span className="text-muted-foreground">—</span>}
                                </td>
                              </tr>
                              {isExpanded && proc && <ProcurementRow procurement={proc} colSpan={9} />}
                            </>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══ BY BRAND TAB ═══ */}
        <TabsContent value="brand" className="space-y-4 mt-4">
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">按品牌庫存 <span className="text-xs font-normal text-muted-foreground">Inventory by Brand</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[400px] w-full" /> : (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-xs" data-testid="table-brand-inv">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 text-left font-medium">品牌 Brand</th>
                        <th className="py-2 text-right font-medium">SKUs</th>
                        <th className="py-2 text-right font-medium">總庫存 Stock</th>
                        <th className="py-2 text-right font-medium">庫存值 Value</th>
                        <th className="py-2 text-right font-medium">缺貨 OOS</th>
                        <th className="py-2 text-left font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {brandData.map((b) => (
                        <>
                          <tr key={b.brand} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => setExpandedBrand(expandedBrand === b.brand ? null : b.brand)}>
                            <td className="py-2 font-medium">{b.brand}</td>
                            <td className="py-2 text-right tabular-nums">{b.skus}</td>
                            <td className="py-2 text-right tabular-nums">{formatNumber(b.stock)}</td>
                            <td className="py-2 text-right tabular-nums">{formatCurrency(b.value)}</td>
                            <td className="py-2 text-right tabular-nums">{b.oos > 0 ? <span className="text-red-400">{b.oos}</span> : '0'}</td>
                            <td className="py-2 text-xs text-muted-foreground">{expandedBrand === b.brand ? '▲' : '▼'}</td>
                          </tr>
                          {expandedBrand === b.brand && brandProducts.map((p, pi) => (
                            <tr key={`${b.brand}-${pi}`} className="border-b border-border/10 bg-accent/10">
                              <td className="py-1.5 pl-4 text-muted-foreground max-w-[200px] truncate">{p.product}</td>
                              <td className="py-1.5 text-right font-mono text-[10px]">{p.sku || '—'}</td>
                              <td className="py-1.5 text-right tabular-nums">{p.qty}</td>
                              <td className="py-1.5 text-right tabular-nums">{formatCurrency(p.price * p.qty)}</td>
                              <td className="py-1.5 text-right">
                                <Badge variant="secondary" className="text-[9px]">{p.type === 'evergreen' ? '常規' : p.type === 'seasonal' ? '季節' : '一次'}</Badge>
                              </td>
                              <td></td>
                            </tr>
                          ))}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══ BY VALUE TAB ═══ */}
        <TabsContent value="value" className="space-y-4 mt-4">
          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">按價值排列 <span className="text-xs font-normal text-muted-foreground">By Value (highest cost value first) — click row to expand</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[400px] w-full" /> : (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-xs" data-testid="table-value">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 w-5"></th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-left font-medium">品牌</th>
                        <th className="py-2 text-right font-medium">數量 Qty</th>
                        <th className="py-2 text-right font-medium">售價 Price</th>
                        <th className="py-2 text-right font-medium">成本 Cost</th>
                        <th className="py-2 text-right font-medium">零售總值</th>
                        <th className="py-2 text-right font-medium">成本總值</th>
                        <th className="py-2 text-left font-medium">進貨 Procurement</th>
                        <th className="py-2 text-right font-medium">毛利%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byValueData.map((d, i) => {
                        const rowKey = d.sku || `val-${i}`;
                        const isExpanded = expandedSku === rowKey;
                        const proc = procurementByItem[d.sku];
                        return (
                          <>
                            <tr key={rowKey} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => toggleExpand(rowKey)}>
                              <td className="py-2 pl-1"><ExpandIcon sku={rowKey} /></td>
                              <td className="py-2 max-w-[180px] truncate">{d.product}</td>
                              <td className="py-2 font-mono text-[11px]">{d.sku || '—'}</td>
                              <td className="py-2 text-muted-foreground">{d.vendor || '—'}</td>
                              <td className="py-2 text-right tabular-nums">{d.qty}</td>
                              <td className="py-2 text-right tabular-nums">{formatCurrency(d.unitPrice)}</td>
                              <td className="py-2 text-right tabular-nums">{d.unitCost !== null ? formatCurrency(d.unitCost) : <span className="text-muted-foreground">N/A</span>}</td>
                              <td className="py-2 text-right tabular-nums">{formatCurrency(d.totalRetail)}</td>
                              <td className="py-2 text-right tabular-nums font-medium">{formatCurrency(d.totalCost)}</td>
                              <td className="py-2"><ProcurementBadge sku={d.sku} /></td>
                              <td className="py-2 text-right tabular-nums">
                                {d.margin !== null ? (
                                  <span className={d.margin >= 40 ? 'text-emerald-400' : d.margin >= 20 ? 'text-amber-400' : 'text-red-400'}>
                                    {formatPercent(d.margin)}
                                  </span>
                                ) : <span className="text-muted-foreground">N/A</span>}
                              </td>
                            </tr>
                            {isExpanded && proc && <ProcurementRow procurement={proc} colSpan={11} />}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ═══ DEAD STOCK TAB ═══ */}
        <TabsContent value="dead" className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="死貨 SKU" subtitle="Dead Stock" value={formatNumber(deadCount)} icon={Skull} loading={loading} testId="kpi-dead" />
            <KpiCard title="風險成本" subtitle="Cost at Risk" value={formatCurrency(totalCostAtRisk)} icon={DollarSign} loading={loading} testId="kpi-risk" />
            <KpiCard title="警告品項" subtitle="Warning" value={formatNumber(warningCount)} icon={AlertTriangle} loading={loading} testId="kpi-warning" />
            <KpiCard title="平均上架天" subtitle="Avg Days" value={avgDaysOnShelf > 0 ? `${avgDaysOnShelf}d` : '—'} icon={Clock} loading={loading} testId="kpi-shelf" />
          </div>

          <Card className="border-border/40">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium">死貨清單 <span className="text-xs font-normal text-muted-foreground">Dead Stock Analysis — click row to expand procurement history</span></CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {loading ? <Skeleton className="h-[400px] w-full" /> : deadStockData.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">無死貨項目 🎉</p>
              ) : (
                <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                  <table className="w-full text-xs" data-testid="table-dead-stock">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b border-border/50 text-muted-foreground">
                        <th className="py-2 w-5"></th>
                        <th className="py-2 text-left font-medium">狀態</th>
                        <th className="py-2 text-left font-medium">產品 Product</th>
                        <th className="py-2 text-left font-medium">SKU</th>
                        <th className="py-2 text-left font-medium">品牌</th>
                        <th className="py-2 text-right font-medium">庫存</th>
                        <th className="py-2 text-right font-medium">無售天</th>
                        <th className="py-2 text-right font-medium">上架天</th>
                        <th className="py-2 text-right font-medium">成本/件</th>
                        <th className="py-2 text-right font-medium">風險成本</th>
                        <th className="py-2 text-left font-medium">進貨 Procurement</th>
                        <th className="py-2 text-left font-medium">建議</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deadStockData.map((d, i) => {
                        const rowKey = d.sku || `dead-${i}`;
                        const isExpanded = expandedSku === rowKey;
                        const proc = procurementByItem[d.sku];
                        return (
                          <>
                            <tr key={rowKey} className="border-b border-border/20 hover:bg-accent/30 transition-colors cursor-pointer" onClick={() => toggleExpand(rowKey)}>
                              <td className="py-2 pl-1"><ExpandIcon sku={rowKey} /></td>
                              <td className="py-2">
                                {d.status === 'DEAD' ? (
                                  <Badge variant="destructive" className="text-[10px]">💀 DEAD</Badge>
                                ) : (
                                  <Badge variant="secondary" className="text-[10px] bg-amber-500/20 text-amber-400 border-amber-500/30">⚠️ WARNING</Badge>
                                )}
                              </td>
                              <td className="py-2 max-w-[160px] truncate">{d.product}</td>
                              <td className="py-2 font-mono text-[11px]">{d.sku || '—'}</td>
                              <td className="py-2 text-muted-foreground">{d.vendor || '—'}</td>
                              <td className="py-2 text-right tabular-nums">{d.qty}</td>
                              <td className="py-2 text-right tabular-nums">
                                <span className={d.daysSinceLastSale >= 180 ? 'text-red-400' : 'text-amber-400'}>
                                  {d.daysSinceLastSale === 9999 ? 'Never' : `${d.daysSinceLastSale}d`}
                                </span>
                              </td>
                              <td className="py-2 text-right tabular-nums">{d.daysOnShelf < 9999 ? `${d.daysOnShelf}d` : '—'}</td>
                              <td className="py-2 text-right tabular-nums">{formatCurrency(d.unitCost)}</td>
                              <td className="py-2 text-right tabular-nums font-medium">{formatCurrency(d.totalCostAtRisk)}</td>
                              <td className="py-2"><ProcurementBadge sku={d.sku} /></td>
                              <td className="py-2 text-[10px]">{d.action}</td>
                            </tr>
                            {isExpanded && proc && <ProcurementRow procurement={proc} colSpan={12} />}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
