/**
 * Dead Stock / Aging Inventory Management Page
 * 死貨 / 老化庫存管理
 *
 * All computation is client-side using useMemo for 4000+ SKU efficiency.
 * Data sources: shopify_inventory, bc_inventory, shopify_order_lines,
 *               shopify_orders, dead_stock_reviews, dead_stock_audit_log
 *
 * Layout: Product-grouped rows (expand to see variant SKUs).
 * Filters integrated into the table header row.
 * No "priority" field — removed per user request.
 *
 * Enhancements:
 * - New columns: Compare Price, Retail Price, Unit Cost, Margin %
 * - Resizable columns (drag right border)
 * - Reorderable columns (drag header)
 * - Sticky header
 * - localStorage persistence for column order/widths
 * - Column definitions array for clean rendering
 */
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Package, AlertTriangle, Search, Filter, ChevronDown, ChevronUp,
  ChevronRight, Calendar, Edit3, Save, X, RotateCcw, TrendingDown, Archive,
  Eye, Clock, CheckCircle2, XCircle, Info,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface ShopifyInventoryRow {
  sku: string;
  product_title: string;
  variant_title: string | null;
  vendor: string;
  product_type: string;
  inventory_quantity: number;
  price: number;
  compare_at_price: number | null;
}

interface BcInventoryRow {
  number: string; // = sku
  unit_cost: number;
  unit_price: number;
}

interface OrderLineRow {
  sku: string;
  quantity: number;
  order_id: string;
}

interface OrderRow {
  id: string;
  created_at: string;
  cancelled_at: string | null;
}

interface DeadStockReview {
  sku: string;
  manual_status: string | null;
  priority: string | null;
  action: string | null;
  notes: string | null;
  reviewer: string | null;
  last_review_date: string | null;
  next_review_date: string | null;
  revived: boolean | null;
  system_status_override: string | null;
}

interface AuditLogRow {
  sku: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: string;
}

type SystemStatus = '正常' | '慢移貨' | '高風險死貨' | '真正死貨';

interface DeadStockItem {
  sku: string;
  product_title: string;
  variant_title: string | null;
  vendor: string;
  product_type: string;
  inventory_quantity: number;
  price: number;
  compare_at_price: number | null;
  unit_cost: number;
  stock_cost: number;
  last_sold_date: string | null;
  first_sold_date: string | null;
  sold_30d: number;
  sold_90d: number;
  days_since_last_sale: number;
  system_status: SystemStatus;
  // from review
  manual_status: string | null;
  action: string | null;
  notes: string | null;
  reviewer: string | null;
  last_review_date: string | null;
  next_review_date: string | null;
  revived: boolean;
}

