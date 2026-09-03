#!/usr/bin/env tsx
/**
 * CLI za jednu turu prikupljanja.
 *
 *   npm run harvest -- --craft gipsar --zone Vracar --quick --dry --headful   # PRVA PROBA, ~5-10 min
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
import { RICH_ZONES, resolveZone } from '../lib/config/zones';
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
  maxQueries?: number;
  maxAnchors?: number;
  quick: boolean;
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
    maxQueries: get('queries') ? Number(get('queries')) : undefined,
    maxAnchors: get('anchors') ? Number(get('anchors')) : undefined,
    quick: has('quick'),
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

  const CRAFTS: Craft[] = ['vodoinstalater', 'gipsar', 'moler'];
  if (!CRAFTS.includes(args.craft)) {
    console.error(`Nepoznat zanat: "${args.craft}". Dozvoljeni: ${CRAFTS.join(' | ')}`);
    process.exit(1);
  }
  if (!args.plan && !resolveZone(args.zone)) {
    console.error(`Nepoznata zona: "${args.zone}"`);
    console.error(`\nDostupne zone:`);
    for (const zone of Object.values(RICH_ZONES)) {
      console.error(`  ${zone.label.padEnd(28)} ${zone.municipality} · ${zone.tier}`);
    }
    console.error(`\nPrihvata se i bez kvačica: Vracar, Dorcol, Savski Venac…`);
    process.exit(1);
  }

  const jobs = args.plan
    ? buildDailyPlan([args.craft])
    : [{ category: args.craft, rich_zone: args.zone }];

  // --quick: probna tura koja traje 5-10 min umesto 60-90.
  // Pun paket je ~60 upita × 2 ankera = 120 pretraga po ~45s — to je sat i po.
  const maxQueries = args.quick ? (args.maxQueries ?? 4) : args.maxQueries;
  const maxAnchors = args.quick ? (args.maxAnchors ?? 1) : args.maxAnchors;
  const maxPerQuery = args.quick ? (args.maxPerQuery ?? 8) : args.maxPerQuery;

  if (!args.plan) {
    console.log(`Zanat: ${args.craft} | Zona: ${args.zone} | ${args.dry ? 'DRY RUN' : 'upis u bazu'}`);
    const pretraga = (maxQueries ?? 60) * (maxAnchors ?? 2);
    const minuta = Math.round((pretraga * 45) / 60);
    console.log(`Obim: ${pretraga} pretraga × ~45s ≈ ${minuta} min${args.quick ? '  (--quick)' : ''}`);
    if (!args.quick && pretraga > 40) {
      console.log('Savet: za prvu probu dodaj --quick (4 upita, 1 kvart, ~5-10 min).');
    }
    console.log('');
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
        maxPerQuery: maxPerQuery,
        maxQueries: maxQueries,
        maxAnchors: maxAnchors,
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
      if (report.htmlPath) {
        console.log(`\n📱 OTVORI OVO NA TELEFONU (pošalji sebi fajl na WhatsApp/mejl):`);
        console.log(`   ${report.htmlPath}`);
      }
      if (report.jsonPath) console.log(`   JSON (za dalju obradu): ${report.jsonPath}`);
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
