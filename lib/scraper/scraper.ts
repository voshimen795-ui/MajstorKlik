/**
 * SKREPER — jedinstven ulaz.
 *
 *   const leads = await scrape({ category: 'gipsar', rich_zone: 'Vracar' });
 *
 * Otvara jednu "očovečenu" browser sesiju, prolazi kroz izabrane izvore,
 * i vraća sirove leadove (bez AI obrade — to radi `runPipeline`).
 *
 * Dizajniran da NIKAD ne obori proces: svaki izvor je u svom try/catch-u,
 * a ako nas neki izvor blokira, ostali nastavljaju.
 */

import type { Page } from 'playwright';
import { createSession, type BrowserSession } from './browser';
import { scrapeGoogleMaps } from './sources/googleMaps';
import { scrapeRegistarSZ } from './sources/registarSZ';
import { scrapeOglasi } from './sources/oglasi';
import { resolveZone, RICH_ZONES, type RichZoneId } from '../config/zones';
import type { Craft } from '../config/categories';
import type { RawLead } from '../types/lead';
import { createLogger } from '../utils/logger';
import { humanDelay, sleep, randomBetween } from '../utils/rateLimiter';
import { createDeadline, defaultBudgetMs } from '../utils/deadline';

const log = createLogger('scraper');

/** Ulazni parametar zone — prihvata i skraćenice ("Dordol", "Vracar") i pun naziv. */
export type RichZoneParam =
  | 'Vracar'
  | 'Vračar'
  | 'Stari Grad'
  | 'Dorcol'
  | 'Dordol'
  | 'Dorćol'
  | 'Savski Venac'
  | 'Savski venac'
  | 'Senjak'
  | 'Dedinje'
  | 'Zvezdara'
  | 'Palilula'
  | 'Novi Beograd'
  | RichZoneId;

export type ScraperSource = 'google_maps' | 'registar_sz' | 'oglasi';

export interface ScrapeParams {
  category: Craft;
  rich_zone: RichZoneParam;
  /** Podrazumevano: Maps + registar stambenih zajednica (oglasi su opt-in). */
  sources?: ScraperSource[];
  /** Maksimalno rezultata po jednom upitu. */
  maxPerQuery?: number;
  /** Koliko kartica otvaramo radi telefona. */
  maxDetails?: number;
  /** Sopstvena lista upita umesto automatske. */
  queries?: string[];
  /** Postojeća sesija (kad skrejpuješ više zona u jednom prolazu). */
  session?: BrowserSession;
  headless?: boolean;
  /**
   * Vremenski budžet u ms. Na Vercel-u je obavezan (Pro seče funkciju na 300s):
   * skreper sam staje pre isteka i uredno vrati ono što je skupio.
   * Prazno = bez ograničenja (worker, lokalno).
   */
  timeBudgetMs?: number;
}

export interface ScrapeResult {
  leads: RawLead[];
  zone: RichZoneId;
  craft: Craft;
  bySource: Record<string, number>;
  durationMs: number;
  errors: string[];
  /** true kad je posao prekinut zbog vremenskog budžeta (nije greška). */
  stoppedEarly: boolean;
}

/** Prevodi bilo koji zapis zone u kanonski id ili puca sa jasnom porukom. */
export function toZoneId(input: RichZoneParam | string): RichZoneId {
  const zone = resolveZone(input);
  if (!zone) {
    throw new Error(
      `Nepoznata zona: "${input}". Dozvoljene: ${Object.values(RICH_ZONES)
        .map((z) => z.label)
        .join(', ')}`,
    );
  }
  return zone.id;
}

/**
 * GLAVNA FUNKCIJA SKREPERA.
 */
