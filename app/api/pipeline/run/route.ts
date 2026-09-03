/**
 * POST /api/pipeline/run — ručno pokretanje ture prikupljanja.
 *
 * TRI NAČINA IZVRŠAVANJA, po prioritetu:
 *
 *   1. SERVERLESS_CHROMIUM=true (Vercel Pro)  -> tura se vrti u samoj funkciji,
 *      sa Chromium-om iz @sparticuz/chromium i budžetom od ~280s.
 *   2. RUN_SCRAPER_HERE=true (Railway/Render/VPS) -> tura lokalno, bez limita.
 *   3. WORKER_URL                              -> posao se prosleđuje workeru.
 *
 * Ako ništa nije podešeno, ruta to jasno kaže umesto da tiho puca.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireToken } from '@/lib/api/auth';
import { toZoneId } from '@/lib/scraper/scraper';
import { defaultBudgetMs } from '@/lib/utils/deadline';
import type { Craft } from '@/lib/config/categories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Trajanje se podešava u `vercel.json` (npm run vercel:hobby / vercel:pro),
// ne ovde — jedan izvor istine. Pipeline sam staje pre isteka budžeta,
// vidi `lib/utils/deadline.ts`.

const CRAFTS: Craft[] = ['vodoinstalater', 'gipsar', 'moler'];

export async function POST(request: NextRequest) {
  const denied = requireToken(request);
  if (denied) return denied;

  let body: {
    category?: string;
    rich_zone?: string;
    sources?: string[];
    dryRun?: boolean;
    minScore?: number;
    maxPerQuery?: number;
    timeBudgetMs?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Telo zahteva nije validan JSON' }, { status: 400 });
  }

  const category = body.category as Craft | undefined;
  if (!category || !CRAFTS.includes(category)) {
    return NextResponse.json({ ok: false, error: `"category" mora biti: ${CRAFTS.join(' | ')}` }, { status: 400 });
  }

  let zoneId: string;
  try {
    zoneId = toZoneId(body.rich_zone ?? '');
  } catch (error) {
    return NextResponse.json({ ok: false, error: String((error as Error).message) }, { status: 400 });
  }

  // --- Slučaj A: ovaj proces sme da skrejpuje (Vercel Pro ili Railway/Render/VPS) ---
  const canRunHere = process.env.SERVERLESS_CHROMIUM === 'true' || process.env.RUN_SCRAPER_HERE === 'true';
  if (canRunHere) {
    const { runPipeline } = await import('@/lib/pipeline/runPipeline');
    try {
      const report = await runPipeline({
        category,
        rich_zone: zoneId,
        sources: body.sources as ('google_maps' | 'registar_sz' | 'oglasi')[] | undefined,
        dryRun: body.dryRun,
        minScore: body.minScore,
        // U serverlessu smanjujemo zahvat — bolje 12 obrađenih nego 40 prekinutih.
        maxPerQuery: body.maxPerQuery ?? (process.env.SERVERLESS_CHROMIUM === 'true' ? 12 : undefined),
        maxDetails: process.env.SERVERLESS_CHROMIUM === 'true' ? 8 : undefined,
        timeBudgetMs: body.timeBudgetMs ?? defaultBudgetMs(),
        headless: true,
      });
      return NextResponse.json({
        ok: true,
        mode: process.env.SERVERLESS_CHROMIUM === 'true' ? 'serverless' : 'local',
        report,
      });
    } catch (error) {
      return NextResponse.json({ ok: false, mode: 'local', error: String(error).slice(0, 500) }, { status: 500 });
    }
  }

  // --- Slučaj B: prosleđujemo workeru ---
  const workerUrl = process.env.WORKER_URL;
  if (workerUrl) {
    try {
      const res = await fetch(`${workerUrl.replace(/\/$/, '')}/api/pipeline/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WORKER_TOKEN ?? process.env.API_TOKEN ?? ''}`,
        },
        body: JSON.stringify({ ...body, category, rich_zone: zoneId }),
      });
      const data = await res.json().catch(() => ({}));
      return NextResponse.json({ ok: res.ok, mode: 'forwarded', worker: workerUrl, data }, { status: res.ok ? 202 : 502 });
    } catch (error) {
      return NextResponse.json({ ok: false, mode: 'forwarded', error: String(error).slice(0, 300) }, { status: 502 });
    }
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'Skreper nema gde da se izvrši u ovom okruženju.',
      resenja: [
        'Vercel Pro: postavi SERVERLESS_CHROMIUM=true (tura se vrti u funkciji, do 300s)',
        'Railway/Render/VPS: postavi RUN_SCRAPER_HERE=true',
        'Ili postavi WORKER_URL da se posao prosledi workeru',
      ],
      hint: 'Lokalno: npm run harvest -- --craft gipsar --zone Vracar',
    },
    { status: 501 },
  );
}
