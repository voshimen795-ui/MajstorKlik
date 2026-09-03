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
import { defaultBudgetMs } from '@/lib/utils/deadline';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Vercel Pro: 300s. Sa SERVERLESS_CHROMIUM=true tura se vrti ovde;
// bez toga se posao prosleđuje workeru i ruta se završi za sekundu.
export const maxDuration = 300;

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

  const serverless = process.env.SERVERLESS_CHROMIUM === 'true';
  if (serverless || process.env.RUN_SCRAPER_HERE === 'true') {
    const { runPipeline } = await import('@/lib/pipeline/runPipeline');
    const report = await runPipeline({
      category: job.category,
      rich_zone: job.rich_zone,
      headless: true,
      // U funkciji radimo kraće ture, ali češće (5 crona dnevno) — zbir je isti.
      ...(serverless ? { maxPerQuery: 12, maxDetails: 8, timeBudgetMs: defaultBudgetMs() } : {}),
    });
    return NextResponse.json({ ok: true, mode: serverless ? 'serverless' : 'local', job, report });
  }

  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) {
    return NextResponse.json(
      {
        ok: false,
        job,
        error: 'Cron je aktivan ali nema gde da izvrši posao.',
        resenja: [
          'Vercel Pro: SERVERLESS_CHROMIUM=true',
          'Railway/Render: WORKER_URL + RUN_SCRAPER_HERE=true na workeru',
          'Lokalno: npm run harvest:loop',
        ],
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
