/**
 * GET /api/health          — stanje mašine: AI provajderi, kvote, baza.
 * GET /api/health?browser=1 — dodatno STVARNO pokreće Chromium i javi da li radi.
 *
 * Provera browsera je odvojena namerno: traje 3-8s i troši memoriju, ali je
 * jedini način da posle deploya odmah saznaš da li serverless Chromium radi —
 * bez nje otkriješ problem tek kad cron tiho ne uradi ništa.
 *
 * Zakači običan /api/health na uptime monitor (UptimeRobot, besplatno)
 * da te probudi kad AI kvota pukne.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { aiHealth } from '@/lib/ai/router';
import { isDbConfigured } from '@/lib/db/supabase';
import { leadStats } from '@/lib/db/leads';
import { requireToken } from '@/lib/api/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface BrowserCheck {
  ok: boolean;
  mode: 'serverless' | 'lokalni';
  ms?: number;
  verzija?: string;
  greska?: string;
}

/** Pokreće browser, otvori praznu stranicu, pročita User-Agent i ugasi ga. */
async function checkBrowser(): Promise<BrowserCheck> {
  const { createSession, isServerless } = await import('@/lib/scraper/browser');
  const mode = isServerless() ? 'serverless' : 'lokalni';
  const startedAt = Date.now();

  let session: Awaited<ReturnType<typeof createSession>> | null = null;
  try {
    session = await createSession({ profile: 'health', blockAssets: true });
    await session.page.goto('about:blank');
    const ua = await session.page.evaluate(() => navigator.userAgent);
    return { ok: true, mode, ms: Date.now() - startedAt, verzija: ua.slice(0, 90) };
  } catch (error) {
    return { ok: false, mode, ms: Date.now() - startedAt, greska: String(error).slice(0, 300) };
  } finally {
    await session?.close().catch(() => undefined);
  }
}

export async function GET(request: NextRequest) {
  const ai = aiHealth();
  const dbReady = isDbConfigured();
  const stats = dbReady ? await leadStats() : null;

  // Provera browsera je skupa — zaključana tokenom da je niko ne zloupotrebi.
  let browser: BrowserCheck | undefined;
  if (request.nextUrl.searchParams.get('browser') === '1') {
    const denied = requireToken(request);
    if (denied) return denied;
    browser = await checkBrowser();
  }

  const healthy = ai.ok && ai.usableNow > 0 && (browser?.ok ?? true);

  return NextResponse.json(
    {
      ok: healthy,
      vreme: new Date().toISOString(),
      ai: {
        konfigurisano: ai.ok,
        dostupno_sada: ai.usableNow,
        provajderi: ai.providers.map((p) => ({
          id: p.id,
          model: p.model,
          kljuc: p.configured,
          dostupan: p.available,
          poziva: p.calls,
          gresaka: p.failures,
          rate_limit_udara: p.rateLimitHits,
          prosek_ms: p.avgLatencyMs,
          dnevno_iskorisceno: `${p.bucket.dailyUsed}${p.bucket.dailyLimit ? `/${p.bucket.dailyLimit}` : ''}`,
        })),
      },
      baza: { povezana: dbReady, ...(stats ? { leadova: stats.total, danas: stats.newToday, prosek_skora: stats.avgScore } : {}) },
      ...(browser ? { browser } : {}),
    },
    { status: healthy ? 200 : 503 },
  );
}
