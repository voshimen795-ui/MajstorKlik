/**
 * PIPELINE — spaja sve u jedan potez.
 *
 *   skreper -> AI kvalifikacija -> dedupe -> Supabase -> log ture
 *
 * Playwright se učitava DINAMIČKI (`await import`) da Next build i Vercel
 * serverless funkcije ne pokušavaju da ga bandluju — na Vercel-u skreper
 * ionako ne radi (nema Chromium), tamo se koristi samo `qualifyOnly` režim.
 */

import { qualifyBatch } from '../ai/aiEngine';
import { insertLeads, logHarvestRun } from '../db/leads';
import { isDbConfigured } from '../db/supabase';
import { RICH_ZONES, type RichZoneId } from '../config/zones';
import type { Craft } from '../config/categories';
import type { LeadRecord, RawLead } from '../types/lead';
import { createLogger } from '../utils/logger';
import { createDeadline, defaultBudgetMs } from '../utils/deadline';
import { renderLeadsHtml } from './exportHtml';
import fs from 'node:fs/promises';
import path from 'node:path';

const log = createLogger('pipeline');

export interface PipelineParams {
  category: Craft;
  rich_zone: RichZoneId | string;
  sources?: ('google_maps' | 'registar_sz' | 'oglasi')[];
  /** Ne upisuj u bazu — samo vrati rezultat (za testiranje). */
  dryRun?: boolean;
  /** Preskoči AI (samo pravila) — kad je kvota potrošena. */
  rulesOnly?: boolean;
  minScore?: number;
  maxPerQuery?: number;
  /** Koliko upita iz paketa (pun paket ≈ 90 min po zoni; probna tura: 3-5). */
  maxQueries?: number;
  /** Koliko kvartova iz zone (probna tura: 1). */
  maxAnchors?: number;
  maxDetails?: number;
  headless?: boolean;
  /** Snimi rezultat i u JSON fajl (korisno kad Supabase nije podešen). */
  exportJsonDir?: string;
  /**
   * Ukupan vremenski budžet (ms). Na Vercel Pro funkciji ~280.000.
   * Deli se 70% skreper / 30% AI kvalifikacija — skreper je taj koji ume da
   * pojede sve vreme, a kvalifikacija bez skrejpovanih podataka nema šta da radi.
   */
  timeBudgetMs?: number;
}

export interface PipelineReport {
  craft: Craft;
  zone: string;
  zoneLabel: string;
  rawFound: number;
  qualified: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  aiFallbackUsed: number;
  durationMs: number;
  topLeads: LeadRecord[];
  rejectedSample: { name: string; reason: string }[];
  errors: string[];
  /** Posao prekinut zbog vremenskog budžeta — nije greška, samo kraća tura. */
  stoppedEarly: boolean;
  jsonPath?: string;
  /** Samostalan HTML — otvoriš ga na telefonu i kucaš WhatsApp dugmad. */
  htmlPath?: string;
}

