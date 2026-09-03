/**
 * POST /api/pipeline/run — ručno pokretanje ture prikupljanja.
 *
 * VAŽNO O OKRUŽENJU:
 *   Vercel serverless funkcije NEMAJU Chromium i imaju limit trajanja (10-60s),
 *   a jedna tura skreovanja traje 5-20 minuta. Zato:
 *
 *     - na Vercel-u  -> ova ruta PROSLEĐUJE posao workeru (WORKER_URL)
 *     - na Railway/Render/VPS-u (RUN_SCRAPER_HERE=true) -> izvršava turu lokalno
 *
 *   Ako nije podešeno ni jedno ni drugo, ruta to jasno kaže umesto da tiho puca.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireToken } from '@/lib/api/auth';
import { toZoneId } from '@/lib/scraper/scraper';
import type { Craft } from '@/lib/config/categories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 60s prolazi na svakom planu. Na Vercel-u ova ruta samo prosleđuje posao;
// kad radi lokalno (RUN_SCRAPER_HERE=true na Railway/Render/VPS) limit ne važi.
export const maxDuration = 60;

const CRAFTS: Craft[] = ['vodoinstalater', 'gipsar', 'moler'];

export async function POST(request: NextRequest) {
  const denied = requireToken(request);
  if (denied) return denied;

  let body: { category?: string; rich_zone?: string; sources?: string[]; dryRun?: boolean; minScore?: number; maxPerQuery?: number };
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

  // --- Slučaj A: ovaj proces sme da skrejpuje (Railway / Render / VPS) ---
  if (process.env.RUN_SCRAPER_HERE === 'true') {
    const { runPipeline } = await import('@/lib/pipeline/runPipeline');
    try {
      const report = await runPipeline({
        category,
        rich_zone: zoneId,
        sources: body.sources as ('google_maps' | 'registar_sz' | 'oglasi')[] | undefined,
        dryRun: body.dryRun,
        minScore: body.minScore,
        maxPerQuery: body.maxPerQuery,
        headless: true,
      });
      return NextResponse.json({ ok: true, mode: 'local', report });
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
      error:
        'Skreper ne može da radi u ovom okruženju. Postavi RUN_SCRAPER_HERE=true (Railway/Render/VPS sa Chromium-om) ili WORKER_URL da se posao prosledi workeru.',
      hint: 'Lokalno: npm run harvest -- --craft gipsar --zone Vracar',
    },
    { status: 501 },
  );
}
