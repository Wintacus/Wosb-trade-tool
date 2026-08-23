import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser's Supabase client.
 *
 * Only VITE_-prefixed variables exist here, and only two of them. The VITE_
 * prefix is what puts a value into the JavaScript bundle the browser
 * downloads, so anything secret must not have it:
 *
 *   VITE_SUPABASE_URL         safe, it is just an address
 *   VITE_SUPABASE_ANON_KEY    safe, it is the publishable key and row-level
 *                             security is what actually protects the data
 *
 *   SUPABASE_SERVICE_ROLE_KEY server only, bypasses row-level security entirely
 *   ANTHROPIC_API_KEY         server only, spends real money
 *
 * The last two are used exclusively inside serverless functions and must never
 * be imported into this file or anything it reaches.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, anonKey!)
  : null;
