/**
 * BAZA & DUPES CHECK
 *
 * Duplikat nije samo neuredna baza — to je majstor koji drugi put zove istog
 * čoveka sa istom porukom. To ubija reputaciju broja i pali WhatsApp spam filter.
 * Zato je provera duplikata obavezna PRE upisa, na tri nivoa:
 *
 *   1. UNIQUE indeks na `phone_e164` u bazi (poslednja linija odbrane)
 *   2. `phoneExists()` — provera pre upisa
 *   3. `dedupe_key` — kad lead nema telefon (ime+adresa fingerprint)
 *
 * Bulk varijante rade JEDNIM upitom (`in`), ne N upita — bitno kad ubaciš 200 leadova.
 */

import { getServiceClient, isDbConfigured, LEADS_TABLE, RUNS_TABLE } from './supabase';
import type { LeadRecord, LeadStatus } from '../types/lead';
import type { Craft } from '../config/categories';
import type { RichZoneId } from '../config/zones';
import { toE164 } from '../utils/phoneUtils';
import { createLogger } from '../utils/logger';

const log = createLogger('db:leads');

export interface DuplicateInfo {
  exists: boolean;
  id?: string;
  clientName?: string;
  createdAt?: string;
  status?: LeadStatus;
}

/**
 * GLAVNA PROVERA: da li broj već postoji u bazi.
 * Normalizuje ulaz u E.164 pre upita — "063/123-456" i "+38163123456" su isti broj.
 */
export async function phoneExists(rawPhone: string | null | undefined): Promise<DuplicateInfo> {
  const e164 = toE164(rawPhone);
  if (!e164) return { exists: false };
  if (!isDbConfigured()) return { exists: false };

  const { data, error } = await getServiceClient()
    .from(LEADS_TABLE)
    .select('id, client_name, created_at, status')
    .eq('phone_e164', e164)
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error('provera duplikata pala', { error: error.message });
    // Fail-safe: kad ne možemo da proverimo, tretiramo kao "postoji" da NE pošaljemo
    // poruku dvaput. Bolje propustiti lead nego spamovati klijenta.
    return { exists: true };
  }
  if (!data) return { exists: false };

  return {
    exists: true,
    id: data.id as string,
    clientName: data.client_name as string,
    createdAt: data.created_at as string,
    status: data.status as LeadStatus,
  };
}

/** Bulk provera — vraća set brojeva koji već postoje. Jedan upit za celu turu. */
export async function existingPhones(phones: (string | null | undefined)[]): Promise<Set<string>> {
  const normalized = Array.from(new Set(phones.map((p) => toE164(p)).filter((p): p is string => !!p)));
  if (normalized.length === 0 || !isDbConfigured()) return new Set();

  const found = new Set<string>();
  // Supabase `in` filter ima praktičan limit na dužinu URL-a — režemo na 200.
  for (let i = 0; i < normalized.length; i += 200) {
    const chunk = normalized.slice(i, i + 200);
    const { data, error } = await getServiceClient().from(LEADS_TABLE).select('phone_e164').in('phone_e164', chunk);
    if (error) {
      log.error('bulk provera duplikata pala', { error: error.message });
      // Fail-safe kao gore: tretiramo ceo chunk kao postojeći.
      chunk.forEach((p) => found.add(p));
      continue;
    }
    for (const row of data ?? []) {
      if (row.phone_e164) found.add(row.phone_e164 as string);
    }
  }
  return found;
}

export interface InsertResult {
  inserted: LeadRecord[];
  duplicates: { client_name: string; phone_e164: string }[];
  failed: { client_name: string; error: string }[];
}

/**
 * Upisuje leadove uz punu deduplikaciju:
 *   a) unutar same ture (dva rezultata sa istim brojem)
 *   b) protiv baze (bulk upit)
 *   c) `upsert ... onConflict` kao atomska zaštita od trke dva workera
 */
export async function insertLeads(leads: LeadRecord[]): Promise<InsertResult> {
  const result: InsertResult = { inserted: [], duplicates: [], failed: [] };
  if (leads.length === 0) return result;

  if (!isDbConfigured()) {
    log.warn('Supabase nije podešen — preskačem upis', { count: leads.length });
    result.failed = leads.map((l) => ({ client_name: l.client_name, error: 'baza nije podešena' }));
    return result;
  }

  // (a) dedupe unutar ture — zadržavamo lead sa najvišim skorom
  const byPhone = new Map<string, LeadRecord>();
  for (const lead of leads) {
    const key = lead.phone_e164 || lead.dedupe_key;
    const existing = byPhone.get(key);
    if (!existing || lead.lead_score > existing.lead_score) byPhone.set(key, lead);
    else result.duplicates.push({ client_name: lead.client_name, phone_e164: lead.phone_e164 });
  }
  const unique = Array.from(byPhone.values());

  // (b) dedupe protiv baze
  const known = await existingPhones(unique.map((l) => l.phone_e164));
  const fresh = unique.filter((lead) => {
    if (lead.phone_e164 && known.has(lead.phone_e164)) {
      result.duplicates.push({ client_name: lead.client_name, phone_e164: lead.phone_e164 });
      return false;
    }
    return true;
  });

  if (fresh.length === 0) {
    log.info('nema novih leadova za upis', { duplikata: result.duplicates.length });
    return result;
  }

  // (c) atomski upsert
  const { data, error } = await getServiceClient()
    .from(LEADS_TABLE)
    .upsert(fresh.map(toRow), { onConflict: 'phone_e164', ignoreDuplicates: true })
    .select();

  if (error) {
    log.error('upis leadova pao', { error: error.message });
    result.failed = fresh.map((l) => ({ client_name: l.client_name, error: error.message }));
    return result;
  }

  const insertedKeys = new Set((data ?? []).map((row) => row.phone_e164 as string));
  for (const lead of fresh) {
    if (insertedKeys.has(lead.phone_e164)) result.inserted.push(lead);
    else result.duplicates.push({ client_name: lead.client_name, phone_e164: lead.phone_e164 });
  }

  log.info('upis završen', {
    upisano: result.inserted.length,
    duplikata: result.duplicates.length,
    greške: result.failed.length,
  });
  return result;
}

