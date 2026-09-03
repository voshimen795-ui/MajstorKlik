/**
 * GET /api/health — stanje mašine: AI provajderi, kvote, baza.
 * Zovi ga pre svake veće ture, i zakači na uptime monitor (npr. UptimeRobot,
 * besplatan) da te probudi kad ti free tier kvota pukne.
 */

import { NextResponse } from 'next/server';
import { aiHealth } from '@/lib/ai/router';
import { isDbConfigured } from '@/lib/db/supabase';
import { leadStats } from '@/lib/db/leads';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const ai = aiHealth();
  const dbReady = isDbConfigured();
  const stats = dbReady ? await leadStats() : null;

  const healthy = ai.ok && ai.usableNow > 0;

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
    },
    { status: healthy ? 200 : 503 },
  );
}