/** A product group = product_title as key, with aggregated totals + child SKUs */
interface ProductGroup {
  product_title: string;
  vendor: string;
  product_type: string;
  total_qty: number;
  total_stock_cost: number;
  worst_system_status: SystemStatus;
  worst_days_since: number;
  total_sold_90d: number;
  avg_margin: number | null;
  skus: DeadStockItem[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const MANUAL_STATUS_LABELS: Record<string, string> = {
  pending_review: '待確認',
  observing: '觀察中',
  confirmed_dead: '真死貨',
  revived: '已翻生',
  promoting: '推廣中',
  cleared: '已清貨',
  keep: '保留不清',
};

const ACTION_LABELS: Record<string, string> = {
  discount: '減價',
  bundle: 'Bundle 銷售',
  store_promo: '門市促銷',
  online_sale: '網店特價',
  transfer: '轉倉',
  stop_reorder: '停補貨',
  clearance: '清倉',
};

const SYSTEM_STATUS_OPTIONS: SystemStatus[] = ['正常', '慢移貨', '高風險死貨', '真正死貨'];
const MANUAL_STATUS_OPTIONS = Object.keys(MANUAL_STATUS_LABELS);
const ACTION_OPTIONS = Object.keys(ACTION_LABELS);

const STATUS_ORDER: Record<string, number> = { '正常': 0, '慢移貨': 1, '高風險死貨': 2, '真正死貨': 3 };

// ── Filter State ──────────────────────────────────────────────────────────────

interface FilterState {
  search: string;
  vendors: string[];
  product_types: string[];
  system_statuses: SystemStatus[];
  manual_statuses: string[];
  actions: string[];
}

const DEFAULT_FILTERS: FilterState = {
  search: '',
  vendors: [],
  product_types: [],
  system_statuses: [],
  manual_statuses: [],
  actions: [],
};

type SortKey = 'stock_cost' | 'total_qty' | 'worst_days_since' | 'total_sold_90d' | 'worst_system_status';
type SortDir = 'asc' | 'desc';

// ── Column Configuration ─────────────────────────────────────────────────────

interface ColumnDef {
  id: string;
  label: string;
  align: 'left' | 'right';
  defaultWidth: number;
  sortKey?: SortKey;
  filter?: 'vendors' | 'product_types' | 'system_statuses';
  renderGroup: (group: ProductGroup) => React.ReactNode;
  renderItem: (item: DeadStockItem) => React.ReactNode;
}

interface ColumnConfig {
  order: string[];
  widths: Record<string, number>;
}

const LOCALSTORAGE_KEY = 'hk-deadstock-columns';

// Helper: margin color class
function marginColorClass(margin: number): string {
  if (margin > 40) return 'text-green-400';
  if (margin >= 20) return 'text-amber-400';
  return 'text-red-400';
}

// Helper: compute margin
function computeMargin(price: number, unitCost: number): number | null {
  if (!price || price === 0) return null;
  return ((price - unitCost) / price) * 100;
}

// ── Dropdown Popover component (for header filter) ──────────────────────────

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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hasFilter = selected.length > 0;

  return (
    <div ref={ref} className="relative inline-block">
      <button
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
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 bg-background border border-border rounded-md shadow-lg min-w-[140px] max-h-52 overflow-y-auto p-1.5">
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
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DeadStockPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // raw data
  const [shopifyInv, setShopifyInv] = useState<ShopifyInventoryRow[]>([]);
  const [bcInv, setBcInv] = useState<BcInventoryRow[]>([]);
  const [orderLines, setOrderLines] = useState<OrderLineRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [reviews, setReviews] = useState<DeadStockReview[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);

  // UI state
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('stock_cost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  // form state for expanded SKU detail
  const [formState, setFormState] = useState<Partial<DeadStockReview>>({});
  const [formOriginal, setFormOriginal] = useState<Partial<DeadStockReview>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Batch selection state
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchField, setBatchField] = useState<'system_status' | 'manual_status' | 'action'>('manual_status');
  const [batchValue, setBatchValue] = useState('');

  // ── Column order & widths state ─────────────────────────────────────────────

  const DEFAULT_COLUMN_ORDER = [
    'product_title', 'vendor', 'product_type', 'total_qty',
    'compare_price', 'retail_price', 'unit_cost', 'stock_cost',
    'margin_pct', 'days_since', 'sold_90d', 'system_status',
  ];

  const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
    product_title: 220,
    vendor: 100,
    product_type: 100,
    total_qty: 70,
    compare_price: 90,
    retail_price: 85,
    unit_cost: 80,
    stock_cost: 90,
    margin_pct: 70,
    days_since: 80,
    sold_90d: 70,
    system_status: 140,
  };

  const [columnOrder, setColumnOrder] = useState<string[]>(DEFAULT_COLUMN_ORDER);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(DEFAULT_COLUMN_WIDTHS);

  // Load column config from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LOCALSTORAGE_KEY);
      if (raw) {
        const config: ColumnConfig = JSON.parse(raw);
        // Merge gracefully: keep known columns in saved order, append new ones
        const knownIds = new Set(DEFAULT_COLUMN_ORDER);
        const savedOrder = (config.order ?? []).filter((id: string) => knownIds.has(id));
        const savedSet = new Set(savedOrder);
        const newCols = DEFAULT_COLUMN_ORDER.filter(id => !savedSet.has(id));
        const mergedOrder = [...savedOrder, ...newCols];

        const mergedWidths: Record<string, number> = { ...DEFAULT_COLUMN_WIDTHS };
        if (config.widths) {
          for (const [k, v] of Object.entries(config.widths)) {
            if (knownIds.has(k) && typeof v === 'number' && v > 30) {
              mergedWidths[k] = v;
            }
          }
        }

        setColumnOrder(mergedOrder);
        setColumnWidths(mergedWidths);
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  // Save column config to localStorage (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const config: ColumnConfig = { order: columnOrder, widths: columnWidths };
        localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(config));
      } catch {
        // ignore quota errors
      }
    }, 300);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [columnOrder, columnWidths]);

  // ── Resize handling (via ref to avoid excessive re-renders) ─────────────────

  const resizeRef = useRef<{
    active: boolean;
    colId: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = columnWidths[colId] ?? DEFAULT_COLUMN_WIDTHS[colId] ?? 100;
    resizeRef.current = { active: true, colId, startX: e.clientX, startWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizeRef.current?.active) return;
      const diff = ev.clientX - resizeRef.current.startX;
      const newWidth = Math.max(40, resizeRef.current.startWidth + diff);
      setColumnWidths(prev => ({ ...prev, [resizeRef.current!.colId]: newWidth }));
    };

    const onMouseUp = () => {
      if (resizeRef.current) resizeRef.current.active = false;
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [columnWidths]);

  // ── Drag-to-reorder handling ────────────────────────────────────────────────

  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, colId: string) => {
    setDragColId(colId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', colId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, colId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (colId !== dragColId) {
      setDragOverColId(colId);
    }
  }, [dragColId]);

  const handleDragEnd = useCallback(() => {
    if (dragColId && dragOverColId && dragColId !== dragOverColId) {
      setColumnOrder(prev => {
        const newOrder = [...prev];
        const fromIdx = newOrder.indexOf(dragColId);
        const toIdx = newOrder.indexOf(dragOverColId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        newOrder.splice(fromIdx, 1);
        newOrder.splice(toIdx, 0, dragColId);
        return newOrder;
      });
    }
    setDragColId(null);
    setDragOverColId(null);
  }, [dragColId, dragOverColId]);

  const handleDragLeave = useCallback(() => {
    setDragOverColId(null);
  }, []);

  // ── Data Loading ────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invRows, bcRows, linesRows, ordersRows, reviewsResult, auditResult] = await Promise.all([
        queryAllPages('shopify_inventory', 'sku,product_title,variant_title,vendor,product_type,inventory_quantity,price,compare_at_price'),
        queryAllPages('bc_inventory', 'number,unit_cost,unit_price'),
        queryAllPages('shopify_order_lines', 'sku,quantity,order_id'),
        queryAllPages('shopify_orders', 'id,created_at,cancelled_at'),
        supabase.from('dead_stock_reviews').select('*'),
        supabase.from('dead_stock_audit_log').select('*').order('changed_at', { ascending: false }),
      ]);

      setShopifyInv(invRows as ShopifyInventoryRow[]);
      setBcInv(bcRows as BcInventoryRow[]);
      setOrderLines(linesRows as OrderLineRow[]);
      setOrders(ordersRows as OrderRow[]);
      setReviews((reviewsResult.data ?? []) as DeadStockReview[]);
      setAuditLog((auditResult.data ?? []) as AuditLogRow[]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Data Computation ────────────────────────────────────────────────────────

  const computedItems = useMemo<DeadStockItem[]>(() => {
    const now = Date.now();
    const MS_PER_DAY = 86400000;

    const bcMap = new Map<string, BcInventoryRow>();
    for (const b of bcInv) bcMap.set(b.number, b);

    const reviewMap = new Map<string, DeadStockReview>();
    for (const r of reviews) reviewMap.set(r.sku, r);

    const orderMap = new Map<string, { created_at: string; cancelled: boolean }>();
    for (const o of orders) {
      orderMap.set(o.id, { created_at: o.created_at, cancelled: !!o.cancelled_at });
    }

    const skuStats = new Map<string, { lastDate: number; firstDate: number; sold30: number; sold90: number }>();
    const now30 = now - 30 * MS_PER_DAY;
    const now90 = now - 90 * MS_PER_DAY;

    for (const line of orderLines) {
      const ord = orderMap.get(line.order_id);
      if (!ord || ord.cancelled) continue;
      const ts = new Date(ord.created_at).getTime();
      if (isNaN(ts)) continue;

      const existing = skuStats.get(line.sku);
      if (!existing) {
        skuStats.set(line.sku, {
          lastDate: ts,
          firstDate: ts,
          sold30: ts >= now30 ? (line.quantity ?? 0) : 0,
          sold90: ts >= now90 ? (line.quantity ?? 0) : 0,
        });
      } else {
        if (ts > existing.lastDate) existing.lastDate = ts;
        if (ts < existing.firstDate) existing.firstDate = ts;
        if (ts >= now30) existing.sold30 += line.quantity ?? 0;
        if (ts >= now90) existing.sold90 += line.quantity ?? 0;
      }
    }

    const result: DeadStockItem[] = [];

    for (const inv of shopifyInv) {
      const bc = bcMap.get(inv.sku);
      const unitCost = bc?.unit_cost ?? 0;
      const stockCost = inv.inventory_quantity * unitCost;

      const stats = skuStats.get(inv.sku);
      const lastSoldTs = stats?.lastDate ?? null;
      const daysSince = lastSoldTs != null
        ? Math.floor((now - lastSoldTs) / MS_PER_DAY)
        : 9999;

      const lastSoldDate = lastSoldTs != null
        ? new Date(lastSoldTs).toISOString().slice(0, 10)
        : null;
      const firstSoldDate = stats?.firstDate != null
        ? new Date(stats.firstDate).toISOString().slice(0, 10)
        : null;

      let system_status: SystemStatus;
      if (inv.inventory_quantity <= 0) system_status = '正常'; // 0 庫存不算死貨風險
      else if (daysSince >= 270 && inv.inventory_quantity >= 3) system_status = '真正死貨';
      else if (daysSince >= 180) system_status = '高風險死貨';
      else if (daysSince >= 90) system_status = '慢移貨';
      else system_status = '正常';

      const rev = reviewMap.get(inv.sku);

      const VALID_SYSTEM_STATUSES: SystemStatus[] = ['正常', '慢移貨', '高風險死貨', '真正死貨'];
      if (rev?.system_status_override && VALID_SYSTEM_STATUSES.includes(rev.system_status_override as SystemStatus)) {
        system_status = rev.system_status_override as SystemStatus;
      }

      result.push({
        sku: inv.sku,
        product_title: inv.product_title,
        variant_title: inv.variant_title ?? null,
        vendor: inv.vendor,
        product_type: inv.product_type,
        inventory_quantity: inv.inventory_quantity,
        price: inv.price ?? 0,
        compare_at_price: inv.compare_at_price ?? null,
        unit_cost: unitCost,
        stock_cost: stockCost,
        last_sold_date: lastSoldDate,
        first_sold_date: firstSoldDate,
        sold_30d: stats?.sold30 ?? 0,
        sold_90d: stats?.sold90 ?? 0,
        days_since_last_sale: daysSince,
        system_status,
        manual_status: rev?.manual_status ?? null,
        action: rev?.action ?? null,
        notes: rev?.notes ?? null,
        reviewer: rev?.reviewer ?? null,
        last_review_date: rev?.last_review_date ?? null,
        next_review_date: rev?.next_review_date ?? null,
        revived: rev?.revived ?? false,
      });
    }

    return result;
  }, [shopifyInv, bcInv, orderLines, orders, reviews]);

  // ── Summary stats ───────────────────────────────────────────────────────────

  const summaryStats = useMemo(() => {
    const nonNormal = computedItems.filter(i => i.system_status !== '正常');
    const totalCost = nonNormal.reduce((s, i) => s + i.stock_cost, 0);

    const brandCost = new Map<string, number>();
    for (const i of nonNormal) {
      brandCost.set(i.vendor, (brandCost.get(i.vendor) ?? 0) + i.stock_cost);
    }
    const topBrands = Array.from(brandCost.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const aging = {
      '0-90d': nonNormal.filter(i => i.days_since_last_sale < 90).length,
      '91-180d': nonNormal.filter(i => i.days_since_last_sale >= 90 && i.days_since_last_sale < 180).length,
      '181-270d': nonNormal.filter(i => i.days_since_last_sale >= 180 && i.days_since_last_sale < 270).length,
      '270d+': nonNormal.filter(i => i.days_since_last_sale >= 270).length,
    };

    return { count: nonNormal.length, totalCost, topBrands, aging };
  }, [computedItems]);

  // ── Distinct filter options ─────────────────────────────────────────────────

  const filterOptions = useMemo(() => {
    const vendors = Array.from(new Set(computedItems.map(i => i.vendor))).filter(Boolean).sort();
    const product_types = Array.from(new Set(computedItems.map(i => i.product_type))).filter(Boolean).sort();
    return { vendors, product_types };
  }, [computedItems]);

  // ── Filtered items → Product groups ─────────────────────────────────────────

  const productGroups = useMemo<ProductGroup[]>(() => {
    let items = computedItems;

    // Default: hide normal (but keep 0-stock variants for grouping — they'll be visible inside groups that have stocked variants)
    const hasStatusFilter = filters.system_statuses.length > 0;
    if (!hasStatusFilter) {
      items = items.filter(i => i.system_status !== '正常' || i.inventory_quantity <= 0);
    }

    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter(i =>
        i.sku.toLowerCase().includes(q) ||
        i.product_title.toLowerCase().includes(q)
      );
    }
    if (filters.vendors.length) items = items.filter(i => filters.vendors.includes(i.vendor));
    if (filters.product_types.length) items = items.filter(i => filters.product_types.includes(i.product_type));
    if (hasStatusFilter) items = items.filter(i => filters.system_statuses.includes(i.system_status));
    if (filters.manual_statuses.length) items = items.filter(i => filters.manual_statuses.includes(i.manual_status ?? ''));
    if (filters.actions.length) items = items.filter(i => filters.actions.includes(i.action ?? ''));

    // Group by product_title
    const groupMap = new Map<string, DeadStockItem[]>();
    for (const item of items) {
      const key = item.product_title || item.sku;
      const arr = groupMap.get(key);
      if (arr) arr.push(item);
      else groupMap.set(key, [item]);
    }

    const groups: ProductGroup[] = [];
    for (const [title, skus] of Array.from(groupMap.entries())) {
      const total_qty = skus.reduce((s, i) => s + i.inventory_quantity, 0);
      const total_stock_cost = skus.reduce((s, i) => s + i.stock_cost, 0);
      const total_sold_90d = skus.reduce((s, i) => s + i.sold_90d, 0);
      const worst_days_since = Math.max(...skus.map(i => i.days_since_last_sale));
      let worstIdx = 0;
      for (const s of skus) {
        if ((STATUS_ORDER[s.system_status] ?? 0) > worstIdx) worstIdx = STATUS_ORDER[s.system_status] ?? 0;
      }
      const worst_system_status = (['正常', '慢移貨', '高風險死貨', '真正死貨'] as SystemStatus[])[worstIdx];

      // Weighted average margin (weight by price * qty, fallback to simple average)
      let totalRevenue = 0;
      let totalCostWeighted = 0;
      let marginCount = 0;
      for (const s of skus) {
        if (s.price > 0) {
          const qty = Math.max(s.inventory_quantity, 1);
          totalRevenue += s.price * qty;
          totalCostWeighted += s.unit_cost * qty;
          marginCount++;
        }
      }
      const avg_margin = totalRevenue > 0
        ? ((totalRevenue - totalCostWeighted) / totalRevenue) * 100
        : null;

      groups.push({
        product_title: title,
        vendor: skus[0].vendor,
        product_type: skus[0].product_type,
        total_qty,
        total_stock_cost,
        worst_system_status,
        worst_days_since,
        total_sold_90d,
        avg_margin,
        skus,
      });
    }

    // Hide product groups where ALL variants have 0 stock (unless user explicitly filters for them)
    const visibleGroups = hasStatusFilter
      ? groups
      : groups.filter(g => g.skus.some(s => s.inventory_quantity > 0));

    // Sort groups
    visibleGroups.sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'worst_system_status') {
        return ((STATUS_ORDER[a.worst_system_status] ?? 0) - (STATUS_ORDER[b.worst_system_status] ?? 0)) * mul;
      }
      return ((a as any)[sortKey] - (b as any)[sortKey]) * mul;
    });

    return visibleGroups;
  }, [computedItems, filters, sortKey, sortDir]);

  const totalFilteredSkus = useMemo(() => productGroups.reduce((s, g) => s + g.skus.length, 0), [productGroups]);

  // ── Sort handler ────────────────────────────────────────────────────────────

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  // ── Product group expand ───────────────────────────────────────────────────

  const toggleProduct = (title: string) => {
    setExpandedProduct(prev => prev === title ? null : title);
    setExpandedSku(null);
    setSaveSuccess(false);
  };

  // ── SKU detail expand ─────────────────────────────────────────────────────

  const handleSkuClick = (item: DeadStockItem) => {
    if (expandedSku === item.sku) {
      setExpandedSku(null);
    } else {
      setExpandedSku(item.sku);
      const form: Partial<DeadStockReview> = {
        sku: item.sku,
        manual_status: item.manual_status ?? '',
        action: item.action ?? '',
        notes: item.notes ?? '',
        reviewer: item.reviewer ?? '',
        next_review_date: item.next_review_date ?? '',
        revived: item.revived,
      };
      setFormState(form);
      setFormOriginal(form);
      setSaveSuccess(false);
    }
  };

  // ── Save review ─────────────────────────────────────────────────────────────

  const handleSave = async (sku: string) => {
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const payload = {
        sku,
        manual_status: formState.manual_status || null,
        action: formState.action || null,
        notes: formState.notes || null,
        reviewer: formState.reviewer || null,
        last_review_date: now.slice(0, 10),
        next_review_date: formState.next_review_date || null,
        revived: formState.revived ?? false,
      };

      const { error: upsertErr } = await supabase
        .from('dead_stock_reviews')
        .upsert(payload, { onConflict: 'sku' });

      if (upsertErr) throw upsertErr;

      const changedBy = formState.reviewer || 'unknown';
      const auditRows: Omit<AuditLogRow, 'id'>[] = [];
      const fields: (keyof typeof payload)[] = ['manual_status', 'action', 'notes', 'next_review_date', 'revived'];
      for (const f of fields) {
        const oldVal = String(formOriginal[f as keyof typeof formOriginal] ?? '');
        const newVal = String(payload[f] ?? '');
        if (oldVal !== newVal) {
          auditRows.push({
            sku,
            field_name: f,
            old_value: oldVal || null,
            new_value: newVal || null,
            changed_by: changedBy,
            changed_at: now,
          });
        }
      }
      if (auditRows.length > 0) {
        await supabase.from('dead_stock_audit_log').insert(auditRows);
      }

      const [newReviews, newAudit] = await Promise.all([
        supabase.from('dead_stock_reviews').select('*'),
        supabase.from('dead_stock_audit_log').select('*').order('changed_at', { ascending: false }),
      ]);
      if (newReviews.data) setReviews(newReviews.data as DeadStockReview[]);
      if (newAudit.data) setAuditLog(newAudit.data as AuditLogRow[]);

      setFormOriginal({ ...formState });
      setSaveSuccess(true);
    } catch (e: any) {
      alert('儲存失敗: ' + (e?.message ?? String(e)));
    } finally {
      setSaving(false);
    }
  };

  // ── Preset filter buttons ───────────────────────────────────────────────────

  const applyPreset = (preset: string) => {
    setFilters(() => {
      const base = { ...DEFAULT_FILTERS };
      switch (preset) {
        case 'all_dead': return { ...base };
        case 'truly_dead': return { ...base, system_statuses: ['真正死貨'] as SystemStatus[] };
        case 'high_risk': return { ...base, system_statuses: ['高風險死貨'] as SystemStatus[] };
        case 'revived': return { ...base, manual_statuses: ['revived'] };
        case 'pending': return { ...base, manual_statuses: ['pending_review', ''] };
        case 'promotable': return { ...base, actions: ['discount', 'bundle', 'store_promo', 'online_sale'] };
        default: return base;
      }
    });
  };

  // ── Audit log for expanded SKU ──────────────────────────────────────────────

  const skuAuditLog = useMemo(() => {
    if (!expandedSku) return [];
    return auditLog.filter(a => a.sku === expandedSku).slice(0, 20);
  }, [auditLog, expandedSku]);

  // ── Sort icon helper ────────────────────────────────────────────────────────

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ChevronDown className="h-3 w-3 opacity-30 inline ml-0.5" />;
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-primary inline ml-0.5" />
      : <ChevronDown className="h-3 w-3 text-primary inline ml-0.5" />;
  };

  // ── Inline field update helper ──────────────────────────────────────────────

  const handleInlineUpdate = async (
    sku: string,
    fieldName: 'system_status_override' | 'manual_status' | 'action',
    newValue: string,
    oldValue: string | null,
  ) => {
    const dbField = fieldName === 'system_status_override' ? 'system_status_override' : fieldName;
    const auditField = fieldName === 'system_status_override' ? 'system_status' : fieldName;

    await supabase.from('dead_stock_reviews').upsert({
      sku,
      [dbField]: newValue || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sku' });

    await supabase.from('dead_stock_audit_log').insert({
      sku,
      field_name: auditField,
      old_value: oldValue || null,
      new_value: newValue || null,
      changed_by: 'user',
      changed_at: new Date().toISOString(),
    });

    const [newReviews, newAudit] = await Promise.all([
      supabase.from('dead_stock_reviews').select('*'),
      supabase.from('dead_stock_audit_log').select('*').order('changed_at', { ascending: false }),
    ]);
    if (newReviews.data) setReviews(newReviews.data as DeadStockReview[]);
    if (newAudit.data) setAuditLog(newAudit.data as AuditLogRow[]);
  };

  // ── Checkbox toggle helpers ─────────────────────────────────────────────────

  const toggleSelect = (sku: string) => {
    setSelectedSkus(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allSkus = productGroups.flatMap(g => g.skus.map(s => s.sku));
    if (selectedSkus.size === allSkus.length) {
      setSelectedSkus(new Set());
    } else {
      setSelectedSkus(new Set(allSkus));
    }
  };

  // ── Batch update handler ───────────────────────────────────────────────────

  const handleBatchUpdate = async () => {
    if (selectedSkus.size === 0 || !batchValue) return;
    setBatchSaving(true);
    try {
      const skus = Array.from(selectedSkus);
      const now = new Date().toISOString();
      const dbField = batchField === 'system_status' ? 'system_status_override' : batchField;

      for (const sku of skus) {
        await supabase.from('dead_stock_reviews').upsert({
          sku,
          [dbField]: batchValue || null,
          updated_at: now,
        }, { onConflict: 'sku' });

        await supabase.from('dead_stock_audit_log').insert({
          sku,
          field_name: batchField,
          old_value: null,
          new_value: batchValue,
          changed_by: 'batch',
          changed_at: now,
        });
      }

      const [newReviews, newAudit] = await Promise.all([
        supabase.from('dead_stock_reviews').select('*'),
        supabase.from('dead_stock_audit_log').select('*').order('changed_at', { ascending: false }),
      ]);
      if (newReviews.data) setReviews(newReviews.data as DeadStockReview[]);
      if (newAudit.data) setAuditLog(newAudit.data as AuditLogRow[]);

      setSelectedSkus(new Set());
      setBatchValue('');
    } catch (e: any) {
      alert('批量更新失敗: ' + (e?.message ?? String(e)));
    } finally {
      setBatchSaving(false);
    }
  };

  const BATCH_FIELD_OPTIONS: Record<string, { label: string; options: { value: string; label: string }[] }> = {
    system_status: {
      label: '系統狀態',
      options: SYSTEM_STATUS_OPTIONS.map(s => ({ value: s, label: s })),
    },
    manual_status: {
      label: '人手狀態',
      options: MANUAL_STATUS_OPTIONS.map(k => ({ value: k, label: MANUAL_STATUS_LABELS[k] })),
    },
    action: {
      label: '動作',
      options: ACTION_OPTIONS.map(k => ({ value: k, label: ACTION_LABELS[k] })),
    },
  };

  // ── Filter toggle helper ──────────────────────────────────────────────────

  function toggleFilter<T extends string>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val];
  }

  // ── Column Definitions ──────────────────────────────────────────────────────

  const columnDefs = useMemo<ColumnDef[]>(() => {
    return [
      {
        id: 'product_title',
        label: '產品名稱',
        align: 'left' as const,
        defaultWidth: 220,
        renderGroup: (group: ProductGroup) => (
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium" title={group.product_title}>
              {group.product_title?.slice(0, 40)}{(group.product_title?.length ?? 0) > 40 ? '…' : ''}
            </span>
            <span className="shrink-0 px-1.5 py-0 rounded bg-muted text-muted-foreground text-[9px] border border-border/40">
              {group.skus.length} SKU
            </span>
          </div>
        ),
        renderItem: (item: DeadStockItem) => (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">{item.sku}</span>
            {item.variant_title && (
              <span className="text-[10px] text-foreground/70">{item.variant_title}</span>
            )}
          </div>
        ),
      },
      {
        id: 'vendor',
        label: '品牌',
        align: 'left' as const,
        defaultWidth: 100,
        filter: 'vendors' as const,
        renderGroup: (group: ProductGroup) => (
          <span className="text-muted-foreground">{group.vendor}</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="text-muted-foreground text-[10px]">{item.vendor}</span>
        ),
      },
      {
        id: 'product_type',
        label: '分類',
        align: 'left' as const,
        defaultWidth: 100,
        filter: 'product_types' as const,
        renderGroup: (group: ProductGroup) => (
          <span className="text-muted-foreground">{group.product_type}</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="text-muted-foreground text-[10px]">{item.product_type}</span>
        ),
      },
      {
        id: 'total_qty',
        label: '總存量',
        align: 'right' as const,
        defaultWidth: 70,
        sortKey: 'total_qty' as SortKey,
        renderGroup: (group: ProductGroup) => (
          <span className="tabular-nums">{formatNumber(group.total_qty)}</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="tabular-nums text-[10px]">{formatNumber(item.inventory_quantity)}</span>
        ),
      },
      {
        id: 'compare_price',
        label: '比較價',
        align: 'right' as const,
        defaultWidth: 90,
        renderGroup: (_group: ProductGroup) => (
          <span className="text-muted-foreground">—</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="tabular-nums text-[10px] text-muted-foreground">
            {item.compare_at_price != null && item.compare_at_price > 0
              ? formatCurrency(item.compare_at_price)
              : '—'}
          </span>
        ),
      },
      {
        id: 'retail_price',
        label: '零售價',
        align: 'right' as const,
        defaultWidth: 85,
        renderGroup: (_group: ProductGroup) => (
          <span className="text-muted-foreground">—</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="tabular-nums text-[10px]">{formatCurrency(item.price)}</span>
        ),
      },
      {
        id: 'unit_cost',
        label: '單件成本',
        align: 'right' as const,
        defaultWidth: 80,
        renderGroup: (_group: ProductGroup) => (
          <span className="text-muted-foreground">—</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="tabular-nums text-[10px]">{formatCurrency(item.unit_cost)}</span>
        ),
      },
      {
        id: 'stock_cost',
        label: '庫存成本',
        align: 'right' as const,
        defaultWidth: 90,
        sortKey: 'stock_cost' as SortKey,
        renderGroup: (group: ProductGroup) => (
          <span className="tabular-nums font-medium">{formatCurrency(group.total_stock_cost)}</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="tabular-nums text-[10px]">{formatCurrency(item.stock_cost)}</span>
        ),
      },
      {
        id: 'margin_pct',
        label: '利潤%',
        align: 'right' as const,
        defaultWidth: 70,
        renderGroup: (group: ProductGroup) => {
          if (group.avg_margin == null) return <span className="text-muted-foreground">—</span>;
          return (
            <span className={`tabular-nums font-medium ${marginColorClass(group.avg_margin)}`}>
              {group.avg_margin.toFixed(1)}%
            </span>
          );
        },
        renderItem: (item: DeadStockItem) => {
          const margin = computeMargin(item.price, item.unit_cost);
          if (margin == null) return <span className="text-muted-foreground text-[10px]">—</span>;
          return (
            <span className={`tabular-nums text-[10px] font-medium ${marginColorClass(margin)}`}>
              {margin.toFixed(1)}%
            </span>
          );
        },
      },
      {
        id: 'days_since',
        label: '最長無銷天數',
        align: 'right' as const,
        defaultWidth: 80,
        sortKey: 'worst_days_since' as SortKey,
        renderGroup: (group: ProductGroup) => (
          <span className={group.worst_days_since >= 270 ? 'text-red-400 font-medium tabular-nums' : group.worst_days_since >= 180 ? 'text-orange-400 tabular-nums' : 'text-amber-400 tabular-nums'}>
            {group.worst_days_since >= 9000 ? '∞' : group.worst_days_since}
          </span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className={`text-[10px] tabular-nums ${item.days_since_last_sale >= 270 ? 'text-red-400 font-medium' : item.days_since_last_sale >= 180 ? 'text-orange-400' : 'text-amber-400'}`}>
            {item.days_since_last_sale >= 9000 ? '∞' : item.days_since_last_sale}
          </span>
        ),
      },
      {
        id: 'sold_90d',
        label: '近90日銷',
        align: 'right' as const,
        defaultWidth: 70,
        sortKey: 'total_sold_90d' as SortKey,
        renderGroup: (group: ProductGroup) => (
          <span className="tabular-nums text-muted-foreground">{group.total_sold_90d}</span>
        ),
        renderItem: (item: DeadStockItem) => (
          <span className="tabular-nums text-[10px] text-muted-foreground">{item.sold_90d}</span>
        ),
      },
      {
        id: 'system_status',
        label: '系統狀態',
        align: 'left' as const,
        defaultWidth: 140,
        sortKey: 'worst_system_status' as SortKey,
        filter: 'system_statuses' as const,
        renderGroup: (group: ProductGroup) => (
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
            group.worst_system_status === '真正死貨' ? 'bg-red-500/15 text-red-400 border-red-500/30' :
            group.worst_system_status === '高風險死貨' ? 'bg-orange-500/15 text-orange-400 border-orange-500/30' :
            group.worst_system_status === '慢移貨' ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' :
            'bg-green-500/15 text-green-400 border-green-500/30'
          }`}>
            {group.worst_system_status}
          </span>
        ),
        renderItem: () => null, // handled separately with inline dropdowns
      },
    ];
  }, []);

  // ── Ordered columns (applying user column order) ────────────────────────────

  const orderedColumns = useMemo(() => {
    const defMap = new Map(columnDefs.map(c => [c.id, c]));
    return columnOrder.map(id => defMap.get(id)).filter(Boolean) as ColumnDef[];
  }, [columnDefs, columnOrder]);

  // ── Column count = 2 fixed (checkbox + expand) + data columns ───────────────
  const COL_COUNT = 2 + orderedColumns.length;

  // ── Skeleton ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Skeleton className="h-6 w-56 mb-1" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-destructive p-4 rounded-md border border-destructive/30 bg-destructive/5">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /** Render the system_status column for a variant SKU row (with inline dropdowns) */
  const renderSystemStatusCell = (item: DeadStockItem) => (
    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
      <select
        value={item.system_status}
        onChange={async (e) => {
          const newVal = e.target.value as SystemStatus;
          if (newVal === item.system_status) return;
          await handleInlineUpdate(item.sku, 'system_status_override', newVal, item.system_status);
        }}
        className={`text-[10px] font-medium rounded border px-1 py-0.5 cursor-pointer bg-transparent ${
          item.system_status === '真正死貨' ? 'text-red-400 border-red-500/30' :
          item.system_status === '高風險死貨' ? 'text-orange-400 border-orange-500/30' :
          item.system_status === '慢移貨' ? 'text-amber-400 border-amber-500/30' :
          'text-green-400 border-green-500/30'
        }`}
      >
        <option value="正常">正常</option>
        <option value="慢移貨">慢移貨</option>
        <option value="高風險死貨">高風險死貨</option>
        <option value="真正死貨">真正死貨</option>
      </select>
      <select
        value={item.manual_status ?? ''}
        onChange={async (e) => {
          const newVal = e.target.value;
          if (newVal === (item.manual_status ?? '')) return;
          await handleInlineUpdate(item.sku, 'manual_status', newVal, item.manual_status);
        }}
        className={`text-[10px] font-medium rounded border px-1 py-0.5 cursor-pointer bg-transparent ${
          !item.manual_status ? 'text-muted-foreground border-border/30' :
          item.manual_status === 'confirmed_dead' ? 'text-red-400 border-red-500/30' :
          item.manual_status === 'revived' ? 'text-green-400 border-green-500/30' :
          item.manual_status === 'promoting' ? 'text-purple-400 border-purple-500/30' :
          item.manual_status === 'pending_review' ? 'text-yellow-400 border-yellow-500/30' :
          item.manual_status === 'observing' ? 'text-blue-400 border-blue-500/30' :
          'text-muted-foreground border-border/30'
        }`}
      >
        <option value="">—</option>
        {MANUAL_STATUS_OPTIONS.map(s => (
          <option key={s} value={s}>{MANUAL_STATUS_LABELS[s]}</option>
        ))}
      </select>
      <select
        value={item.action ?? ''}
        onChange={async (e) => {
          const newVal = e.target.value;
          if (newVal === (item.action ?? '')) return;
          await handleInlineUpdate(item.sku, 'action', newVal, item.action);
        }}
        className="text-[10px] font-medium rounded border px-1 py-0.5 cursor-pointer bg-transparent text-muted-foreground border-border/30"
      >
        <option value="">—</option>
        {ACTION_OPTIONS.map(a => (
          <option key={a} value={a}>{ACTION_LABELS[a]}</option>
        ))}
      </select>
    </div>
  );

  /** Render a header cell for a column def */
  const renderHeaderCell = (col: ColumnDef) => {
    const width = columnWidths[col.id] ?? col.defaultWidth;
    const isDragTarget = dragOverColId === col.id;
    const isDragging = dragColId === col.id;

    // Determine content
    let content: React.ReactNode;

    if (col.filter && col.id === 'vendor') {
      content = (
        <FilterDropdown
          label={col.label}
          options={filterOptions.vendors}
          selected={filters.vendors}
          onToggle={v => setFilters(f => ({ ...f, vendors: toggleFilter(f.vendors, v) }))}
        />
      );
    } else if (col.filter && col.id === 'product_type') {
      content = (
        <FilterDropdown
          label={col.label}
          options={filterOptions.product_types}
          selected={filters.product_types}
          onToggle={v => setFilters(f => ({ ...f, product_types: toggleFilter(f.product_types, v) }))}
        />
      );
    } else if (col.filter && col.id === 'system_status') {
      content = (
        <span
          className="cursor-pointer hover:text-foreground select-none"
          onClick={() => col.sortKey && handleSort(col.sortKey)}
        >
          <FilterDropdown
            label={col.label}
            options={SYSTEM_STATUS_OPTIONS}
            selected={filters.system_statuses}
            onToggle={v => setFilters(f => ({ ...f, system_statuses: toggleFilter(f.system_statuses, v as SystemStatus) }))}
          />
          {col.sortKey && <SortIcon col={col.sortKey} />}
        </span>
      );
    } else if (col.sortKey) {
      content = (
        <span
          className="cursor-pointer hover:text-foreground select-none text-[10px] font-medium text-muted-foreground whitespace-nowrap"
          onClick={() => col.sortKey && handleSort(col.sortKey)}
        >
          {col.label} <SortIcon col={col.sortKey} />
        </span>
      );
    } else {
      content = (
        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
          {col.label}
        </span>
      );
    }

    return (
      <th
        key={col.id}
        className={`px-2 py-2 relative select-none ${col.align === 'right' ? 'text-right' : 'text-left'}`}
        style={{ width: width, minWidth: width }}
        draggable
        onDragStart={(e) => handleDragStart(e, col.id)}
        onDragOver={(e) => handleDragOver(e, col.id)}
        onDragEnd={handleDragEnd}
        onDragLeave={handleDragLeave}
      >
        <div
          style={{ opacity: isDragging ? 0.5 : 1 }}
          className={isDragTarget ? 'border-l-2 border-l-blue-500 pl-1' : ''}
        >
          {content}
        </div>
        {/* Resize handle */}
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary z-20"
          onMouseDown={(e) => handleResizeStart(e, col.id)}
        />
      </th>
    );
  };

  /** Render a data cell for a group row */
  const renderGroupCell = (col: ColumnDef, group: ProductGroup) => {
    const width = columnWidths[col.id] ?? col.defaultWidth;
    return (
      <td
        key={col.id}
        className={`px-2 py-2 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
        style={{ width: width, minWidth: width }}
      >
        {col.renderGroup(group)}
      </td>
    );
  };

  /** Render a data cell for a variant SKU row */
  const renderItemCell = (col: ColumnDef, item: DeadStockItem) => {
    const width = columnWidths[col.id] ?? col.defaultWidth;

    // Special handling for system_status column (inline dropdowns)
    if (col.id === 'system_status') {
      return (
        <td
          key={col.id}
          className="px-2 py-1.5"
          style={{ width: width, minWidth: width }}
          onClick={e => e.stopPropagation()}
        >
          {renderSystemStatusCell(item)}
        </td>
      );
    }

    return (
      <td
        key={col.id}
        className={`px-2 py-1.5 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
        style={{ width: width, minWidth: width }}
      >
        {col.renderItem(item)}
      </td>
    );
  };

  return (
    <div className="space-y-4">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold leading-tight">死貨 / 老化庫存管理</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Dead &amp; Aging Stock Management</p>
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          刷新資料
        </button>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-4 gap-3">
        <Card className="border-border/50">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1.5">
              <TrendingDown className="h-3.5 w-3.5" />
              死貨 SKU 數量
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="text-2xl font-bold">{formatNumber(summaryStats.count)}</div>
            <p className="text-[10px] text-muted-foreground mt-0.5">非正常庫存品項</p>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" />
              死貨總庫存成本
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="text-2xl font-bold">{formatCurrency(summaryStats.totalCost)}</div>
            <p className="text-[10px] text-muted-foreground mt-0.5">含成本加權</p>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1.5">
              <Archive className="h-3.5 w-3.5" />
              各品牌死貨分布 (Top 5)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="space-y-0.5">
              {summaryStats.topBrands.map(([brand, cost]) => (
                <div key={brand} className="flex items-center justify-between text-[10px]">
                  <span className="truncate text-muted-foreground max-w-[100px]">{brand || '未知'}</span>
                  <span className="font-medium tabular-nums">{formatCurrency(cost)}</span>
                </div>
              ))}
              {summaryStats.topBrands.length === 0 && (
                <span className="text-[10px] text-muted-foreground">無資料</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs text-muted-foreground font-normal flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              老化區間分布
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="space-y-0.5">
              {Object.entries(summaryStats.aging).map(([label, count]) => (
                <div key={label} className="flex items-center justify-between text-[10px]">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium tabular-nums">{count} SKU</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Quick Preset + Search ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { key: 'all_dead', label: '全部死貨/慢移貨' },
            { key: 'truly_dead', label: '真正死貨' },
            { key: 'high_risk', label: '高風險死貨' },
            { key: 'revived', label: '已翻生' },
            { key: 'pending', label: '待確認/未覆核' },
            { key: 'promotable', label: '可促銷' },
          ].map(p => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className="px-2.5 py-1 rounded-md text-xs border border-border/60 bg-muted/40 hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="px-2.5 py-1 rounded-md text-xs border border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <X className="h-3 w-3 inline mr-0.5" />
            清除篩選
          </button>
        </div>

        {/* Search bar */}
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="搜尋 SKU / 產品名稱..."
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            className="w-full pl-8 pr-3 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* ── Batch toolbar ── */}
      {selectedSkus.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-primary/10 border border-primary/30 rounded-md">
          <span className="text-xs font-medium text-primary">已選 {selectedSkus.size} 個 SKU</span>
          <select
            value={batchField}
            onChange={e => { setBatchField(e.target.value as any); setBatchValue(''); }}
            className="px-2 py-1 rounded border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="system_status">系統狀態</option>
            <option value="manual_status">人手狀態</option>
            <option value="action">動作</option>
          </select>
          <select
            value={batchValue}
            onChange={e => setBatchValue(e.target.value)}
            className="px-2 py-1 rounded border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">— 選擇值 —</option>
            {BATCH_FIELD_OPTIONS[batchField]?.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={handleBatchUpdate}
            disabled={batchSaving || !batchValue}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Save className="h-3 w-3" />
            {batchSaving ? '更新中...' : '批量更新'}
          </button>
          <button
            onClick={() => setSelectedSkus(new Set())}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground border border-border hover:bg-muted/50 transition-colors"
          >
            <X className="h-3 w-3" />
            取消選擇
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="border border-border/50 rounded-lg overflow-hidden">
        {/* Summary bar */}
        <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b border-border/50">
          <span className="text-xs text-muted-foreground">
            顯示 <span className="font-medium text-foreground">{productGroups.length}</span> 個產品
            （<span className="font-medium text-foreground">{totalFilteredSkus}</span> 個 SKU）
          </span>
          {totalFilteredSkus > 0 && (
            <span className="text-xs text-muted-foreground">
              庫存成本合計: <span className="font-medium text-foreground">
                {formatCurrency(productGroups.reduce((s, g) => s + g.total_stock_cost, 0))}
              </span>
            </span>
          )}
        </div>

        {/* Scrollable table container with sticky header */}
        <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
          <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
            {/* ── Header row with integrated filters ── */}
            <thead className="bg-muted/30 border-b border-border/50" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <tr className="bg-muted/30">
                {/* Fixed: Checkbox */}
                <th className="px-2 py-2 bg-muted/30" style={{ width: 32, minWidth: 32 }}>
                  <input
                    type="checkbox"
                    checked={totalFilteredSkus > 0 && selectedSkus.size === totalFilteredSkus}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 rounded cursor-pointer"
                    title="全選 / 取消全選"
                  />
                </th>
                {/* Fixed: Expand arrow */}
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground bg-muted/30" style={{ width: 32, minWidth: 32 }}></th>
                {/* Dynamic data columns */}
                {orderedColumns.map(col => renderHeaderCell(col))}
              </tr>
            </thead>

            <tbody className="divide-y divide-border/30">
              {productGroups.length === 0 && (
                <tr>
                  <td colSpan={COL_COUNT} className="text-center py-8 text-sm text-muted-foreground">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    無符合條件的死貨 / 老化庫存
                  </td>
                </tr>
              )}
              {productGroups.map(group => {
                const isProductExpanded = expandedProduct === group.product_title;
                const skuCount = group.skus.length;
                const allGroupSkus = group.skus.map(s => s.sku);
                const allGroupSelected = allGroupSkus.every(s => selectedSkus.has(s));
                const someGroupSelected = allGroupSkus.some(s => selectedSkus.has(s));

                return (
                  <React.Fragment key={group.product_title}>
                    {/* ── Product group row ── */}
                    <tr
                      onClick={() => toggleProduct(group.product_title)}
                      className={`cursor-pointer transition-colors ${
                        isProductExpanded
                          ? 'bg-primary/5 border-l-2 border-l-primary'
                          : 'hover:bg-muted/30'
                      }`}
                    >
                      <td className="px-2 py-2" style={{ width: 32, minWidth: 32 }} onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={allGroupSelected}
                          ref={el => { if (el) el.indeterminate = someGroupSelected && !allGroupSelected; }}
                          onChange={() => {
                            setSelectedSkus(prev => {
                              const next = new Set(prev);
                              if (allGroupSelected) {
                                allGroupSkus.forEach(s => next.delete(s));
                              } else {
                                allGroupSkus.forEach(s => next.add(s));
                              }
                              return next;
                            });
                          }}
                          className="h-3.5 w-3.5 rounded cursor-pointer"
                        />
                      </td>
                      <td className="px-2 py-2 text-muted-foreground" style={{ width: 32, minWidth: 32 }}>
                        {isProductExpanded
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      {orderedColumns.map(col => renderGroupCell(col, group))}
                    </tr>

                    {/* ── Expanded variant SKU rows ── */}
                    {isProductExpanded && group.skus.map(item => {
                      const isSkuExpanded = expandedSku === item.sku;
                      return (
                        <React.Fragment key={item.sku}>
                          <tr
                            className={`bg-muted/5 transition-colors ${
                              isSkuExpanded ? 'bg-primary/5' : 'hover:bg-muted/20'
                            }`}
                          >
                            <td className="px-2 py-1.5 pl-6" style={{ width: 32, minWidth: 32 }} onClick={e => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selectedSkus.has(item.sku)}
                                onChange={() => toggleSelect(item.sku)}
                                className="h-3 w-3 rounded cursor-pointer"
                              />
                            </td>
                            <td
                              className="px-2 py-1.5 text-muted-foreground cursor-pointer"
                              style={{ width: 32, minWidth: 32 }}
                              onClick={() => handleSkuClick(item)}
                            >
                              {isSkuExpanded
                                ? <ChevronDown className="h-3 w-3" />
                                : <ChevronRight className="h-3 w-3" />}
                            </td>
                            {orderedColumns.map(col => renderItemCell(col, item))}
                          </tr>

                          {/* SKU detail panel */}
                          {isSkuExpanded && (
                            <tr className="bg-muted/10">
                              <td colSpan={COL_COUNT} className="px-6 py-4">
                                <div className="grid grid-cols-3 gap-6">

                                  {/* Product info + sales history */}
                                  <div className="space-y-3">
                                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                                      <Info className="h-3.5 w-3.5 text-primary" />
                                      產品詳情
                                    </h4>
                                    <div className="space-y-1 text-xs">
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">SKU</span>
                                        <span className="font-mono">{item.sku}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">品牌</span>
                                        <span>{item.vendor}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">分類</span>
                                        <span>{item.product_type}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">現存量</span>
                                        <span className="tabular-nums">{item.inventory_quantity}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">比較價</span>
                                        <span className="tabular-nums">{item.compare_at_price != null ? formatCurrency(item.compare_at_price) : '—'}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">零售價</span>
                                        <span className="tabular-nums">{formatCurrency(item.price)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">單位成本</span>
                                        <span className="tabular-nums">{formatCurrency(item.unit_cost)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">庫存成本</span>
                                        <span className="tabular-nums font-medium">{formatCurrency(item.stock_cost)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">利潤%</span>
                                        <span className={`tabular-nums font-medium ${
                                          computeMargin(item.price, item.unit_cost) != null
                                            ? marginColorClass(computeMargin(item.price, item.unit_cost)!)
                                            : 'text-muted-foreground'
                                        }`}>
                                          {computeMargin(item.price, item.unit_cost) != null
                                            ? `${computeMargin(item.price, item.unit_cost)!.toFixed(1)}%`
                                            : '—'}
                                        </span>
                                      </div>
                                    </div>

                                    <h4 className="text-xs font-semibold flex items-center gap-1.5 mt-2">
                                      <TrendingDown className="h-3.5 w-3.5 text-amber-400" />
                                      銷售記錄
                                    </h4>
                                    <div className="space-y-1 text-xs">
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">首次售出</span>
                                        <span className="tabular-nums">{item.first_sold_date ?? '—'}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">最後售出</span>
                                        <span className="tabular-nums">{item.last_sold_date ?? '從未'}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">距今天數</span>
                                        <span className="tabular-nums font-medium">
                                          {item.days_since_last_sale >= 9000 ? '∞ (從未售出)' : `${item.days_since_last_sale} 天`}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">近30日銷量</span>
                                        <span className="tabular-nums">{item.sold_30d}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">近90日銷量</span>
                                        <span className="tabular-nums">{item.sold_90d}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Manual review form */}
                                  <div className="space-y-3">
                                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                                      <Edit3 className="h-3.5 w-3.5 text-primary" />
                                      人手覆核
                                    </h4>

                                    <div className="space-y-2.5">
                                      <div>
                                        <label className="block text-[10px] text-muted-foreground mb-1">人手狀態</label>
                                        <select
                                          value={formState.manual_status ?? ''}
                                          onChange={e => setFormState(f => ({ ...f, manual_status: e.target.value }))}
                                          className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                        >
                                          <option value="">— 未設定 —</option>
                                          {MANUAL_STATUS_OPTIONS.map(s => (
                                            <option key={s} value={s}>{MANUAL_STATUS_LABELS[s]}</option>
                                          ))}
                                        </select>
                                      </div>

                                      <div>
                                        <label className="block text-[10px] text-muted-foreground mb-1">處理動作</label>
                                        <select
                                          value={formState.action ?? ''}
                                          onChange={e => setFormState(f => ({ ...f, action: e.target.value }))}
                                          className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                        >
                                          <option value="">— 未設定 —</option>
                                          {ACTION_OPTIONS.map(a => (
                                            <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                                          ))}
                                        </select>
                                      </div>

                                      <div>
                                        <label className="block text-[10px] text-muted-foreground mb-1">原因備註</label>
                                        <textarea
                                          value={formState.notes ?? ''}
                                          onChange={e => setFormState(f => ({ ...f, notes: e.target.value }))}
                                          rows={2}
                                          className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                                          placeholder="輸入備註..."
                                        />
                                      </div>

                                      <div className="grid grid-cols-2 gap-2">
                                        <div>
                                          <label className="block text-[10px] text-muted-foreground mb-1">覆核人</label>
                                          <input
                                            type="text"
                                            value={formState.reviewer ?? ''}
                                            onChange={e => setFormState(f => ({ ...f, reviewer: e.target.value }))}
                                            className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                            placeholder="姓名..."
                                          />
                                        </div>
                                        <div>
                                          <label className="block text-[10px] text-muted-foreground mb-1">下次覆核日期</label>
                                          <input
                                            type="date"
                                            value={formState.next_review_date ?? ''}
                                            onChange={e => setFormState(f => ({ ...f, next_review_date: e.target.value }))}
                                            className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                          />
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-2">
                                        <input
                                          type="checkbox"
                                          id={`revived-${item.sku}`}
                                          checked={formState.revived ?? false}
                                          onChange={e => setFormState(f => ({ ...f, revived: e.target.checked }))}
                                          className="h-3.5 w-3.5 rounded"
                                        />
                                        <label htmlFor={`revived-${item.sku}`} className="text-xs cursor-pointer">
                                          已翻生 (Revived)
                                        </label>
                                      </div>

                                      <div className="flex items-center gap-2 pt-1">
                                        <button
                                          onClick={() => handleSave(item.sku)}
                                          disabled={saving}
                                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                                        >
                                          <Save className="h-3.5 w-3.5" />
                                          {saving ? '儲存中...' : '儲存'}
                                        </button>
                                        {saveSuccess && (
                                          <span className="flex items-center gap-1 text-xs text-green-400">
                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                            已儲存
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Audit log */}
                                  <div className="space-y-3">
                                    <h4 className="text-xs font-semibold flex items-center gap-1.5">
                                      <Eye className="h-3.5 w-3.5 text-primary" />
                                      變更記錄
                                    </h4>
                                    {skuAuditLog.length === 0 ? (
                                      <p className="text-[10px] text-muted-foreground italic">暫無變更記錄</p>
                                    ) : (
                                      <div className="space-y-2 max-h-52 overflow-y-auto">
                                        {skuAuditLog.map((log, idx) => (
                                          <div key={idx} className="text-[10px] border border-border/40 rounded p-1.5 bg-background/60 space-y-0.5">
                                            <div className="flex items-center justify-between">
                                              <span className="font-medium text-foreground">{log.field_name}</span>
                                              <span className="text-muted-foreground tabular-nums">{log.changed_at?.slice(0, 16).replace('T', ' ')}</span>
                                            </div>
                                            <div className="flex items-center gap-1.5 text-muted-foreground">
                                              <span className="line-through">{log.old_value || '—'}</span>
                                              <span className="text-primary">→</span>
                                              <span className="text-foreground">{log.new_value || '—'}</span>
                                            </div>
                                            {log.changed_by && (
                                              <div className="text-muted-foreground">by {log.changed_by}</div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>

                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
