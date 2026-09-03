#!/usr/bin/env tsx
/**
 * CLI za jednu turu prikupljanja.
 *
 *   npm run harvest -- --craft gipsar --zone Vracar
 *   npm run harvest -- --craft moler --zone Dedinje --dry --headful
 *   npm run harvest -- --plan            # sve zone × svi zanati (dugo traje)
 *   npm run harvest -- --ping            # samo provera AI provajdera
 */

import 'dotenv/config';
import { runPipeline, buildDailyPlan } from '../lib/pipeline/runPipeline';
import { pingAi } from '../lib/ai/aiEngine';
import { providerStats } from '../lib/ai/router';
import { isDbConfigured } from '../lib/db/supabase';
import { RICH_ZONES } from '../lib/config/zones';
import type { Craft } from '../lib/config/categories';
import { sleep, randomBetween } from '../lib/utils/rateLimiter';

interface Args {
  craft: Craft;
  zone: string;
  dry: boolean;
  rulesOnly: boolean;
  headful: boolean;
  plan: boolean;
  ping: boolean;
  minScore?: number;
  maxPerQuery?: number;
  sources?: ('google_maps' | 'registar_sz' | 'oglasi')[];
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  return {
    craft: (get('craft') as Craft) ?? 'gipsar',
    zone: get('zone') ?? 'Vracar',
    dry: has('dry'),
    rulesOnly: has('rules-only'),
    headful: has('headful'),
    plan: has('plan'),
    ping: has('ping'),
    minScore: get('min-score') ? Number(get('min-score')) : undefined,
    maxPerQuery: get('max') ? Number(get('max')) : undefined,
    sources: get('sources')?.split(',') as Args['sources'],
  };
}

function banner(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   MajstorKlik — Lead Generation Machine                      ║
║   Beograd · premium zone · multi-AI pipeline                 ║
╚══════════════════════════════════════════════════════════════╝`);
  console.log(`Baza: ${isDbConfigured() ? 'Supabase povezan' : 'NIJE podešena (rezultat ide u JSON)'}`);
  console.log(
    `AI provajderi: ${providerStats()
      .map((p) => `${p.id}${p.configured ? '' : ' (bez ključa)'}`)
      .join(', ')}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  banner();

  if (args.ping) {
    const result = await pingAi();
    console.log(result.ok ? `AI radi — ${result.provider} / ${result.model}` : `AI ne radi: ${result.error}`);
    console.table(providerStats());
    return;
  }

  const jobs = args.plan
    ? buildDailyPlan([args.craft])
    : [{ category: args.craft, rich_zone: args.zone }];

  if (!args.plan) {
    console.log(`Zanat: ${args.craft} | Zona: ${args.zone} | ${args.dry ? 'DRY RUN' : 'upis u bazu'}\n`);
  } else {
    console.log(`Plan: ${jobs.length} kombinacija (zona × zanat). Ovo traje satima — pusti u pozadini.\n`);
  }

  let totalInserted = 0;

  for (const [index, job] of jobs.entries()) {
    try {
      const report = await runPipeline({
        category: job.category,
        rich_zone: job.rich_zone,
        dryRun: args.dry,
        rulesOnly: args.rulesOnly,
        headless: !args.headful,
        minScore: args.minScore,
        maxPerQuery: args.maxPerQuery,
        sources: args.sources,
        exportJsonDir: process.env.EXPORT_DIR ?? './export',
      });

      totalInserted += report.inserted;

      console.log(`\n──────── ${report.zoneLabel} / ${report.craft} ────────`);
      console.log(
        `sirovo ${report.rawFound} → kvalifikovano ${report.qualified} → upisano ${report.inserted} (duplikata ${report.duplicates}, odbačeno ${report.rejected})`,
      );

      if (report.topLeads.length > 0) {
        console.log('\nNajbolji leadovi:');
        console.table(
          report.topLeads.slice(0, 8).map((l) => ({
            skor: l.lead_score,
            klijent: l.client_name.slice(0, 32),
            zona: l.zone_label,
            tier: l.purchasing_power_tier,
            hitnost: l.urgency,
            telefon: l.phone_national,
          })),
        );
        console.log(`\nPrimer poruke (${report.topLeads[0]!.client_name}):\n"${report.topLeads[0]!.cold_pitch_message}"\n`);
      }
      if (report.jsonPath) console.log(`JSON: ${report.jsonPath}`);
    } catch (error) {
      console.error(`Posao pao (${job.category}/${job.rich_zone}):`, error);
    }

    if (index < jobs.length - 1) {
      const pause = randomBetween(60_000, 150_000);
      console.log(`\nPauza ${Math.round(pause / 1000)}s pre sledeće zone…\n`);
      await sleep(pause);
    }
  }

  console.log(`\nGOTOVO. Ukupno upisano: ${totalInserted} leadova.`);
  console.table(providerStats());
}

// Lista dostupnih zona pri pogrešnom unosu
process.on('uncaughtException', (error) => {
  if (String(error).includes('Nepoznata zona')) {
    console.error(`\n${error}`);
    console.error(`\nDostupne zone: ${Object.values(RICH_ZONES).map((z) => z.label).join(' | ')}`);
    process.exit(1);
  }
  throw error;
});

main().catch((error) => {
  console.error('\nPipeline pao:', error);
  process.exit(1);
});
