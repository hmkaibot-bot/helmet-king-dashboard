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

// ── Token management ──────────────────────────────────────────
let _token: string | null = null;

export function getFoorirToken(): string | null {
  if (_token) return _token;
  try { return sessionStorage.getItem('foorir_token'); } catch { return null; }
}

function setFoorirToken(t: string) {
  _token = t;
  try { sessionStorage.setItem('foorir_token', t); } catch {}
}

export function clearFoorirToken() {
  _token = null;
  try { sessionStorage.removeItem('foorir_token'); } catch {}
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
    body: JSON.stringify({ username: USERNAME, password: encPw, code, key: uuid }),
  });
  const data = await resp.json();

  if (data.token) {
    setFoorirToken(data.token);
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
  const resp = await fetch(`${BASE}/home/keliukpi?${params}`, { headers: authHeaders() });
  if (!resp.ok) { if (resp.status === 401) clearFoorirToken(); return null; }
  const data = await resp.json();
  return data?.data || data || null;
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
