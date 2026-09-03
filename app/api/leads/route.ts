/**
 * GET  /api/leads  — lista leadova sa filterima (JSON za dashboard, CRM ili Excel izvoz)
 * POST /api/leads  — ručni unos sirovog leada koji prolazi kroz AI kvalifikaciju
 *
 * Zaštita: GET traži API_TOKEN samo ako je podešen (da možeš da ga zoveš i lokalno),
 * POST ga traži uvek — piše u bazu i troši AI kvotu.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { listLeads } from '@/lib/db/leads';
import { qualifyOnly } from '@/lib/pipeline/runPipeline';
import { requireToken } from '@/lib/api/auth';
import type { RawLead } from '@/lib/types/lead';
import type { Craft } from '@/lib/config/categories';
import type { RichZoneId } from '@/lib/config/zones';
import type { LeadStatus } from '@/lib/types/lead';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (process.env.API_TOKEN) {
    const denied = requireToken(request);
    if (denied) return denied;
  }

  const params = request.nextUrl.searchParams;
  const { leads, total } = await listLeads({
    craft: (params.get('craft') as Craft) ?? undefined,
    zoneId: (params.get('zone') as RichZoneId) ?? undefined,
    tier: (params.get('tier') as 'HIGH' | 'MEDIUM' | 'STANDARD') ?? undefined,
    status: (params.get('status') as LeadStatus) ?? undefined,
    minScore: params.get('minScore') ? Number(params.get('minScore')) : undefined,
    search: params.get('q') ?? undefined,
    limit: params.get('limit') ? Number(params.get('limit')) : 50,
    offset: params.get('offset') ? Number(params.get('offset')) : 0,
  });

  return NextResponse.json({ ok: true, total, count: leads.length, leads });
}

export async function POST(request: NextRequest) {
  const denied = requireToken(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Telo zahteva nije validan JSON' }, { status: 400 });
  }

  const payload = body as { leads?: Partial<RawLead>[]; dryRun?: boolean; minScore?: number };
  if (!Array.isArray(payload.leads) || payload.leads.length === 0) {
    return NextResponse.json({ ok: false, error: 'Očekivano polje "leads" sa bar jednim unosom' }, { status: 400 });
  }
  if (payload.leads.length > 50) {
    return NextResponse.json({ ok: false, error: 'Maksimum 50 leadova po zahtevu' }, { status: 400 });
  }

  const raws: RawLead[] = payload.leads.map((item) => ({
    source: item.source ?? 'manual',
    sourceUrl: item.sourceUrl ?? '',
    name: item.name ?? '',
    rawAddress: item.rawAddress ?? null,
    rawPhone: item.rawPhone ?? null,
    rawCategory: item.rawCategory ?? null,
    rawDescription: item.rawDescription ?? null,
    craft: (item.craft as Craft) ?? 'moler',
    targetZone: (item.targetZone as RichZoneId) ?? 'vracar',
    scrapedAt: item.scrapedAt ?? new Date().toISOString(),
    ...(item.meta ? { meta: item.meta } : {}),
  }));

  const invalid = raws.findIndex((r) => !r.name.trim());
  if (invalid >= 0) {
    return NextResponse.json({ ok: false, error: `Lead na poziciji ${invalid} nema naziv` }, { status: 400 });
  }

  const result = await qualifyOnly(raws, { dryRun: payload.dryRun, minScore: payload.minScore });
  return NextResponse.json({
    ok: true,
    qualified: result.leads.length,
    inserted: result.inserted,
    duplicates: result.duplicates,
    rejected: result.rejected,
    leads: result.leads,
  });
}