export async function runPipeline(params: PipelineParams): Promise<PipelineReport> {
  const startedAt = Date.now();
  const startedIso = new Date().toISOString();

  // Dinamički import — Playwright ne sme u serverless bundle.
  const { scrape, toZoneId } = await import('../scraper/scraper');
  const zoneId = toZoneId(params.rich_zone);
  const zone = RICH_ZONES[zoneId];

  const totalBudgetMs = params.timeBudgetMs ?? defaultBudgetMs();
  const scrapeBudgetMs = totalBudgetMs ? Math.round(totalBudgetMs * 0.7) : undefined;

  log.info('=== POKRETANJE PIPELINE-A ===', {
    zanat: params.category,
    zona: zone.label,
    budžet_s: totalBudgetMs ? Math.round(totalBudgetMs / 1000) : 'bez ograničenja',
  });

  // --- 1. SKREPER (70% budžeta) ---
  const scrapeResult = await scrape({
    category: params.category,
    rich_zone: zoneId,
    sources: params.sources,
    maxPerQuery: params.maxPerQuery,
    maxQueries: params.maxQueries,
    maxAnchors: params.maxAnchors,
    maxDetails: params.maxDetails,
    headless: params.headless,
    timeBudgetMs: scrapeBudgetMs,
  });

  log.info(`skrejpovano ${scrapeResult.leads.length} sirovih unosa`, scrapeResult.bySource);

  // --- 2. AI KVALIFIKACIJA (ostatak budžeta) ---
  const spentMs = Date.now() - startedAt;
  const { leads, rejected, usedFallbackCount, skippedForTime } = await qualifyBatch(scrapeResult.leads, {
    rulesOnly: params.rulesOnly,
    minScore: params.minScore,
    deadline: createDeadline(totalBudgetMs ? Math.max(10_000, totalBudgetMs - spentMs) : undefined, 10_000),
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) log.info(`kvalifikacija ${done}/${total}`);
    },
  });

  log.info(`kvalifikovano ${leads.length}, odbačeno ${rejected.length}`, { ai_fallback: usedFallbackCount });

  // --- 3. UPIS + DEDUPE ---
  let inserted = 0;
  let duplicates = 0;

  if (!params.dryRun && isDbConfigured()) {
    const result = await insertLeads(leads);
    inserted = result.inserted.length;
    duplicates = result.duplicates.length;
    if (result.failed.length > 0) {
      log.error(`${result.failed.length} leadova nije upisano`, { prvi: result.failed[0]?.error });
    }
  } else {
    log.warn(params.dryRun ? 'dry-run: preskačem upis' : 'Supabase nije podešen: preskačem upis');
  }

  // --- 4. Izvoz: JSON (za dalju obradu) + HTML (za rad sa telefona) ---
  let jsonPath: string | undefined;
  let htmlPath: string | undefined;
  const exportDir = params.exportJsonDir ?? process.env.EXPORT_DIR;
  if (exportDir && leads.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `leads-${params.category}-${zoneId}-${stamp}`;

    jsonPath = await writeExport(exportDir, `${base}.json`, JSON.stringify(leads, null, 2));
    htmlPath = await writeExport(
      exportDir,
      `${base}.html`,
      renderLeadsHtml(leads, {
        craft: params.category,
        zoneLabel: zone.label,
        generatedAt: new Date(),
        rawFound: scrapeResult.leads.length,
        rejected: rejected.length,
      }),
    );
    log.info('rezultat izvezen', { jsonPath, htmlPath });
  }

  const durationMs = Date.now() - startedAt;

  // --- 5. LOG TURE ---
  await logHarvestRun({
    craft: params.category,
    zone_id: zoneId,
    source: (params.sources ?? ['google_maps', 'registar_sz']).join('+'),
    started_at: startedIso,
    finished_at: new Date().toISOString(),
    raw_found: scrapeResult.leads.length,
    qualified: leads.length,
    inserted,
    duplicates,
    rejected: rejected.length,
    ai_fallback_used: usedFallbackCount,
    error: scrapeResult.errors.length > 0 ? scrapeResult.errors.join(' | ').slice(0, 500) : null,
  });

  const report: PipelineReport = {
    craft: params.category,
    zone: zoneId,
    zoneLabel: zone.label,
    rawFound: scrapeResult.leads.length,
    qualified: leads.length,
    inserted,
    duplicates,
    rejected: rejected.length,
    aiFallbackUsed: usedFallbackCount,
    durationMs,
    topLeads: leads.slice(0, 10),
    rejectedSample: rejected.slice(0, 10),
    errors: scrapeResult.errors,
    stoppedEarly: scrapeResult.stoppedEarly || skippedForTime > 0,
    ...(jsonPath ? { jsonPath } : {}),
    ...(htmlPath ? { htmlPath } : {}),
  };

  log.info('=== PIPELINE ZAVRŠEN ===', {
    sirovo: report.rawFound,
    kvalifikovano: report.qualified,
    upisano: report.inserted,
    duplikata: report.duplicates,
    trajanje_min: (durationMs / 60_000).toFixed(1),
  });

  return report;
}

/**
 * Kvalifikacija bez skreovanja — za Vercel (nema Chromium) i za ručni unos.
 * Prima sirove leadove (npr. iz CSV-a ili sa telefona majstora) i vraća ocenjene.
 */
export async function qualifyOnly(
  raws: RawLead[],
  opts: { dryRun?: boolean; minScore?: number; rulesOnly?: boolean } = {},
): Promise<{ leads: LeadRecord[]; inserted: number; duplicates: number; rejected: { name: string; reason: string }[] }> {
  const { leads, rejected } = await qualifyBatch(raws, opts);

  if (opts.dryRun || !isDbConfigured()) {
    return { leads, inserted: 0, duplicates: 0, rejected };
  }

  const result = await insertLeads(leads);
  return { leads, inserted: result.inserted.length, duplicates: result.duplicates.length, rejected };
}

async function writeExport(dir: string, fileName: string, content: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

/**
 * Plan obilaska: koje kombinacije zanat × zona vrte se u jednoj turi.
 * Redosled je namerno "najbogatije prvo" — ako te blokiraju na pola,
 * već imaš najvrednije leadove.
 */
export function buildDailyPlan(crafts: Craft[] = ['vodoinstalater', 'gipsar', 'moler']): { category: Craft; rich_zone: RichZoneId }[] {
  const zonesByValue = Object.values(RICH_ZONES)
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((z) => z.id);

  const plan: { category: Craft; rich_zone: RichZoneId }[] = [];
  for (const zone of zonesByValue) {
    for (const craft of crafts) {
      plan.push({ category: craft, rich_zone: zone });
    }
  }
  return plan;
}
