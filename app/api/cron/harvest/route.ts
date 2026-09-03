/**
 * GET /api/cron/harvest — poziva ga Vercel Cron (vidi vercel.json).
 *
 * Šta radi: bira sledeću kombinaciju zanat × zona iz rotacije (deterministički,
 * po satu u danu — tako se zone smenjuju same, bez čuvanja stanja) i pokreće turu.
 *
 * Na Vercel-u se tura NE izvršava lokalno (nema Chromium) nego se prosleđuje
 * workeru na WORKER_URL. Ako worker nije podešen, ruta vrati 501 sa objašnjenjem —
 * bolje glasan signal nego cron koji svaki sat tiho ne radi ništa.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api/auth';
import { buildDailyPlan } from '@/lib/pipeline/runPipeline';
import { aiHealth } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 60s je maksimum koji prolazi na SVAKOM Vercel planu (Hobby uključen).
// Ova ruta ionako samo prosleđuje posao workeru — ne skrejpuje sama.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const plan = buildDailyPlan();
  // Rotacija bez stanja: sat u godini % broj poslova.
  const now = new Date();
  const hourOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 3_600_000);
  const job = plan[hourOfYear % plan.length]!;

  const health = aiHealth();
  if (!health.ok) {
    return NextResponse.json({ ok: false, error: 'Nijedan AI provajder nije konfigurisan' }, { status: 503 });
  }
  if (health.usableNow === 0) {
    // Svi u cooldown-u — preskačemo turu umesto da trošimo pokušaje.
    return NextResponse.json({ ok: true, skipped: true, razlog: 'svi AI provajderi u cooldown-u', job });
  }

  if (process.env.RUN_SCRAPER_HERE === 'true') {
    const { runPipeline } = await import('@/lib/pipeline/runPipeline');
    const report = await runPipeline({ category: job.category, rich_zone: job.rich_zone, headless: true });
    return NextResponse.json({ ok: true, mode: 'local', job, report });
  }

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    return NextResponse.json(
      {
        ok: false,
        job,
        error:
          'Cron je aktivan ali nema gde da izvrši posao. Podesi WORKER_URL (Railway/Render worker) ili pokreni worker procesom: npm run harvest:loop',
      },
      { status: 501 },
    );
  }

  const res = await fetch(`${workerUrl.replace(/\/$/, '')}/api/pipeline/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WORKER_TOKEN ?? process.env.API_TOKEN ?? ''}`,
    },
    body: JSON.stringify({ category: job.category, rich_zone: job.rich_zone }),
  }).catch((error: unknown) => ({ ok: false, status: 502, json: async () => ({ error: String(error) }) }) as Response);

  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ ok: res.ok, mode: 'forwarded', job, data }, { status: res.ok ? 202 : 502 });
}
