/**
 * Dead Stock / Aging Inventory Management Page
 * 死貨 / 老化庫存管理
 *
 * All computation is client-side using useMemo for 4000+ SKU efficiency.
 * Data sources: shopify_inventory, bc_inventory, shopify_order_lines,
 *               shopify_orders, dead_stock_reviews, dead_stock_audit_log
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { queryAllPages } from '@/lib/query-helpers';
import { formatCurrency, formatNumber } from '@/lib/format';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Package, AlertTriangle, Search, Filter, ChevronDown, ChevronUp,
  Calendar, Edit3, Save, X, RotateCcw, TrendingDown, Archive,
  Eye, Clock, CheckCircle2, XCircle, Info,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface ShopifyInventoryRow {
  sku: string;
  product_title: string;
  vendor: string;
  product_type: string;
  inventory_quantity: number;
  price: number;
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
  vendor: string;
  product_type: string;
  inventory_quantity: number;
  price: number;
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
  priority: string | null;
  action: string | null;
  notes: string | null;
  reviewer: string | null;
  last_review_date: string | null;
  next_review_date: string | null;
  revived: boolean;
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

const PRIORITY_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
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

const SYSTEM_STATUS_OPTIONS: SystemStatus[] = ['慢移貨', '高風險死貨', '真正死貨'];

const MANUAL_STATUS_OPTIONS = Object.keys(MANUAL_STATUS_LABELS);
const PRIORITY_OPTIONS = Object.keys(PRIORITY_LABELS);
const ACTION_OPTIONS = Object.keys(ACTION_LABELS);

// ── Badge helpers ─────────────────────────────────────────────────────────────

function systemStatusBadge(status: SystemStatus) {
  const map: Record<SystemStatus, string> = {
    '正常': 'bg-green-500/15 text-green-400 border-green-500/30',
    '慢移貨': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    '高風險死貨': 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    '真正死貨': 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${map[status]}`}>
      {status}
    </span>
  );
}

function manualStatusBadge(status: string | null) {
  if (!status) return <span className="text-muted-foreground text-[10px]">—</span>;
  const colorMap: Record<string, string> = {
    pending_review: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    observing: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    confirmed_dead: 'bg-red-500/15 text-red-400 border-red-500/30',
    revived: 'bg-green-500/15 text-green-400 border-green-500/30',
    promoting: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    cleared: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
    keep: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
  };
  const cls = colorMap[status] ?? 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {MANUAL_STATUS_LABELS[status] ?? status}
    </span>
  );
}

function priorityBadge(p: string | null) {
  if (!p) return null;
  const colorMap: Record<string, string> = {
    high: 'bg-red-500/15 text-red-400 border-red-500/30',
    medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    low: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  };
  const cls = colorMap[p] ?? 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {PRIORITY_LABELS[p] ?? p}
    </span>
  );
}

// ── Filter State ──────────────────────────────────────────────────────────────

interface FilterState {
  search: string;
  vendors: string[];
  product_types: string[];
  system_statuses: SystemStatus[];
  manual_statuses: string[];
  priorities: string[];
  actions: string[];
  reviewers: string[];
  revived: '' | 'true' | 'false';
  days_min: string;
  days_max: string;
  qty_min: string;
  qty_max: string;
  cost_min: string;
  cost_max: string;
}

const DEFAULT_FILTERS: FilterState = {
  search: '',
  vendors: [],
  product_types: [],
  system_statuses: [],
  manual_statuses: [],
  priorities: [],
  actions: [],
  reviewers: [],
  revived: '',
  days_min: '',
  days_max: '',
  qty_min: '',
  qty_max: '',
  cost_min: '',
  cost_max: '',
};

type SortKey = 'stock_cost' | 'inventory_quantity' | 'days_since_last_sale' | 'sold_90d' | 'system_status';
type SortDir = 'asc' | 'desc';

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
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('stock_cost');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  // form state for expanded row
  const [formState, setFormState] = useState<Partial<DeadStockReview>>({});
  const [formOriginal, setFormOriginal] = useState<Partial<DeadStockReview>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Batch selection state
  const [selectedSkus, setSelectedSkus] = useState<Set<string>>(new Set());
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchField, setBatchField] = useState<'system_status' | 'manual_status' | 'priority' | 'action'>('manual_status');
  const [batchValue, setBatchValue] = useState('');

  // ── Data Loading ────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invRows, bcRows, linesRows, ordersRows, reviewsResult, auditResult] = await Promise.all([
        queryAllPages('shopify_inventory', 'sku,product_title,vendor,product_type,inventory_quantity,price', [
          { column: 'inventory_quantity', op: 'gte', value: '1' },
        ]),
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

    // Build lookup maps
    const bcMap = new Map<string, BcInventoryRow>();
    for (const b of bcInv) bcMap.set(b.number, b);

    const reviewMap = new Map<string, DeadStockReview>();
    for (const r of reviews) reviewMap.set(r.sku, r);

    // Build order date lookup: orderId -> { created_at, cancelled }
    const orderMap = new Map<string, { created_at: string; cancelled: boolean }>();
    for (const o of orders) {
      orderMap.set(o.id, { created_at: o.created_at, cancelled: !!o.cancelled_at });
    }

    // Pre-compute per-SKU order stats
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
      if (daysSince >= 270 && inv.inventory_quantity >= 3) system_status = '真正死貨';
      else if (daysSince >= 180) system_status = '高風險死貨';
      else if (daysSince >= 90) system_status = '慢移貨';
      else system_status = '正常';

      const rev = reviewMap.get(inv.sku);

      // Apply system_status_override from review if present
      const VALID_SYSTEM_STATUSES: SystemStatus[] = ['正常', '慢移貨', '高風險死貨', '真正死貨'];
      if (rev?.system_status_override && VALID_SYSTEM_STATUSES.includes(rev.system_status_override as SystemStatus)) {
        system_status = rev.system_status_override as SystemStatus;
      }

      result.push({
        sku: inv.sku,
        product_title: inv.product_title,
        vendor: inv.vendor,
        product_type: inv.product_type,
        inventory_quantity: inv.inventory_quantity,
        price: inv.price ?? 0,
        unit_cost: unitCost,
        stock_cost: stockCost,
        last_sold_date: lastSoldDate,
        first_sold_date: firstSoldDate,
        sold_30d: stats?.sold30 ?? 0,
        sold_90d: stats?.sold90 ?? 0,
        days_since_last_sale: daysSince,
        system_status,
        manual_status: rev?.manual_status ?? null,
        priority: rev?.priority ?? null,
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

    // Brand distribution (top 5 by cost)
    const brandCost = new Map<string, number>();
    for (const i of nonNormal) {
      brandCost.set(i.vendor, (brandCost.get(i.vendor) ?? 0) + i.stock_cost);
    }
    const topBrands = Array.from(brandCost.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // Aging intervals
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
    const reviewerSet = Array.from(new Set(reviews.map(r => r.reviewer).filter(Boolean) as string[])).sort();
    return { vendors, product_types, reviewers: reviewerSet };
  }, [computedItems, reviews]);

  // ── Filtered + sorted items ─────────────────────────────────────────────────

  const filteredItems = useMemo<DeadStockItem[]>(() => {
    let items = computedItems;

    // Default: hide normal
    const hasStatusFilter = filters.system_statuses.length > 0;
    if (!hasStatusFilter) {
      items = items.filter(i => i.system_status !== '正常');
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
    if (filters.priorities.length) items = items.filter(i => filters.priorities.includes(i.priority ?? ''));
    if (filters.actions.length) items = items.filter(i => filters.actions.includes(i.action ?? ''));
    if (filters.reviewers.length) items = items.filter(i => filters.reviewers.includes(i.reviewer ?? ''));
    if (filters.revived === 'true') items = items.filter(i => i.revived);
    if (filters.revived === 'false') items = items.filter(i => !i.revived);

    if (filters.days_min) items = items.filter(i => i.days_since_last_sale >= Number(filters.days_min));
    if (filters.days_max) items = items.filter(i => i.days_since_last_sale <= Number(filters.days_max));
    if (filters.qty_min) items = items.filter(i => i.inventory_quantity >= Number(filters.qty_min));
    if (filters.qty_max) items = items.filter(i => i.inventory_quantity <= Number(filters.qty_max));
    if (filters.cost_min) items = items.filter(i => i.stock_cost >= Number(filters.cost_min));
    if (filters.cost_max) items = items.filter(i => i.stock_cost <= Number(filters.cost_max));

    // Sort
    const STATUS_ORDER: Record<string, number> = { '正常': 0, '慢移貨': 1, '高風險死貨': 2, '真正死貨': 3 };
    items = [...items].sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'system_status') {
        return ((STATUS_ORDER[a.system_status] ?? 0) - (STATUS_ORDER[b.system_status] ?? 0)) * mul;
      }
      return (a[sortKey] - b[sortKey]) * mul;
    });

    return items;
  }, [computedItems, filters, sortKey, sortDir]);

  // ── Sort handler ────────────────────────────────────────────────────────────

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  // ── Row expand ──────────────────────────────────────────────────────────────

  const handleRowClick = (sku: string, item: DeadStockItem) => {
    if (expandedSku === sku) {
      setExpandedSku(null);
    } else {
      setExpandedSku(sku);
      const form: Partial<DeadStockReview> = {
        sku,
        manual_status: item.manual_status ?? '',
        priority: item.priority ?? '',
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
        priority: formState.priority || null,
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

      // audit log — record changed fields
      const changedBy = formState.reviewer || 'unknown';
      const auditRows: Omit<AuditLogRow, 'id'>[] = [];
      const fields: (keyof typeof payload)[] = ['manual_status', 'priority', 'action', 'notes', 'next_review_date', 'revived'];
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

      // Refresh reviews + audit log
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
    setFilters(f => {
      const base = { ...DEFAULT_FILTERS };
      switch (preset) {
        case 'all_dead': return { ...base };
        case 'truly_dead': return { ...base, system_statuses: ['真正死貨'] };
        case 'high_risk': return { ...base, system_statuses: ['高風險死貨'] };
        case 'high_stock_180': return { ...base, days_min: '180', qty_min: '5' };
        case 'revived': return { ...base, revived: 'true' };
        case 'pending': return { ...base, manual_statuses: ['pending_review', ''] };
        case 'high_priority': return { ...base, priorities: ['high'] };
        case 'promotable': return { ...base, actions: ['discount', 'bundle', 'store_promo', 'online_sale'] };
        default: return f;
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
    fieldName: 'system_status_override' | 'manual_status' | 'priority' | 'action',
    newValue: string,
    oldValue: string | null,
  ) => {
    const dbField = fieldName === 'system_status_override' ? 'system_status_override' : fieldName;
    const auditField = fieldName === 'system_status_override' ? 'system_status' : fieldName;

    // Upsert review
    await supabase.from('dead_stock_reviews').upsert({
      sku,
      [dbField]: newValue || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sku' });

    // Audit log
    await supabase.from('dead_stock_audit_log').insert({
      sku,
      field_name: auditField,
      old_value: oldValue || null,
      new_value: newValue || null,
      changed_by: 'user',
      changed_at: new Date().toISOString(),
    });

    // Refresh local state
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
    if (selectedSkus.size === filteredItems.length) {
      setSelectedSkus(new Set());
    } else {
      setSelectedSkus(new Set(filteredItems.map(i => i.sku)));
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
      const auditFieldName = batchField;

      // Upsert each SKU
      for (const sku of skus) {
        const item = filteredItems.find(i => i.sku === sku);
        const oldVal = batchField === 'system_status'
          ? item?.system_status ?? null
          : (item as any)?.[batchField] ?? null;

        await supabase.from('dead_stock_reviews').upsert({
          sku,
          [dbField]: batchValue || null,
          updated_at: now,
        }, { onConflict: 'sku' });

        await supabase.from('dead_stock_audit_log').insert({
          sku,
          field_name: auditFieldName,
          old_value: String(oldVal ?? ''),
          new_value: batchValue,
          changed_by: 'batch',
          changed_at: now,
        });
      }

      // Refresh
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

  // ── Batch field options helper ─────────────────────────────────────────────

  const BATCH_FIELD_OPTIONS: Record<string, { label: string; options: { value: string; label: string }[] }> = {
    system_status: {
      label: '系統狀態',
      options: [
        { value: '正常', label: '正常' },
        { value: '慢移貨', label: '慢移貨' },
        { value: '高風險死貨', label: '高風險死貨' },
        { value: '真正死貨', label: '真正死貨' },
      ],
    },
    manual_status: {
      label: '人手狀態',
      options: MANUAL_STATUS_OPTIONS.map(k => ({ value: k, label: MANUAL_STATUS_LABELS[k] })),
    },
    priority: {
      label: '優先級',
      options: PRIORITY_OPTIONS.map(k => ({ value: k, label: PRIORITY_LABELS[k] })),
    },
    action: {
      label: '動作',
      options: ACTION_OPTIONS.map(k => ({ value: k, label: ACTION_LABELS[k] })),
    },
  };

  // ── Multi-select helper ─────────────────────────────────────────────────────

  function toggleMultiSelect<T extends string>(arr: T[], val: T): T[] {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val];
  }

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
        {/* SKU count */}
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

        {/* Total cost */}
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

        {/* Top brands */}
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

        {/* Aging intervals */}
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

      {/* ── Quick Preset Buttons ── */}
      <div className="flex flex-wrap gap-1.5">
        {[
          { key: 'all_dead', label: '全部死貨/慢移貨' },
          { key: 'truly_dead', label: '真正死貨' },
          { key: 'high_risk', label: '高風險死貨' },
          { key: 'high_stock_180', label: '180日+ 高庫存' },
          { key: 'revived', label: '已翻生' },
          { key: 'pending', label: '待確認/未覆核' },
          { key: 'high_priority', label: '高優先級' },
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

      {/* ── Filter Panel ── */}
      <div className="border border-border/50 rounded-lg overflow-hidden">
        <button
          onClick={() => setFilterOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Filter className="h-3.5 w-3.5" />
            篩選 Filters
            {filteredItems.length !== computedItems.filter(i => i.system_status !== '正常').length && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary/15 text-primary border border-primary/30">
                {filteredItems.length} 筆
              </span>
            )}
          </div>
          {filterOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {filterOpen && (
          <div className="p-4 space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="搜尋 SKU / 產品名稱..."
                value={filters.search}
                onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
                className="w-full pl-8 pr-3 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* Brand */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">品牌</label>
                <div className="max-h-28 overflow-y-auto space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {filterOptions.vendors.map(v => (
                    <label key={v} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.vendors.includes(v)}
                        onChange={() => setFilters(f => ({ ...f, vendors: toggleMultiSelect(f.vendors, v) }))}
                        className="h-3 w-3 rounded"
                      />
                      <span className="truncate">{v}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Category */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">分類</label>
                <div className="max-h-28 overflow-y-auto space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {filterOptions.product_types.map(t => (
                    <label key={t} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.product_types.includes(t)}
                        onChange={() => setFilters(f => ({ ...f, product_types: toggleMultiSelect(f.product_types, t) }))}
                        className="h-3 w-3 rounded"
                      />
                      <span className="truncate">{t}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* System status */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">系統狀態</label>
                <div className="space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {SYSTEM_STATUS_OPTIONS.map(s => (
                    <label key={s} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.system_statuses.includes(s)}
                        onChange={() => setFilters(f => ({ ...f, system_statuses: toggleMultiSelect(f.system_statuses, s) }))}
                        className="h-3 w-3 rounded"
                      />
                      {s}
                    </label>
                  ))}
                </div>
              </div>

              {/* Manual status */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">人手狀態</label>
                <div className="max-h-28 overflow-y-auto space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {MANUAL_STATUS_OPTIONS.map(s => (
                    <label key={s} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.manual_statuses.includes(s)}
                        onChange={() => setFilters(f => ({ ...f, manual_statuses: toggleMultiSelect(f.manual_statuses, s) }))}
                        className="h-3 w-3 rounded"
                      />
                      {MANUAL_STATUS_LABELS[s]}
                    </label>
                  ))}
                </div>
              </div>

              {/* Priority */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">處理優先級</label>
                <div className="space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {PRIORITY_OPTIONS.map(p => (
                    <label key={p} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.priorities.includes(p)}
                        onChange={() => setFilters(f => ({ ...f, priorities: toggleMultiSelect(f.priorities, p) }))}
                        className="h-3 w-3 rounded"
                      />
                      {PRIORITY_LABELS[p]}
                    </label>
                  ))}
                </div>
              </div>

              {/* Action */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">處理動作</label>
                <div className="max-h-28 overflow-y-auto space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {ACTION_OPTIONS.map(a => (
                    <label key={a} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.actions.includes(a)}
                        onChange={() => setFilters(f => ({ ...f, actions: toggleMultiSelect(f.actions, a) }))}
                        className="h-3 w-3 rounded"
                      />
                      {ACTION_LABELS[a]}
                    </label>
                  ))}
                </div>
              </div>

              {/* Reviewer */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">覆核人</label>
                <div className="max-h-28 overflow-y-auto space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {filterOptions.reviewers.map(r => (
                    <label key={r} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={filters.reviewers.includes(r)}
                        onChange={() => setFilters(f => ({ ...f, reviewers: toggleMultiSelect(f.reviewers, r) }))}
                        className="h-3 w-3 rounded"
                      />
                      {r}
                    </label>
                  ))}
                  {filterOptions.reviewers.length === 0 && (
                    <span className="text-[10px] text-muted-foreground">暫無覆核人</span>
                  )}
                </div>
              </div>

              {/* Revived */}
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">已翻生</label>
                <div className="space-y-0.5 border border-border rounded-md p-1.5 bg-background">
                  {[{ val: '', label: '全部' }, { val: 'true', label: '是' }, { val: 'false', label: '否' }].map(opt => (
                    <label key={opt.val} className="flex items-center gap-1.5 text-xs cursor-pointer hover:text-foreground text-muted-foreground">
                      <input
                        type="radio"
                        name="revived"
                        value={opt.val}
                        checked={filters.revived === opt.val}
                        onChange={() => setFilters(f => ({ ...f, revived: opt.val as '' | 'true' | 'false' }))}
                        className="h-3 w-3"
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Range filters */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">庫存天數 (距今天數)</label>
                <div className="flex items-center gap-2">
                  <input type="number" placeholder="最少" value={filters.days_min} onChange={e => setFilters(f => ({ ...f, days_min: e.target.value }))}
                    className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                  <span className="text-muted-foreground text-xs">–</span>
                  <input type="number" placeholder="最多" value={filters.days_max} onChange={e => setFilters(f => ({ ...f, days_max: e.target.value }))}
                    className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">現存量</label>
                <div className="flex items-center gap-2">
                  <input type="number" placeholder="最少" value={filters.qty_min} onChange={e => setFilters(f => ({ ...f, qty_min: e.target.value }))}
                    className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                  <span className="text-muted-foreground text-xs">–</span>
                  <input type="number" placeholder="最多" value={filters.qty_max} onChange={e => setFilters(f => ({ ...f, qty_max: e.target.value }))}
                    className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1">庫存成本 (HK$)</label>
                <div className="flex items-center gap-2">
                  <input type="number" placeholder="最少" value={filters.cost_min} onChange={e => setFilters(f => ({ ...f, cost_min: e.target.value }))}
                    className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                  <span className="text-muted-foreground text-xs">–</span>
                  <input type="number" placeholder="最多" value={filters.cost_max} onChange={e => setFilters(f => ({ ...f, cost_max: e.target.value }))}
                    className="flex-1 px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Table ── */}
      <div className="border border-border/50 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b border-border/50">
          <span className="text-xs text-muted-foreground">
            顯示 <span className="font-medium text-foreground">{filteredItems.length}</span> 個 SKU
          </span>
          {filteredItems.length > 0 && (
            <span className="text-xs text-muted-foreground">
              庫存成本合計: <span className="font-medium text-foreground">
                {formatCurrency(filteredItems.reduce((s, i) => s + i.stock_cost, 0))}
              </span>
            </span>
          )}
        </div>

        {/* Batch toolbar */}
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
              <option value="priority">優先級</option>
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

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 border-b border-border/50">
              <tr>
                <th className="px-2 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={filteredItems.length > 0 && selectedSkus.size === filteredItems.length}
                    onChange={toggleSelectAll}
                    className="h-3.5 w-3.5 rounded cursor-pointer"
                    title="全選 / 取消全選"
                  />
                </th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground w-8"></th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">SKU</th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground max-w-[180px]">產品名稱</th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">品牌</th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">分類</th>
                <th
                  className="text-right px-2 py-2 text-[10px] font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => handleSort('inventory_quantity')}
                >
                  現存量 <SortIcon col="inventory_quantity" />
                </th>
                <th
                  className="text-right px-2 py-2 text-[10px] font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => handleSort('stock_cost')}
                >
                  庫存成本 <SortIcon col="stock_cost" />
                </th>
                <th className="text-right px-2 py-2 text-[10px] font-medium text-muted-foreground">零售價</th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">最後售出</th>
                <th
                  className="text-right px-2 py-2 text-[10px] font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => handleSort('days_since_last_sale')}
                >
                  距今天數 <SortIcon col="days_since_last_sale" />
                </th>
                <th
                  className="text-right px-2 py-2 text-[10px] font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => handleSort('sold_90d')}
                >
                  近90日銷 <SortIcon col="sold_90d" />
                </th>
                <th
                  className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                  onClick={() => handleSort('system_status')}
                >
                  系統狀態 <SortIcon col="system_status" />
                </th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">人手狀態</th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">優先級</th>
                <th className="text-left px-2 py-2 text-[10px] font-medium text-muted-foreground">動作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={16} className="text-center py-8 text-sm text-muted-foreground">
                    <Package className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    無符合條件的死貨 / 老化庫存
                  </td>
                </tr>
              )}
              {filteredItems.map(item => {
                const isExpanded = expandedSku === item.sku;
                return (
                  <>
                    <tr
                      key={item.sku}
                      onClick={() => handleRowClick(item.sku, item)}
                      className={`cursor-pointer transition-colors ${
                        isExpanded
                          ? 'bg-primary/5 border-l-2 border-l-primary'
                          : selectedSkus.has(item.sku)
                          ? 'bg-primary/5'
                          : 'hover:bg-muted/30'
                      }`}
                    >
                      <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedSkus.has(item.sku)}
                          onChange={() => toggleSelect(item.sku)}
                          className="h-3.5 w-3.5 rounded cursor-pointer"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{item.sku}</td>
                      <td className="px-2 py-1.5 max-w-[180px]">
                        <span className="truncate block" title={item.product_title}>
                          {item.product_title?.slice(0, 35)}{item.product_title?.length > 35 ? '…' : ''}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">{item.vendor}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{item.product_type}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(item.inventory_quantity)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium">{formatCurrency(item.stock_cost)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatCurrency(item.price)}</td>
                      <td className="px-2 py-1.5 text-muted-foreground tabular-nums">
                        {item.last_sold_date ?? <span className="italic text-red-400/70">從未售出</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        <span className={item.days_since_last_sale >= 270 ? 'text-red-400 font-medium' : item.days_since_last_sale >= 180 ? 'text-orange-400' : 'text-amber-400'}>
                          {item.days_since_last_sale >= 9000 ? '∞' : item.days_since_last_sale}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{item.sold_90d}</td>
                      <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                        <select
                          value={item.system_status}
                          onChange={async (e) => {
                            const newVal = e.target.value as SystemStatus;
                            const oldVal = item.system_status;
                            if (newVal === oldVal) return;
                            await handleInlineUpdate(item.sku, 'system_status_override', newVal, oldVal);
                          }}
                          className={`text-[10px] font-medium rounded border px-1.5 py-0.5 cursor-pointer bg-transparent ${
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
                      </td>
                      <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                        <select
                          value={item.manual_status ?? ''}
                          onChange={async (e) => {
                            const newVal = e.target.value;
                            if (newVal === (item.manual_status ?? '')) return;
                            await handleInlineUpdate(item.sku, 'manual_status', newVal, item.manual_status);
                          }}
                          className={`text-[10px] font-medium rounded border px-1.5 py-0.5 cursor-pointer bg-transparent ${
                            !item.manual_status ? 'text-muted-foreground border-border/30' :
                            item.manual_status === 'confirmed_dead' ? 'text-red-400 border-red-500/30' :
                            item.manual_status === 'revived' ? 'text-green-400 border-green-500/30' :
                            item.manual_status === 'promoting' ? 'text-purple-400 border-purple-500/30' :
                            item.manual_status === 'pending_review' ? 'text-yellow-400 border-yellow-500/30' :
                            item.manual_status === 'observing' ? 'text-blue-400 border-blue-500/30' :
                            item.manual_status === 'cleared' ? 'text-gray-400 border-gray-500/30' :
                            item.manual_status === 'keep' ? 'text-teal-400 border-teal-500/30' :
                            'text-muted-foreground border-border/30'
                          }`}
                        >
                          <option value="">—</option>
                          {MANUAL_STATUS_OPTIONS.map(s => (
                            <option key={s} value={s}>{MANUAL_STATUS_LABELS[s]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                        <select
                          value={item.priority ?? ''}
                          onChange={async (e) => {
                            const newVal = e.target.value;
                            if (newVal === (item.priority ?? '')) return;
                            await handleInlineUpdate(item.sku, 'priority', newVal, item.priority);
                          }}
                          className={`text-[10px] font-medium rounded border px-1.5 py-0.5 cursor-pointer bg-transparent ${
                            !item.priority ? 'text-muted-foreground border-border/30' :
                            item.priority === 'high' ? 'text-red-400 border-red-500/30' :
                            item.priority === 'medium' ? 'text-amber-400 border-amber-500/30' :
                            'text-gray-400 border-gray-500/30'
                          }`}
                        >
                          <option value="">—</option>
                          {PRIORITY_OPTIONS.map(p => (
                            <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                        <select
                          value={item.action ?? ''}
                          onChange={async (e) => {
                            const newVal = e.target.value;
                            if (newVal === (item.action ?? '')) return;
                            await handleInlineUpdate(item.sku, 'action', newVal, item.action);
                          }}
                          className="text-[10px] font-medium rounded border px-1.5 py-0.5 cursor-pointer bg-transparent text-muted-foreground border-border/30"
                        >
                          <option value="">—</option>
                          {ACTION_OPTIONS.map(a => (
                            <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                          ))}
                        </select>
                      </td>
                    </tr>

                    {/* Expanded detail row */}
                    {isExpanded && (
                      <tr key={`${item.sku}-detail`} className="bg-muted/10">
                        <td colSpan={16} className="px-4 py-4">
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
                                  <span className="text-muted-foreground">單位成本</span>
                                  <span className="tabular-nums">{formatCurrency(item.unit_cost)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">庫存成本</span>
                                  <span className="tabular-nums font-medium">{formatCurrency(item.stock_cost)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">零售價</span>
                                  <span className="tabular-nums">{formatCurrency(item.price)}</span>
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
                                  <label className="block text-[10px] text-muted-foreground mb-1">處理優先級</label>
                                  <select
                                    value={formState.priority ?? ''}
                                    onChange={e => setFormState(f => ({ ...f, priority: e.target.value }))}
                                    className="w-full px-2 py-1.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                  >
                                    <option value="">— 未設定 —</option>
                                    {PRIORITY_OPTIONS.map(p => (
                                      <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
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
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
