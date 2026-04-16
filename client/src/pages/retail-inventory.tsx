import React, { useEffect, useState, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { queryAll, queryWithDateRange } from '@/lib/query-helpers';
import { supabase } from '@/lib/supabase';
import { KpiCard } from '@/components/kpi-card';
import { ChartCard } from '@/components/chart-card';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';
import { CHART_COLORS, AXIS_STYLE, GRID_STYLE, TOOLTIP_STYLE, DONUT_PALETTE } from '@/lib/chart-theme';
import { Package, AlertTriangle, XCircle, DollarSign, Clock, RefreshCw, Leaf, Skull, Tag, ChevronRight, ChevronDown, ChevronUp, History, Search, X, Filter } from 'lucide-react';
import {
  PieChart, Pie, Cell, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ── Variant Title Parser ────────────────────────────────────
const SIZE_TOKENS = new Set([
  'XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL',
  'SM','MD','LG','O/S','OS','ONE SIZE','FREE SIZE',
  '52','53','54','55','56','57','58','59','60','61','62','63','64',
  '52-53','54-55','56-57','58-59','60-61','62-63',
]);

function parseVariantTitle(vt: string | null | undefined): { color: string; size: string } {
  if (!vt || vt === 'Default Title') return { color: '', size: '' };
  const trimmed = vt.trim();
  // Check for " / " separator
  if (trimmed.includes(' / ')) {
    const parts = trimmed.split(' / ');
    const last = parts[parts.length - 1].trim().toUpperCase();
    if (SIZE_TOKENS.has(last) || /^\d{1,3}(-\d{1,3})?$/.test(last)) {
      return {
        color: parts.slice(0, -1).join(' / ').trim(),
        size: parts[parts.length - 1].trim(),
      };
    }
    // If last token isn't a recognized size, treat first as color and rest ambiguous
    return { color: parts[0].trim(), size: parts.slice(1).join(' / ').trim() };
  }
  // No separator — check if entire string is a size
  if (SIZE_TOKENS.has(trimmed.toUpperCase()) || /^\d{1,3}(-\d{1,3})?$/.test(trimmed)) {
    return { color: '', size: trimmed };
  }
  // Otherwise treat as color/style
  return { color: trimmed, size: '' };
}

// ── Margin helpers (from dead-stock page) ──────────────────
function marginColorClass(margin: number): string {
  if (margin > 40) return 'text-green-400';
  if (margin >= 20) return 'text-amber-400';
  return 'text-red-400';
}

function computeMargin(price: number, unitCost: number): number | null {
  if (!price || price === 0) return null;
  return ((price - unitCost) / price) * 100;
}

// ── Filter toggle helper ──────────────────────────────────
function toggleFilter<T extends string>(arr: T[], val: T): T[] {
  return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val];
}

// ── FilterDropdown (portal-based to escape overflow clipping) ───────
function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
  renderLabel,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (val: string) => void;
  renderLabel?: (val: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Position the portal dropdown below the button
  useLayoutEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        btnRef.current && !btnRef.current.contains(target) &&
        dropRef.current && !dropRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const hasFilter = selected.length > 0;

  return (
    <div className="inline-block">
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-0.5 text-[10px] font-medium select-none whitespace-nowrap ${
          hasFilter ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {label}
        {hasFilter && (
          <span className="ml-0.5 px-1 py-0 rounded bg-primary/20 text-primary text-[9px] leading-tight">
            {selected.length}
          </span>
        )}
        <ChevronDown className="h-2.5 w-2.5 opacity-50" />
      </button>
      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[9999] bg-background border border-border rounded-md shadow-lg min-w-[140px] max-h-52 overflow-y-auto p-1.5"
          style={{ top: pos.top, left: pos.left }}
        >
          {options.length === 0 && (
            <span className="text-[10px] text-muted-foreground px-1">無選項</span>
          )}
          {options.map(v => (
            <label key={v} className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5">
              <input
                type="checkbox"
                checked={selected.includes(v)}
                onChange={() => onToggle(v)}
                className="h-3 w-3 rounded"
              />
              <span className="truncate">{renderLabel ? renderLabel(v) : v}</span>
            </label>
          ))}
          {hasFilter && (
            <button
              onClick={() => { selected.forEach(s => onToggle(s)); }}
              className="mt-1 w-full text-[10px] text-center text-muted-foreground hover:text-foreground py-0.5 border-t border-border/40"
            >
              清除
            </button>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

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
      .select('variant_id, product_id, product_title, variant_title, sku, price, inventory_quantity, vendor, product_type')
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
            : 'bg-muted border-border text-foreground hover:border-border'
        }`}
      >
        <Filter className="h-3 w-3 shrink-0 opacity-60" />
        <span className="max-w-[140px] truncate">{displayText}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 bg-muted border border-border rounded-lg shadow-xl w-60" style={{ maxHeight: 320, display: 'flex', flexDirection: 'column' }}>
          <div className="p-2 border-b border-border">
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full px-2 py-1 text-xs bg-background border border-border rounded text-foreground placeholder-muted-foreground focus:outline-none focus:border-gray-500"
              autoFocus
            />
          </div>
          <div className="overflow-y-auto flex-1" style={{ maxHeight: 256 }}>
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-500 text-center">No matches</div>
            )}
            {filtered.map(opt => (
              <label key={opt} className="flex items-center px-3 py-1.5 hover:bg-accent/60 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => {
                    onChange(selected.includes(opt) ? selected.filter(s => s !== opt) : [...selected, opt]);
                  }}
                  className="mr-2 accent-amber-500 h-3 w-3"
                />
                <span className="text-xs text-foreground truncate">{opt || 'Unknown'}</span>
              </label>
            ))}
          </div>
          {selected.length > 0 && (
            <button
              className="w-full px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground border-t border-border text-center"
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
  const [deadStockExcludedProductIds, setDeadStockExcludedProductIds] = useState<Set<string>>(new Set());

  // Filter state
  const [filters, setFilters] = useState<FilterState>({ ...DEFAULT_FILTERS });

  // Track which SKU row is expanded (only one at a time)
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  // Track which product (by product_title) is expanded in the products tab and brand tab
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  // Track which variant (by sku) is expanded inside a product group in the products/brand tab
  const [expandedProductVariant, setExpandedProductVariant] = useState<string | null>(null);

  // Products tab: sort state
  type ProductSortKey = 'total_stock' | 'stock_cost' | 'avg_margin';
  type SortDir = 'asc' | 'desc';
  const [productSortKey, setProductSortKey] = useState<ProductSortKey>('total_stock');
  const [productSortDir, setProductSortDir] = useState<SortDir>('desc');

  // Products tab: zero-stock variants loaded on demand
  const [zeroStockVariants, setZeroStockVariants] = useState<Map<string, any[]>>(new Map());

  const toggleExpand = useCallback((sku: string) => {
    setExpandedSku((prev) => prev === sku ? null : sku);
  }, []);

  // Products tab: expand product group and load 0-stock variants on demand
  const toggleProductGroup = useCallback(async (title: string) => {
    if (expandedProduct === title) {
      setExpandedProduct(null);
    } else {
      setExpandedProduct(title);
      if (!zeroStockVariants.has(title)) {
        const { data } = await supabase
          .from('shopify_inventory')
          .select('sku,product_title,variant_title,vendor,product_type,inventory_quantity,price,compare_at_price')
          .eq('product_title', title)
          .eq('inventory_quantity', 0);
        if (data && data.length > 0) {
          setZeroStockVariants(prev => new Map(prev).set(title, data));
        } else {
          setZeroStockVariants(prev => new Map(prev).set(title, []));
        }
      }
    }
  }, [expandedProduct, zeroStockVariants]);

  const handleProductSort = useCallback((key: ProductSortKey) => {
    if (productSortKey === key) setProductSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setProductSortKey(key); setProductSortDir('desc'); }
  }, [productSortKey]);

  const ProductSortIcon = ({ col }: { col: ProductSortKey }) => {
    if (productSortKey !== col) return <ChevronDown className="h-3 w-3 opacity-30 inline ml-0.5" />;
    return productSortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-primary inline ml-0.5" />
      : <ChevronDown className="h-3 w-3 text-primary inline ml-0.5" />;
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [inv, bcInv, purchaseLines, purchaseInvoices, orderLines, orders, shopifyProducts] = await Promise.all([
          fetchAllInventory(),
          queryAll('bc_inventory', 'number,display_name,unit_price,unit_cost,item_category_code', undefined, 50000),
          queryAll('bc_purchase_invoice_lines', 'invoice_id,invoice_number,item_number,quantity,unit_cost', undefined, 50000),
          queryAll('bc_purchase_invoices', 'id,posting_date,number', undefined, 50000),
          queryAll('shopify_order_lines', 'order_id,product_id,title,sku,vendor,quantity', undefined, 50000),
          queryAll('shopify_orders', 'id,created_at,financial_status,cancelled_at', undefined, 50000),
          queryAll('shopify_products', 'id,status,created_at', undefined, 50000),
        ]);
        if (cancelled) return;

        // Build set of product IDs to exclude from dead stock (draft or created within 90 days)
        const ninetyDaysAgo = Date.now() - 90 * 86400000;
        const excludedIds = new Set<string>();
        (shopifyProducts || []).forEach((p: any) => {
          if (p.status === 'draft') excludedIds.add(String(p.id));
          else if (p.created_at && new Date(p.created_at).getTime() > ninetyDaysAgo) excludedIds.add(String(p.id));
        });
        setDeadStockExcludedProductIds(excludedIds);

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
      // Exclude draft products and products created within the last 90 days
      .filter((i: any) => !deadStockExcludedProductIds.has(String(i.product_id)))
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
  }, [filteredInventory, salesByProduct, lastPurchaseDateByItem, bcCostMap, deadStockExcludedProductIds]);

  const deadCount = deadStockData.filter((d) => d.status === 'DEAD').length;
  const warningCount = deadStockData.filter((d) => d.status === 'WARNING').length;
  const totalCostAtRisk = deadStockData.reduce((s, d) => s + d.totalCostAtRisk, 0);
  const avgDaysOnShelf = deadStockData.length > 0 ? Math.round(deadStockData.reduce((s, d) => s + (d.daysOnShelf < 9999 ? d.daysOnShelf : 0), 0) / deadStockData.length) : 0;

  // Brand detail expansion
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null);

  // Group filteredInventory by product_title for the products tab (dead-stock style)
  const productGroups = useMemo(() => {
    const map: Record<string, { items: any[]; vendor: string; productType: string; totalStock: number; minPrice: number; maxPrice: number; minComparePrice: number; maxComparePrice: number; minUnitCost: number; maxUnitCost: number; totalStockCost: number; totalRevenue: number; totalCostWeighted: number }> = {};
    filteredInventory.forEach((i: any) => {
      const title = i.product_title || 'Unknown';
      if (!map[title]) {
        map[title] = {
          items: [],
          vendor: i.vendor || '',
          productType: i.product_type || '',
          totalStock: 0,
          minPrice: Infinity,
          maxPrice: -Infinity,
          minComparePrice: Infinity,
          maxComparePrice: -Infinity,
          minUnitCost: Infinity,
          maxUnitCost: -Infinity,
          totalStockCost: 0,
          totalRevenue: 0,
          totalCostWeighted: 0,
        };
      }
      const g = map[title];
      g.items.push(i);
      const qty = i.inventory_quantity || 0;
      g.totalStock += qty;
      const p = parseFloat(i.price) || 0;
      if (p > 0 && p < g.minPrice) g.minPrice = p;
      if (p > 0 && p > g.maxPrice) g.maxPrice = p;
      const cp = i.compare_at_price != null ? parseFloat(i.compare_at_price) || 0 : 0;
      if (cp > 0 && cp < g.minComparePrice) g.minComparePrice = cp;
      if (cp > 0 && cp > g.maxComparePrice) g.maxComparePrice = cp;
      const bc = bcCostMap[i.sku];
      const uc = bc ? bc.unitCost : 0;
      if (uc > 0 && uc < g.minUnitCost) g.minUnitCost = uc;
      if (uc > 0 && uc > g.maxUnitCost) g.maxUnitCost = uc;
      g.totalStockCost += uc * Math.max(qty, 0);
      if (p > 0) {
        const q = Math.max(qty, 1);
        g.totalRevenue += p * q;
        g.totalCostWeighted += uc * q;
      }
    });
    const groups = Object.entries(map)
      .map(([title, d]) => ({
        title,
        vendor: d.vendor,
        productType: d.productType,
        totalStock: d.totalStock,
        variantCount: d.items.length,
        minPrice: d.minPrice === Infinity ? 0 : d.minPrice,
        maxPrice: d.maxPrice === -Infinity ? 0 : d.maxPrice,
        minComparePrice: d.minComparePrice === Infinity ? 0 : d.minComparePrice,
        maxComparePrice: d.maxComparePrice === -Infinity ? 0 : d.maxComparePrice,
        minUnitCost: d.minUnitCost === Infinity ? 0 : d.minUnitCost,
        maxUnitCost: d.maxUnitCost === -Infinity ? 0 : d.maxUnitCost,
        stock_cost: d.totalStockCost,
        avg_margin: d.totalRevenue > 0 ? ((d.totalRevenue - d.totalCostWeighted) / d.totalRevenue) * 100 : null,
        items: d.items,
      }));

    // Sort
    groups.sort((a, b) => {
      const mul = productSortDir === 'asc' ? 1 : -1;
      if (productSortKey === 'stock_cost') return (a.stock_cost - b.stock_cost) * mul;
      if (productSortKey === 'avg_margin') return ((a.avg_margin ?? -1) - (b.avg_margin ?? -1)) * mul;
      return (a.totalStock - b.totalStock) * mul;
    });

    return groups;
  }, [filteredInventory, bcCostMap, productSortKey, productSortDir]);

  // Brand products grouped by product_title
  const brandProductGroups = useMemo(() => {
    if (!expandedBrand) return [];
    const brandItems = filteredInventory.filter((i: any) => (i.vendor || 'Unknown') === expandedBrand);
    const map: Record<string, { items: any[]; totalStock: number; minPrice: number; maxPrice: number; productType: string }> = {};
    brandItems.forEach((i: any) => {
      const title = i.product_title || 'Unknown';
      if (!map[title]) map[title] = { items: [], totalStock: 0, minPrice: Infinity, maxPrice: -Infinity, productType: i.product_type || '' };
      map[title].items.push(i);
      map[title].totalStock += i.inventory_quantity || 0;
      const p = parseFloat(i.price) || 0;
      if (p < map[title].minPrice) map[title].minPrice = p;
      if (p > map[title].maxPrice) map[title].maxPrice = p;
    });
    return Object.entries(map)
      .map(([title, d]) => ({
        title,
        productType: d.productType,
        totalStock: d.totalStock,
        variantCount: d.items.length,
        minPrice: d.minPrice === Infinity ? 0 : d.minPrice,
        maxPrice: d.maxPrice === -Infinity ? 0 : d.maxPrice,
        items: d.items,
      }))
      .sort((a, b) => b.totalStock - a.totalStock);
  }, [expandedBrand, filteredInventory]);

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
        <TabsList className="grid w-full grid-cols-7 h-9" data-testid="inventory-tabs">
          <TabsTrigger value="overview" className="text-xs">概覽 Overview</TabsTrigger>
          <TabsTrigger value="products" className="text-xs">產品總覽 Products</TabsTrigger>
          <TabsTrigger value="evergreen" className="text-xs">常規 Evergreen</TabsTrigger>
          <TabsTrigger value="seasonal" className="text-xs">季節性 Seasonal</TabsTrigger>
          <TabsTrigger value="brand" className="text-xs">按品牌 By Brand</TabsTrigger>
          <TabsTrigger value="value" className="text-xs">按價值 By Value</TabsTrigger>
          <TabsTrigger value="dead" className="text-xs">死貨 Dead Stock</TabsTrigger>
        </TabsList>

        {/* ═══ FILTER BAR ═══ */}
        <div className="sticky top-0 z-20 mt-2 rounded-lg bg-background border border-gray-800 px-3 py-2" data-testid="filter-bar">
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
                  filters.search ? 'bg-amber-500/10 border-amber-500/40 text-amber-300 placeholder-amber-400/40' : 'bg-muted border-border text-foreground placeholder-muted-foreground'
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
                  : 'bg-muted border-border text-foreground'
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
                  filters.minPrice ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-muted border-border text-foreground placeholder-muted-foreground'
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
                  filters.maxPrice ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' : 'bg-muted border-border text-foreground placeholder-muted-foreground'
                }`}
                data-testid="filter-max-price"
              />
            </div>

            {/* Spacer + Results count + Clear */}
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap" data-testid="filter-count">
                Showing <span className={hasActiveFilters ? 'text-amber-400 font-medium' : ''}>{formatNumber(filteredInventory.length)}</span> / {formatNumber(inventory.length)} items
              </span>
              {hasActiveFilters && (
                <button
                  onClick={() => setFilters({ ...DEFAULT_FILTERS })}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-border transition-colors"
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

        {/* ═══ PRODUCTS TAB (dead-stock style) ═══ */}
        <TabsContent value="products" className="space-y-4 mt-4">
          {loading ? <Skeleton className="h-[500px] w-full" /> : (
            <div className="border border-border/50 rounded-lg overflow-hidden">
              {/* Summary bar */}
              <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b border-border/50">
                <span className="text-xs text-muted-foreground">
                  顯示 <span className="font-medium text-foreground">{productGroups.length}</span> 個產品
                  （<span className="font-medium text-foreground">{productGroups.reduce((s, g) => s + g.variantCount, 0)}</span> 個 SKU）
                </span>
                {productGroups.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    庫存成本合計: <span className="font-medium text-foreground">
                      {formatCurrency(productGroups.reduce((s, g) => s + g.stock_cost, 0))}
                    </span>
                  </span>
                )}
              </div>

              {/* Scrollable table with sticky header */}
              <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
                <table className="w-full text-xs" style={{ tableLayout: 'fixed' }} data-testid="table-products">
                  <thead className="bg-muted/30 border-b border-border/50" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                    <tr className="bg-muted/30">
                      {/* Expand arrow */}
                      <th className="text-left px-2 py-2 bg-muted/30" style={{ width: 32, minWidth: 32 }}></th>
                      {/* 產品名稱 */}
                      <th className="px-2 py-2 text-left bg-muted/30" style={{ width: 220 }}>
                        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">產品名稱</span>
                      </th>
                      {/* 品牌 with filter */}
                      <th className="px-2 py-2 text-left bg-muted/30" style={{ width: 100 }}>
                        <FilterDropdown
                          label="品牌"
                          options={vendorOptions}
                          selected={filters.vendors}
                          onToggle={v => setFilters(f => ({ ...f, vendors: toggleFilter(f.vendors, v) }))}
                        />
                      </th>
                      {/* 分類 with filter */}
                      <th className="px-2 py-2 text-left bg-muted/30" style={{ width: 100 }}>
                        <FilterDropdown
                          label="分類"
                          options={productTypeOptions}
                          selected={filters.productTypes}
                          onToggle={v => setFilters(f => ({ ...f, productTypes: toggleFilter(f.productTypes, v) }))}
                        />
                      </th>
                      {/* 總存量 */}
                      <th className="px-2 py-2 text-right bg-muted/30" style={{ width: 70 }}>
                        <span
                          className="cursor-pointer hover:text-foreground select-none text-[10px] font-medium text-muted-foreground whitespace-nowrap"
                          onClick={() => handleProductSort('total_stock')}
                        >
                          總存量 <ProductSortIcon col="total_stock" />
                        </span>
                      </th>
                      {/* 比較價 */}
                      <th className="px-2 py-2 text-right bg-muted/30" style={{ width: 90 }}>
                        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">比較價</span>
                      </th>
                      {/* 零售價 */}
                      <th className="px-2 py-2 text-right bg-muted/30" style={{ width: 85 }}>
                        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">零售價</span>
                      </th>
                      {/* 單件成本 */}
                      <th className="px-2 py-2 text-right bg-muted/30" style={{ width: 80 }}>
                        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">單件成本</span>
                      </th>
                      {/* 庫存成本 */}
                      <th className="px-2 py-2 text-right bg-muted/30" style={{ width: 90 }}>
                        <span
                          className="cursor-pointer hover:text-foreground select-none text-[10px] font-medium text-muted-foreground whitespace-nowrap"
                          onClick={() => handleProductSort('stock_cost')}
                        >
                          庫存成本 <ProductSortIcon col="stock_cost" />
                        </span>
                      </th>
                      {/* 利潤% */}
                      <th className="px-2 py-2 text-right bg-muted/30" style={{ width: 70 }}>
                        <span
                          className="cursor-pointer hover:text-foreground select-none text-[10px] font-medium text-muted-foreground whitespace-nowrap"
                          onClick={() => handleProductSort('avg_margin')}
                        >
                          利潤% <ProductSortIcon col="avg_margin" />
                        </span>
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-border/30">
                    {productGroups.length === 0 && (
                      <tr>
                        <td colSpan={10} className="text-center py-8 text-sm text-muted-foreground">
                          <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
                          無符合條件的產品
                        </td>
                      </tr>
                    )}
                    {productGroups.map(pg => {
                      const isExpanded = expandedProduct === pg.title;
                      const extraZero = zeroStockVariants.get(pg.title) ?? [];
                      const existingSkuSet = new Set(pg.items.map((s: any) => s.sku));
                      const mergedItems = [...pg.items, ...extraZero.filter((z: any) => !existingSkuSet.has(z.sku))];
                      const skuCount = mergedItems.length;
                      const comparePriceRange = pg.minComparePrice > 0
                        ? (pg.minComparePrice === pg.maxComparePrice ? formatCurrency(pg.minComparePrice) : `${formatCurrency(pg.minComparePrice)}–${formatCurrency(pg.maxComparePrice)}`)
                        : '—';
                      const retailPriceRange = pg.minPrice > 0
                        ? (pg.minPrice === pg.maxPrice ? formatCurrency(pg.minPrice) : `${formatCurrency(pg.minPrice)}–${formatCurrency(pg.maxPrice)}`)
                        : '—';
                      const unitCostRange = pg.minUnitCost > 0
                        ? (pg.minUnitCost === pg.maxUnitCost ? formatCurrency(pg.minUnitCost) : `${formatCurrency(pg.minUnitCost)}–${formatCurrency(pg.maxUnitCost)}`)
                        : '—';

                      return (
                        <React.Fragment key={pg.title}>
                          {/* ── Product group row ── */}
                          <tr
                            onClick={() => toggleProductGroup(pg.title)}
                            className={`cursor-pointer transition-colors ${
                              isExpanded
                                ? 'bg-primary/5 border-l-2 border-l-primary'
                                : 'hover:bg-muted/30'
                            }`}
                          >
                            <td className="px-2 py-2 text-muted-foreground" style={{ width: 32, minWidth: 32 }}>
                              {isExpanded
                                ? <ChevronDown className="h-3.5 w-3.5" />
                                : <ChevronRight className="h-3.5 w-3.5" />}
                            </td>
                            <td className="px-2 py-2" style={{ width: 220 }}>
                              <div className="flex items-center gap-1.5">
                                <span className="truncate font-medium" title={pg.title}>
                                  {pg.title?.slice(0, 40)}{(pg.title?.length ?? 0) > 40 ? '…' : ''}
                                </span>
                                <span className="shrink-0 px-1.5 py-0 rounded bg-muted text-muted-foreground text-[9px] border border-border/40">
                                  {skuCount} SKU
                                </span>
                              </div>
                            </td>
                            <td className="px-2 py-2 text-muted-foreground" style={{ width: 100 }}>{pg.vendor || '—'}</td>
                            <td className="px-2 py-2 text-muted-foreground" style={{ width: 100 }}>{pg.productType || '—'}</td>
                            <td className="px-2 py-2 text-right tabular-nums" style={{ width: 70 }}>{formatNumber(pg.totalStock)}</td>
                            <td className="px-2 py-2 text-right tabular-nums text-[10px] text-muted-foreground" style={{ width: 90 }}>{comparePriceRange}</td>
                            <td className="px-2 py-2 text-right tabular-nums text-[10px]" style={{ width: 85 }}>{retailPriceRange}</td>
                            <td className="px-2 py-2 text-right tabular-nums text-[10px] text-muted-foreground" style={{ width: 80 }}>{unitCostRange}</td>
                            <td className="px-2 py-2 text-right tabular-nums font-medium" style={{ width: 90 }}>{formatCurrency(pg.stock_cost)}</td>
                            <td className="px-2 py-2 text-right" style={{ width: 70 }}>
                              {pg.avg_margin != null
                                ? <span className={`tabular-nums font-medium ${marginColorClass(pg.avg_margin)}`}>{pg.avg_margin.toFixed(1)}%</span>
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                          </tr>

                          {/* ── Expanded variant rows (incl. 0-stock) ── */}
                          {isExpanded && mergedItems.map((variant: any, vi: number) => {
                            const varKey = variant.sku || `${pg.title}-v${vi}`;
                            const isZeroStock = (variant.inventory_quantity ?? 0) <= 0;
                            const parsed = parseVariantTitle(variant.variant_title);
                            const bc = bcCostMap[variant.sku];
                            const unitCost = bc ? bc.unitCost : 0;
                            const price = parseFloat(variant.price) || 0;
                            const comparePrice = variant.compare_at_price != null ? parseFloat(variant.compare_at_price) || 0 : 0;
                            const stockCost = unitCost * Math.max(variant.inventory_quantity ?? 0, 0);
                            const margin = computeMargin(price, unitCost);

                            return (
                              <tr
                                key={varKey}
                                className={`bg-muted/5 transition-colors hover:bg-muted/20 ${isZeroStock ? 'opacity-50' : ''}`}
                              >
                                <td className="px-2 py-1.5" style={{ width: 32, minWidth: 32 }}></td>
                                <td className="px-2 py-1.5" style={{ width: 220 }}>
                                  <div className="flex items-center gap-1.5 pl-4">
                                    <span className="font-mono text-[10px] text-muted-foreground">{variant.sku || '—'}</span>
                                    {parsed.color && <span className="text-[10px] text-foreground/70">{parsed.color}</span>}
                                    {parsed.size && <span className="text-[10px] text-foreground/70">/ {parsed.size}</span>}
                                  </div>
                                </td>
                                <td className="px-2 py-1.5 text-muted-foreground text-[10px]" style={{ width: 100 }}>{variant.vendor || '—'}</td>
                                <td className="px-2 py-1.5 text-muted-foreground text-[10px]" style={{ width: 100 }}>{variant.product_type || '—'}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-[10px]" style={{ width: 70 }}>{formatNumber(variant.inventory_quantity ?? 0)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-muted-foreground" style={{ width: 90 }}>
                                  {comparePrice > 0 ? formatCurrency(comparePrice) : '—'}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-[10px]" style={{ width: 85 }}>{formatCurrency(price)}</td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-[10px] text-muted-foreground" style={{ width: 80 }}>
                                  {unitCost > 0 ? formatCurrency(unitCost) : '—'}
                                </td>
                                <td className="px-2 py-1.5 text-right tabular-nums text-[10px]" style={{ width: 90 }}>{formatCurrency(stockCost)}</td>
                                <td className="px-2 py-1.5 text-right" style={{ width: 70 }}>
                                  {margin != null
                                    ? <span className={`tabular-nums text-[10px] font-medium ${marginColorClass(margin)}`}>{margin.toFixed(1)}%</span>
                                    : <span className="text-muted-foreground text-[10px]">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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
                          {expandedBrand === b.brand && brandProductGroups.map((pg, pgi) => {
                            const pgKey = `${b.brand}-pg-${pgi}`;
                            const isPgExpanded = expandedProduct === pgKey;
                            const priceRange = pg.minPrice === pg.maxPrice
                              ? formatCurrency(pg.minPrice)
                              : `${formatCurrency(pg.minPrice)} – ${formatCurrency(pg.maxPrice)}`;
                            return (
                              <>
                                <tr
                                  key={pgKey}
                                  className="border-b border-border/10 bg-accent/10 hover:bg-accent/20 transition-colors cursor-pointer"
                                  onClick={(e) => { e.stopPropagation(); setExpandedProduct(isPgExpanded ? null : pgKey); }}
                                >
                                  <td className="py-1.5 pl-2">
                                    {isPgExpanded
                                      ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                                      : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                                  </td>
                                  <td className="py-1.5 pl-2 font-medium max-w-[200px] truncate" colSpan={2}>{pg.title}</td>
                                  <td className="py-1.5 text-right tabular-nums">{formatNumber(pg.totalStock)}</td>
                                  <td className="py-1.5 text-right text-[10px] text-muted-foreground">{pg.variantCount} variants</td>
                                  <td className="py-1.5 text-right tabular-nums text-[10px]">{priceRange}</td>
                                </tr>
                                {isPgExpanded && pg.items.map((variant: any, vi: number) => {
                                  const vp = parseVariantTitle(variant.variant_title);
                                  return (
                                    <tr key={variant.sku || `${pgKey}-v${vi}`} className="border-b border-border/10 bg-accent/5">
                                      <td className="py-1 pl-6"></td>
                                      <td className="py-1 pl-4 font-mono text-[10px] text-muted-foreground" colSpan={1}>{variant.sku || '—'}</td>
                                      <td className="py-1 text-muted-foreground text-[10px]">{vp.color || '—'}</td>
                                      <td className="py-1 text-muted-foreground text-[10px]">{vp.size || '—'}</td>
                                      <td className="py-1 text-right tabular-nums text-[10px]">{variant.inventory_quantity ?? 0}</td>
                                      <td className="py-1 text-right tabular-nums text-[10px]">{formatCurrency(parseFloat(variant.price) || 0)}</td>
                                    </tr>
                                  );
                                })}
                              </>
                            );
                          })}
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
