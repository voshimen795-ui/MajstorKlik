/**
 * Supabase klijenti.
 *
 * DVA klijenta, namerno:
 *  - `getServiceClient()` — service_role ključ, PIŠE leadove. Sme SAMO na serveru
 *    (worker, API route). Ako ovaj ključ ikad završi u browseru, ceo ti je DB otvoren.
 *  - `getAnonClient()`    — anon ključ, čita kroz RLS. Za javne delove.
 *
 * Ako Supabase nije podešen, `isDbConfigured()` vraća false i pipeline radi
 * u "dry" režimu (leadovi idu u JSON fajl) — mašina mora da radi i pre nego
 * što uopšte otvoriš nalog.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let serviceClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

export function isDbConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY));
}

export function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase nije podešen: nedostaje NEXT_PUBLIC_SUPABASE_URL ili SUPABASE_SERVICE_ROLE_KEY');
  }

  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'majstorklik-leadgen' } },
  });
  return serviceClient;
}

export function getAnonClient(): SupabaseClient {
  if (anonClient) return anonClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase nije podešen: nedostaje NEXT_PUBLIC_SUPABASE_URL ili NEXT_PUBLIC_SUPABASE_ANON_KEY');
  }

  anonClient = createClient(url, key, { auth: { persistSession: false } });
  return anonClient;
}

export const LEADS_TABLE = process.env.SUPABASE_LEADS_TABLE || 'leads';
export const RUNS_TABLE = process.env.SUPABASE_RUNS_TABLE || 'harvest_runs';
