/**
 * Foorir Foot Traffic API Client
 * Platform: vf.foorir.com — Smart Retail Cloud Management
 * Auth: CAPTCHA + RSA-encrypted password
 * CORS: ✅ Allowed for helmet-king-dashboard.vercel.app
 */
import JSEncrypt from 'jsencrypt';

const BASE = 'https://vf.foorir.com/hx-api';
const USERNAME = 'HMK';
const PASSWORD = '12345678';

// Supabase Edge Function proxy for server-side token caching
const SUPABASE_URL = 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
const RSA_PUBLIC_KEY =
  'MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBANL378k3RiZHWx5AfJqdH9xRNBmD9wGD' +
  '\n2iRe41HdTNF8RUhNnHit5NpMNtGL0NPTSSpPjjI1kJfVorRvaQerUgkCAwEAAQ==';

// timeType values for /home/keliukpi endpoint
// Note: "day" = yesterday data; there is no "today" option on this endpoint
export const FOORIR_PERIODS = {
  yesterday:  'day',
  this_week:  'week',
  this_month: 'month',
  this_year:  'year',
} as const;

export type FoorirPeriod = keyof typeof FOORIR_PERIODS;

// Metric type → API `type` param mapping
const METRIC_TYPES = {
  flowIn:     'in',
  flowPassby: 'pass',
  batch:      'inBatch',
  adult:      'adult',
  children:   'children',
} as const;

export interface FoorirKPI {
  flowIn: number;
  flowOut: number;
  flowPassby: number;
  batch: number;
  adult: number;
  children: number;
  averageDwellTime: number;
  totalDwellTime: number;
  flowTurnback: number;
  customerIn: number;
  enterStaff: number;
  leaveStaff: number;
  // Period-over-period ratios from API (percentage strings like "9.68%")
  ratios?: {
    flowIn?:     { chainRelativeRatio: string; yearOnYearGrowth: string };
    flowPassby?: { chainRelativeRatio: string; yearOnYearGrowth: string };
    batch?:      { chainRelativeRatio: string; yearOnYearGrowth: string };
    adult?:      { chainRelativeRatio: string; yearOnYearGrowth: string };
    children?:   { chainRelativeRatio: string; yearOnYearGrowth: string };
  };
}

export interface FoorirKPIRow {
  label: string;
  value: number;
  chainIndex: number; // WoW or period-over-period %
  yoy: number;        // YoY %
}

// ── Token management (localStorage for cross-session persistence) ─────
let _token: string | null = null;

export function getFoorirToken(): string | null {
  if (_token) return _token;
  try { return localStorage.getItem('foorir_token'); } catch { return null; }
}

function setFoorirToken(t: string) {
  _token = t;
  try { localStorage.setItem('foorir_token', t); } catch {}
}

export function clearFoorirToken() {
  _token = null;
  try { localStorage.removeItem('foorir_token'); } catch {}
}

/** Try to get a cached token from server (Supabase Edge Function) */
export async function getCachedServerToken(): Promise<string | null> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/foorir-proxy`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'x-foorir-action': 'get-cached-token',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.token) {
      setFoorirToken(data.token);
      return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

/** Save token to server for cross-session persistence */
async function saveTokenToServer(token: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/foorir-proxy`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'x-foorir-action': 'save-token',
      },
      body: JSON.stringify({ token }),
    });
  } catch { /* best effort */ }
}

