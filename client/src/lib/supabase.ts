import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://myrangmxyjamsupbxbba.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTczMDQ2NCwiZXhwIjoyMDkxMzA2NDY0fQ.m0AWDNQpAGrUwV3rvK_5n66CM2j-RPzmC9Ti-YCCvjg';

// Memory-only storage to avoid localStorage in sandboxed iframe
const memoryStorage: Record<string, string> = {};
const customStorage = {
  getItem: (key: string) => memoryStorage[key] ?? null,
  setItem: (key: string, value: string) => { memoryStorage[key] = value; },
  removeItem: (key: string) => { delete memoryStorage[key]; },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storage: customStorage,
  },
});
