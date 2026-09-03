/**
 * IZVOR 2 — STAMBENE ZAJEDNICE i PROFESIONALNI UPRAVNICI.
 *
 * Najvredniji B2B lead u celoj mašini. Razlog je prost: jedan profesionalni
 * upravnik drži 20-80 zgrada. Kad uđeš kod njega, dobijaš ponavljajuće poslove
 * (krečenje hodnika, sanacija vlage u podrumu, zamena vertikale) godinama,
 * bez ijednog dinara daljeg marketinga. Ostali leadovi su jednokratni — ovaj nije.
 *
 * KAKO SE DOLAZI DO NJIH (sve besplatno):
 *   A) Google Maps: "profesionalni upravnik zgrade Vračar" — agencije su upisane
 *      kao firme, sa telefonom. Ovo radi odmah, bez podešavanja.
 *   B) Javni registri/direktorijumi: opštinski registri stambenih zajednica i
 *      liste licenciranih upravnika. Nemaju jedinstven URL na nivou grada, pa se
 *      linkovi zadaju kroz `REGISTAR_SZ_URLS` (zarezom odvojeno).
 *
 * Ako B nije podešen, izvor tiho pada na A i mašina i dalje radi.
 */

import type { Page } from 'playwright';
import { isAllowedByRobots, looksBlocked } from '../browser';
import { RICH_ZONES, type RichZoneId } from '../../config/zones';
import type { Craft } from '../../config/categories';
import type { RawLead } from '../../types/lead';
import { createLogger } from '../../utils/logger';
import { humanDelay } from '../../utils/rateLimiter';
import { extractLeadsFromText } from '../../ai/aiEngine';
import { extractPhones } from '../../utils/phoneUtils';
import { scrapeGoogleMaps } from './googleMaps';

const log = createLogger('scraper:registar');

/** Upiti kojima se na Maps-u love upravnici i firme za održavanje zgrada. */
const MANAGER_QUERIES = [
  'profesionalni upravnik zgrade',
  'upravnik stambene zajednice',
  'upravljanje zgradama',
  'održavanje stambenih zgrada',
  'agencija za upravljanje nekretninama',
];

export interface RegistarScrapeOptions {
  craft: Craft;
  zoneId: RichZoneId;
  /** Dodatni URL-ovi registara/direktorijuma. Ako je prazno, čita se REGISTAR_SZ_URLS. */
  seedUrls?: string[];
  maxPerQuery?: number;
}

export async function scrapeRegistarSZ(page: Page, opts: RegistarScrapeOptions): Promise<RawLead[]> {
  const zone = RICH_ZONES[opts.zoneId];
  const results: RawLead[] = [];

  // --- A) Maps put: uvek radi, bez podešavanja ---
  const viaMaps = await scrapeGoogleMaps(page, {
    craft: opts.craft,
    zoneId: opts.zoneId,
    queries: MANAGER_QUERIES.map((q) => `${q} ${zone.label} Beograd`),
    maxPerQuery: opts.maxPerQuery ?? 15,
    maxDetails: 12,
    maxAnchors: 1,
  });
  results.push(...viaMaps.map((lead) => ({ ...lead, source: 'registar_sz' as const })));

  // --- B) Registri/direktorijumi, ako su podešeni ---
  const seeds = opts.seedUrls ?? (process.env.REGISTAR_SZ_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);

  for (const url of seeds) {
    if (!(await isAllowedByRobots(url))) {
      log.warn('robots.txt zabranjuje ovaj URL — preskačem', { url });
      continue;
    }

    try {
      log.info('čitam registar', { url });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await humanDelay(1500, 3200);

      if (await looksBlocked(page)) {
        log.warn('registar nas blokira — preskačem', { url });
        continue;
      }

      // 1) Prvo pokušavamo strukturirano čitanje tabele (registri su skoro uvek tabele).
      const rows = await readTableRows(page);
      if (rows.length > 0) {
        log.info(`tabela pročitana: ${rows.length} redova`, { url });
        results.push(...rows.map((row) => rowToLead(row, opts, url)).filter((l): l is RawLead => l !== null));
        continue;
      }

      // 2) Ako nije tabela — LLM čita tekst stranice.
      const text = (await page.textContent('main')) ?? (await page.textContent('body')) ?? '';
      const viaLlm = await extractLeadsFromText(text, {
        craft: opts.craft,
        zoneId: opts.zoneId,
        source: 'registar_sz',
        sourceUrl: url,
        sourceLabel: 'Registar stambenih zajednica / direktorijum upravnika',
      });
      results.push(...viaLlm);
    } catch (error) {
      log.error('registar nije pročitan', { url, error: String(error).slice(0, 200) });
    }
  }

  log.info(`stambene zajednice ukupno: ${results.length}`, { zone: zone.label });
  return results;
}

interface TableRow {
  cells: string[];
  text: string;
}

/** Generičko čitanje HTML tabele — radi na većini opštinskih registara. */
async function readTableRows(page: Page): Promise<TableRow[]> {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const out: { cells: string[]; text: string }[] = [];

    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
      if (rows.length < 2) continue;

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'))
          .map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (cells.length < 2) continue;
        out.push({ cells, text: cells.join(' | ') });
      }
    }
    return out.slice(0, 300);
  });
}

/** Red tabele -> RawLead. Kolone se razlikuju po opštini, pa gađamo heuristikom. */
function rowToLead(row: TableRow, opts: RegistarScrapeOptions, sourceUrl: string): RawLead | null {
  const phones = extractPhones(row.text);
  const phone = phones[0] ?? null;

  // Adresa: ćelija koja sadrži broj i tipičnu oznaku ulice.
  const addressCell =
    row.cells.find((c) => /\d+/.test(c) && /(ulica|ul\.|bulevar|bul\.|trg|blok)/i.test(c)) ??
    row.cells.find((c) => /^[^\d]{3,}\s+\d+[a-z]?$/i.test(c)) ??
    null;

  // Naziv: prva ćelija koja nije adresa, telefon ni čist broj (matični broj).
  const nameCell =
    row.cells.find((c) => c !== addressCell && c.length > 4 && !/^\d+$/.test(c) && !phones.some((p) => c.includes(p.national.slice(-6)))) ??
    row.cells[0] ??
    null;

  if (!nameCell) return null;

  return {
    source: 'registar_sz',
    sourceUrl,
    name: nameCell,
    rawAddress: addressCell,
    rawPhone: phone?.e164 ?? null,
    rawCategory: 'Stambena zajednica',
    rawDescription: row.text.slice(0, 800),
    craft: opts.craft,
    targetZone: opts.zoneId,
    scrapedAt: new Date().toISOString(),
  };
}