function authHeaders(): Record<string, string> {
  const t = getFoorirToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ── RSA encrypt ──────────────────────────────────────────────
function encryptPassword(): string {
  const enc = new JSEncrypt();
  enc.setPublicKey(RSA_PUBLIC_KEY);
  return enc.encrypt(PASSWORD) || '';
}

// ── API calls ────────────────────────────────────────────────

/** Get CAPTCHA image (base64) + UUID key */
export async function getCaptcha(): Promise<{ uuid: string; img: string }> {
  const resp = await fetch(`${BASE}/auth/code`);
  const data = await resp.json();
  return { uuid: data.uuid || '', img: data.img || '' };
}

/** Login with CAPTCHA code. Returns true on success. */
export async function loginFoorir(code: string, uuid: string): Promise<{ ok: boolean; message: string }> {
  const encPw = encryptPassword();
  if (!encPw) return { ok: false, message: 'RSA encryption failed' };

  const resp = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: encPw, code, uuid }),
  });
  const data = await resp.json();

  if (data.token) {
    // Token from API may include "Bearer " prefix — strip it for storage
    const raw = data.token.replace(/^Bearer\s+/i, '');
    setFoorirToken(raw);
    // Also cache server-side for cross-session persistence
    saveTokenToServer(raw);
    return { ok: true, message: 'Login successful' };
  }
  return { ok: false, message: data.message || 'Login failed' };
}

/** Get entity info (needed for some queries) */
export async function getEntityInfo(): Promise<any> {
  const resp = await fetch(`${BASE}/auth/info`, { headers: authHeaders() });
  return resp.json();
}

/** Format current datetime as YYYY-MM-DD HH:mm:ss for the startTime param */
function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Fetch a single metric from /home/keliukpi */
async function fetchKeliuMetric(
  metricType: string,
  timeType: string,
): Promise<{ value: number; chainRelativeRatio: string; yearOnYearGrowth: string } | null> {
  const params = new URLSearchParams({
    type: metricType,
    timeType,
    startTime: nowTimestamp(),
  });
  const resp = await fetch(`${BASE}/home/keliukpi?${params}`, { headers: authHeaders() });
  if (!resp.ok) {
    if (resp.status === 401) clearFoorirToken();
    return null;
  }
  const json = await resp.json();
  // Response: { data: { [timeType]: { value, chainRelativeRatio, yearOnYearGrowth } } }
  const bucket = json?.data?.[timeType];
  if (!bucket) return null;
  return {
    value: Number(bucket.value) || 0,
    chainRelativeRatio: bucket.chainRelativeRatio || '',
    yearOnYearGrowth: bucket.yearOnYearGrowth || '',
  };
}

/** Get foot traffic KPI for a given period (calls /home/keliukpi per metric) */
export async function getKPI(period: FoorirPeriod = 'yesterday'): Promise<FoorirKPI | null> {
  const token = getFoorirToken();
  if (!token) return null;

  const timeType = FOORIR_PERIODS[period];

  try {
    // Fetch all metric types in parallel
    const entries = Object.entries(METRIC_TYPES) as [keyof typeof METRIC_TYPES, string][];
    const results = await Promise.all(
      entries.map(([, apiType]) => fetchKeliuMetric(apiType, timeType)),
    );

    // Build KPI object from results
    const ratios: FoorirKPI['ratios'] = {};
    const values: Record<string, number> = {};

    entries.forEach(([field], i) => {
      const r = results[i];
      values[field] = r?.value ?? 0;
      if (r) {
        ratios[field] = {
          chainRelativeRatio: r.chainRelativeRatio,
          yearOnYearGrowth: r.yearOnYearGrowth,
        };
      }
    });

    const kpi: FoorirKPI = {
      flowIn:           values.flowIn,
      flowPassby:       values.flowPassby,
      batch:            values.batch,
      adult:            values.adult,
      children:         values.children,
      // Not available from this endpoint
      flowOut:          0,
      flowTurnback:     0,
      averageDwellTime: 0,
      totalDwellTime:   0,
      customerIn:       0,
      enterStaff:       0,
      leaveStaff:       0,
      ratios,
    };

    console.log('[Foorir] KPI:', JSON.stringify(kpi).slice(0, 400));
    return kpi;
  } catch (e) {
    console.error('[Foorir] KPI fetch error:', e);
    return null;
  }
}

/** Check if we have a valid session */
export async function checkSession(): Promise<boolean> {
  const token = getFoorirToken();
  if (!token) return false;
  try {
    const resp = await fetch(`${BASE}/auth/info`, { headers: authHeaders() });
    if (resp.ok) return true;
    clearFoorirToken();
    return false;
  } catch {
    return false;
  }
}
