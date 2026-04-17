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

// Period codes used by Foorir API
export const FOORIR_PERIODS = {
  today:      '1',
  yesterday:  '6',
  this_week:  '2',
  last_week:  '7',
  this_month: '3',
  last_month: '4',
  this_year:  '5',
} as const;

export type FoorirPeriod = keyof typeof FOORIR_PERIODS;

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

/** Get foot traffic KPI for a given period */
export async function getKPI(period: FoorirPeriod = 'yesterday'): Promise<FoorirKPI | null> {
  const token = getFoorirToken();
  if (!token) return null;

  const params = new URLSearchParams({
    assignType: FOORIR_PERIODS[period],
    queryType: 'flowIn',  // primary metric
  });
  try {
    const resp = await fetch(`${BASE}/home/statistical?${params}`, { headers: authHeaders() });
    if (!resp.ok) {
      if (resp.status === 401) clearFoorirToken();
      console.warn('[Foorir] KPI fetch failed:', resp.status, resp.statusText);
      return null;
    }
    const data = await resp.json();
    console.log('[Foorir] KPI raw response:', JSON.stringify(data).slice(0, 300));
    const kpi = data?.data || data;
    return kpi || null;
  } catch (e) {
    console.error('[Foorir] KPI fetch error:', e);
    return null;
  }
}

/** Get KPI comparison data (has chainIndex + YoY for each period) */
export async function getKPIComparison(): Promise<FoorirKPIRow[]> {
  const token = getFoorirToken();
  if (!token) return [];

  const resp = await fetch(`${BASE}/home/keliukpi?assignType=6&queryType=flowIn`, { headers: authHeaders() });
  if (!resp.ok) return [];
  const data = await resp.json();
  // Foorir returns overview.flowIn, overview.flowPassby, etc.
  return data?.kpiList || data?.data?.kpiList || [];
}

/** Get statistical chart data for trend display */
export async function getStatistical(period: FoorirPeriod = 'yesterday'): Promise<any[]> {
  const token = getFoorirToken();
  if (!token) return [];

  const params = new URLSearchParams({
    assignType: FOORIR_PERIODS[period],
    queryType: 'flowIn',
  });
  const resp = await fetch(`${BASE}/home/statistical?${params}`, { headers: authHeaders() });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data?.data || data?.list || [];
}

/** Get trend data */
export async function getTrend(): Promise<any> {
  const token = getFoorirToken();
  if (!token) return null;

  const resp = await fetch(`${BASE}/home/trend?assignType=6&queryType=flowIn`, { headers: authHeaders() });
  if (!resp.ok) return null;
  return resp.json();
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