export async function scrape(params: ScrapeParams): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const zoneId = toZoneId(params.rich_zone);
  const zone = RICH_ZONES[zoneId];
  const sources = params.sources ?? ['google_maps', 'registar_sz'];
  const errors: string[] = [];
  const bySource: Record<string, number> = {};

  log.info('start skreovanja', { craft: params.category, zona: zone.label, izvori: sources.join(', ') });

  const deadline = createDeadline(params.timeBudgetMs ?? defaultBudgetMs());
  const ownSession = !params.session;
  const session = params.session ?? (await createSession({ profile: 'maps', headless: params.headless }));
  const page: Page = session.page;
  const leads: RawLead[] = [];
  let stoppedEarly = false;

  try {
    for (const source of sources) {
      // Najmanji smislen posao po izvoru je ~60s; ispod toga ne počinjemo.
      if (!deadline.hasRoomFor(60_000)) {
        stoppedEarly = true;
        log.warn('vremenski budžet potrošen — preskačem preostale izvore', {
          preskočeno: sources.slice(sources.indexOf(source)).join(','),
        });
        break;
      }

      try {
        let found: RawLead[] = [];

        if (source === 'google_maps') {
          found = await scrapeGoogleMaps(page, {
            craft: params.category,
            zoneId,
            queries: params.queries,
            maxPerQuery: params.maxPerQuery,
            maxDetails: params.maxDetails,
            deadline,
          });
        } else if (source === 'registar_sz') {
          found = await scrapeRegistarSZ(page, {
            craft: params.category,
            zoneId,
            maxPerQuery: params.maxPerQuery,
            deadline,
          });
        } else if (source === 'oglasi') {
          found = await scrapeOglasi(page, { craft: params.category, zoneId, deadline });
        }

        bySource[source] = found.length;
        leads.push(...found);

        // Duža pauza između izvora — najjeftinija zaštita od blokade koju imaš.
        // U serverlessu je skraćujemo: tamo je vreme skuplje od diskrecije.
        await sleep(deadline.hasRoomFor(120_000) ? randomBetween(8_000, 20_000) : randomBetween(1_500, 3_500));
      } catch (error) {
        const message = `${source}: ${String(error).slice(0, 200)}`;
        errors.push(message);
        log.error('izvor pao', { source, error: message });
      }
    }

    if (deadline.expired()) stoppedEarly = true;
    await session.saveState();
  } finally {
    if (ownSession) {
      await humanDelay(500, 1200);
      await session.close();
    }
  }

  const deduped = dedupeRaw(leads);
  const durationMs = Date.now() - startedAt;

  log.info('kraj skreovanja', {
    sirovo: leads.length,
    posle_dedupe: deduped.length,
    trajanje_s: Math.round(durationMs / 1000),
    zona: zone.label,
  });

  return { leads: deduped, zone: zoneId, craft: params.category, bySource, durationMs, errors, stoppedEarly };
}

/**
 * Skrejpuje više zona/zanata u JEDNOJ browser sesiji.
 * Deljenje sesije čuva kolačiće pristanka i deluje prirodnije od 10 novih "prvih poseta".
 */
export async function scrapeMany(
  jobs: { category: Craft; rich_zone: RichZoneParam }[],
  opts: { headless?: boolean; maxPerQuery?: number; maxDetails?: number; sources?: ScraperSource[] } = {},
): Promise<ScrapeResult[]> {
  const session = await createSession({ profile: 'maps', headless: opts.headless });
  const results: ScrapeResult[] = [];

  try {
    for (const [index, job] of jobs.entries()) {
      results.push(await scrape({ ...job, ...opts, session }));
      if (index < jobs.length - 1) {
        const pauseMs = randomBetween(30_000, 90_000);
        log.info(`pauza ${Math.round(pauseMs / 1000)}s pre sledećeg posla`);
        await sleep(pauseMs);
      }
    }
  } finally {
    await session.close();
  }

  return results;
}

/** Dedupe u okviru jedne ture — isti objekat se pojavljuje u više upita. */
function dedupeRaw(leads: RawLead[]): RawLead[] {
  const seen = new Map<string, RawLead>();

  for (const lead of leads) {
    const key = lead.rawPhone
      ? `tel:${lead.rawPhone.replace(/\D/g, '')}`
      : `name:${lead.name.toLowerCase().trim()}|${(lead.rawAddress ?? '').toLowerCase().trim()}`;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, lead);
      continue;
    }
    // Zadržavamo bogatiji zapis (onaj sa telefonom i dužim opisom).
    const existingScore = (existing.rawPhone ? 2 : 0) + (existing.rawDescription?.length ?? 0) / 1000;
    const currentScore = (lead.rawPhone ? 2 : 0) + (lead.rawDescription?.length ?? 0) / 1000;
    if (currentScore > existingScore) seen.set(key, lead);
  }

  return Array.from(seen.values());
}
