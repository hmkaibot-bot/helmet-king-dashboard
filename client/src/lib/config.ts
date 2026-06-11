/**
 * Central Supabase config — single source of truth for the whole client.
 *
 * SECURITY MODEL:
 * - The anon key below is PUBLIC BY DESIGN (it ships in every browser bundle).
 *   Data protection comes from Row Level Security — see sql/enable-rls.sql.
 * - NEVER put the service_role key anywhere in client/ — it bypasses all RLS.
 * - Env vars (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) override the defaults,
 *   e.g. for pointing a preview deploy at a staging project.
 */
const env = import.meta.env;

export const SUPABASE_URL: string =
  env.VITE_SUPABASE_URL || 'https://myrangmxyjamsupbxbba.supabase.co';

export const SUPABASE_ANON_KEY: string =
  env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15cmFuZ214eWphbXN1cGJ4YmJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzA0NjQsImV4cCI6MjA5MTMwNjQ2NH0.RmMZyuLZrddw7kL4y2qFY8XaI6zGXPx5D9xCi58-iSY';
