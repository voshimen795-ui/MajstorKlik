#!/usr/bin/env tsx
/**
 * KONTINUALNI WORKER — za Railway / Render / bilo koji besplatan Node host.
 *
 * Zašto worker a ne cron na Vercel-u: Vercel serverless nema Chromium i ima
 * limit trajanja funkcije (10-60s), a jedna tura skreovanja traje 5-20 minuta.
 * Zato: Vercel servira sajt i API, a worker (Railway/Render) skrejpuje.
 *
 * Anti-blocking na nivou rasporeda — ovo je važnije od svih stealth trikova:
 *   - radi SAMO u "ljudskim" satima (podrazumevano 08-22 po Beogradu)
 *   - nasumična pauza između tura (podrazumevano 45-120 min)
 *   - jedna zona po turi, nikad sve odjednom
 *   - posle blokade: duga pauza (2-6h) umesto ponovnog pokušaja
 *
 * Pokretanje:  npm run harvest:loop
 */

import 'dotenv/config';
import { runPipeline, buildDailyPlan } from '../lib/pipeline/runPipeline';
import { providerStats } from '../lib/ai/router';
import { createLogger } from '../lib/utils/logger';
import { sleep, randomBetween } from '../lib/utils/rateLimiter';
import type { Craft } from '../lib/config/categories';

const log = createLogger('worker');

const CRAFTS = (process.env.WORKER_CRAFTS ?? 'vodoinstalater,gipsar,moler')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean) as Craft[];

const ACTIVE_FROM = Number(process.env.WORKER_ACTIVE_FROM_HOUR ?? 8);
const ACTIVE_TO = Number(process.env.WORKER_ACTIVE_TO_HOUR ?? 22);
const MIN_PAUSE_MIN = Number(process.env.WORKER_MIN_PAUSE_MIN ?? 45);
const MAX_PAUSE_MIN = Number(process.env.WORKER_MAX_PAUSE_MIN ?? 120);

/** Sat po beogradskom vremenu, nezavisno od TZ hosta. */
function belgradeHour(): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Belgrade',
    hour: 'numeric',
    hour12: false,
  });
  return Number.parseInt(formatter.format(new Date()), 10);
}

function isWorkingHours(): boolean {
  const hour = belgradeHour();
  return hour >= ACTIVE_FROM && hour < ACTIVE_TO;
}

let stopping = false;
process.on('SIGTERM', () => {
  log.info('SIGTERM — završavam turu i gasim se');
  stopping = true;
});
process.on('SIGINT', () => {
  log.info('SIGINT — gasim se');
  process.exit(0);
});

async function main(): Promise<void> {
  const plan = buildDailyPlan(CRAFTS);
  log.info('worker startovan', {
    poslova_u_planu: plan.length,
    zanati: CRAFTS.join(','),
    aktivan: `${ACTIVE_FROM}-${ACTIVE_TO}h (Europe/Belgrade)`,
  });

  let index = 0;
  let consecutiveErrors = 0;

  while (!stopping) {
    if (!isWorkingHours()) {
      // Van radnog vremena — spavamo 30 min i proveravamo ponovo.
      log.info(`van radnog vremena (${belgradeHour()}h) — pauza 30 min`);
      await sleep(30 * 60_000);
      continue;
    }

    const job = plan[index % plan.length]!;
    index++;

    try {
      log.info(`--- tura ${index}: ${job.category} / ${job.rich_zone} ---`);
      const report = await runPipeline({
        category: job.category,
        rich_zone: job.rich_zone,
        headless: true,
        exportJsonDir: process.env.EXPORT_DIR,
      });

      consecutiveErrors = 0;
      log.info('tura završena', {
        zona: report.zoneLabel,
        zanat: report.craft,
        sirovo: report.rawFound,
        upisano: report.inserted,
        duplikata: report.duplicates,
        min: (report.durationMs / 60_000).toFixed(1),
      });

      if (report.rawFound === 0) {
        // Nula rezultata je skoro uvek znak blokade, ne praznog tržišta.
        consecutiveErrors++;
      }
    } catch (error) {
      consecutiveErrors++;
      log.error('tura pala', { error: String(error).slice(0, 300), uzastopnih: consecutiveErrors });
    }

    // Eksponencijalna pauza posle uzastopnih problema — IP se "hladi".
    if (consecutiveErrors >= 2) {
      const coolMin = Math.min(360, 60 * 2 ** (consecutiveErrors - 1));
      log.warn(`${consecutiveErrors} problema za redom — hladim IP ${coolMin} min`);
      await sleep(coolMin * 60_000);
      continue;
    }

    const pauseMin = randomBetween(MIN_PAUSE_MIN, MAX_PAUSE_MIN);
    log.info(`pauza ${pauseMin} min do sledeće ture`, {
      ai: providerStats()
        .map((p) => `${p.id}:${p.bucket.dailyUsed}`)
        .join(' '),
    });
    await sleep(pauseMin * 60_000);
  }

  log.info('worker ugašen');
}

main().catch((error) => {
  log.error('worker pao', { error: String(error) });
  process.exit(1);
});