/** LeadRecord -> red u tabeli (snake_case je već usklađen). */
function toRow(lead: LeadRecord): Record<string, unknown> {
  const { id: _id, created_at: _createdAt, ...rest } = lead;
  void _id;
  void _createdAt;
  return rest;
}

export interface LeadQuery {
  craft?: Craft;
  zoneId?: RichZoneId;
  tier?: 'HIGH' | 'MEDIUM' | 'STANDARD';
  status?: LeadStatus;
  minScore?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listLeads(query: LeadQuery = {}): Promise<{ leads: LeadRecord[]; total: number }> {
  if (!isDbConfigured()) return { leads: [], total: 0 };

  let q = getServiceClient()
    .from(LEADS_TABLE)
    .select('*', { count: 'exact' })
    .order('lead_score', { ascending: false })
    .order('created_at', { ascending: false });

  if (query.craft) q = q.eq('craft', query.craft);
  if (query.zoneId) q = q.eq('zone_id', query.zoneId);
  if (query.tier) q = q.eq('purchasing_power_tier', query.tier);
  if (query.status) q = q.eq('status', query.status);
  if (query.minScore !== undefined) q = q.gte('lead_score', query.minScore);
  if (query.search) q = q.or(`client_name.ilike.%${query.search}%,address.ilike.%${query.search}%`);

  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    log.error('čitanje leadova palo', { error: error.message });
    return { leads: [], total: 0 };
  }
  return { leads: (data ?? []) as unknown as LeadRecord[], total: count ?? 0 };
}

export async function updateLeadStatus(id: string, status: LeadStatus, note?: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (note !== undefined) patch.note = note;
  if (status === 'contacted') patch.contacted_at = new Date().toISOString();

  const { error } = await getServiceClient().from(LEADS_TABLE).update(patch).eq('id', id);
  if (error) {
    log.error('promena statusa pala', { error: error.message, id });
    return false;
  }
  return true;
}

export interface HarvestRunRecord {
  id?: string;
  craft: Craft;
  zone_id: RichZoneId;
  source: string;
  started_at: string;
  finished_at?: string;
  raw_found: number;
  qualified: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  ai_fallback_used: number;
  error?: string | null;
}

/** Log jedne ture skreovanja — bez ovoga ne znaš koji izvor stvarno donosi leadove. */
export async function logHarvestRun(run: HarvestRunRecord): Promise<void> {
  if (!isDbConfigured()) return;
  const { error } = await getServiceClient().from(RUNS_TABLE).insert(run);
  if (error) log.warn('log ture nije upisan', { error: error.message });
}

/** Statistika za dashboard. */
export async function leadStats(): Promise<{
  total: number;
  byTier: Record<string, number>;
  byCraft: Record<string, number>;
  byZone: Record<string, number>;
  newToday: number;
  avgScore: number;
}> {
  const empty = { total: 0, byTier: {}, byCraft: {}, byZone: {}, newToday: 0, avgScore: 0 };
  if (!isDbConfigured()) return empty;

  const { data, error } = await getServiceClient()
    .from(LEADS_TABLE)
    .select('purchasing_power_tier, craft, zone_label, lead_score, created_at')
    .limit(5000);

  if (error || !data) return empty;

  const byTier: Record<string, number> = {};
  const byCraft: Record<string, number> = {};
  const byZone: Record<string, number> = {};
  let scoreSum = 0;
  let newToday = 0;
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const row of data) {
    const tier = (row.purchasing_power_tier as string) ?? 'STANDARD';
    const craft = (row.craft as string) ?? 'nepoznato';
    const zone = (row.zone_label as string) ?? 'nepoznato';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    byCraft[craft] = (byCraft[craft] ?? 0) + 1;
    byZone[zone] = (byZone[zone] ?? 0) + 1;
    scoreSum += Number(row.lead_score ?? 0);
    if (typeof row.created_at === 'string' && row.created_at.startsWith(todayIso)) newToday++;
  }

  return {
    total: data.length,
    byTier,
    byCraft,
    byZone,
    newToday,
    avgScore: data.length > 0 ? Math.round(scoreSum / data.length) : 0,
  };
}
