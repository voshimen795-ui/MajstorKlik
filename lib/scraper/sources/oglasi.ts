/**
 * IZVOR 3 — OGLASI ZA LUX NEKRETNINE (B2C sa rokom).
 *
 * Logika leada: stan od 250.000€ na Vračaru koji se prodaje ili izdaje MORA da
 * izgleda useljivo. Vlasnik zna da mu 1.500€ uloženih u gletovanje i gips vrati
 * 5.000€ na ceni ili mu skrati prodaju za tri nedelje. Zato je ovo jedini B2C
 * segment koji ne cenjka — ima rok i ima računicu.
 *
 * VAŽNO, pročitaj pre puštanja u rad:
 *  - Oglasnici u pravilu ZABRANJUJU automatsko preuzimanje sadržaja svojim uslovima
 *    korišćenja, a brojevi fizičkih lica su podaci o ličnosti (ZZPL/GDPR).
 *    Zato je ovaj izvor PODRAZUMEVANO ISKLJUČEN (`OGLASI_ENABLED != 'true'`) i
 *    poštuje robots.txt osim ako to izričito ne isključiš.
 *  - Preporučen način rada: cilja se na oglase koje su postavile AGENCIJE
 *    (poslovni kontakt, ne fizičko lice) — `OGLASI_ONLY_AGENCIES=true`.
 *  - Selektori ispod su šablon. Sajtovi menjaju strukturu; kad se to desi,
 *    skreper ne puca nego pušta LLM da pročita tekst stranice.
 */

import type { Page } from 'playwright';
import { isAllowedByRobots, humanScroll, looksBlocked } from '../browser';
import { RICH_ZONES, type RichZoneId } from '../../config/zones';
import type { Craft } from '../../config/categories';
import type { RawLead } from '../../types/lead';
import { createLogger } from '../../utils/logger';
import { humanDelay } from '../../utils/rateLimiter';
import { extractLeadsFromText } from '../../ai/aiEngine';
import { extractPhones } from '../../utils/phoneUtils';
import { normalizeSr } from '../../utils/text';
import { createDeadline, type Deadline } from '../../utils/deadline';

const log = createLogger('scraper:oglasi');

export interface ListingSourceConfig {
  id: string;
  label: string;
  /** Funkcija koja gradi URL pretrage za zonu. */
  buildUrl: (params: { zoneQuery: string; minPriceEur: number; page: number }) => string;
  /** CSS selektori — proveri ih pre prve upotrebe, sajtovi ih menjaju. */
  selectors: {
    card: string;
    title: string;
    price: string;
    location: string;
    link: string;
  };
}

/**
 * Šabloni izvora. Namerno se čitaju iz env-a (`OGLASI_SOURCES` kao JSON),
 * da bi mogao da menjaš ciljeve bez diranja koda.
 */
const BUILTIN_SOURCES: ListingSourceConfig[] = [
  {
    id: 'generic-search',
    label: 'Generički oglasnik (podesi OGLASI_BASE_URL)',
    buildUrl: ({ zoneQuery, page }) => {
      const base = process.env.OGLASI_BASE_URL ?? '';
      if (!base) return '';
      return base.replace('{zona}', encodeURIComponent(zoneQuery)).replace('{strana}', String(page));
    },
    selectors: {
      card: process.env.OGLASI_SEL_CARD ?? 'article, .product-item, .listing-item, li[class*="ad"]',
      title: process.env.OGLASI_SEL_TITLE ?? 'h2, h3, .title, [class*="title"]',
      price: process.env.OGLASI_SEL_PRICE ?? '[class*="price"], [class*="cena"]',
      location: process.env.OGLASI_SEL_LOCATION ?? '[class*="location"], [class*="lokacija"], address',
      link: process.env.OGLASI_SEL_LINK ?? 'a[href]',
    },
  },
];

function loadSources(): ListingSourceConfig[] {
  const raw = process.env.OGLASI_SOURCES;
  if (!raw) return BUILTIN_SOURCES;
  try {
    const parsed = JSON.parse(raw) as {
      id: string;
      label: string;
      urlTemplate: string;
      selectors: ListingSourceConfig['selectors'];
    }[];
    return parsed.map((s) => ({
      id: s.id,
      label: s.label,
      buildUrl: ({ zoneQuery, minPriceEur, page }) =>
        s.urlTemplate
          .replace('{zona}', encodeURIComponent(zoneQuery))
          .replace('{cena}', String(minPriceEur))
          .replace('{strana}', String(page)),
      selectors: s.selectors,
    }));
  } catch (error) {
    log.error('OGLASI_SOURCES nije validan JSON — koristim ugrađene šablone', { error: String(error).slice(0, 160) });
    return BUILTIN_SOURCES;
  }
}

export interface OglasiScrapeOptions {
  craft: Craft;
  zoneId: RichZoneId;
  /** Minimalna cena u EUR — filter za "ima para". */
  minPriceEur?: number;
  /** Koliko strana rezultata po izvoru. */
  maxPages?: number;
  maxPerPage?: number;
  deadline?: Deadline;
}

export async function scrapeOglasi(page: Page, opts: OglasiScrapeOptions): Promise<RawLead[]> {
  if (process.env.OGLASI_ENABLED !== 'true') {
    log.warn('izvor "oglasi" je isključen (OGLASI_ENABLED != true) — preskačem');
    return [];
  }

  const zone = RICH_ZONES[opts.zoneId];
  const minPriceEur = opts.minPriceEur ?? Number(process.env.OGLASI_MIN_PRICE_EUR ?? 150_000);
  const maxPages = opts.maxPages ?? 2;
  const maxPerPage = opts.maxPerPage ?? 20;
  const onlyAgencies = process.env.OGLASI_ONLY_AGENCIES !== 'false';
  const deadline = opts.deadline ?? createDeadline();

  const results: RawLead[] = [];

  for (const source of loadSources()) {
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (!deadline.hasRoomFor(30_000)) {
        log.warn('vremenski budžet potrošen — prekidam oglase', { skupljeno: results.length });
        return results;
      }
      const url = source.buildUrl({ zoneQuery: zone.label, minPriceEur, page: pageNum });
      if (!url) {
        log.warn('izvor nema podešen URL — preskačem', { source: source.id });
        break;
      }
      if (!(await isAllowedByRobots(url))) {
        log.warn('robots.txt zabranjuje pretragu — preskačem izvor', { source: source.id, url });
        break;
      }

      try {
        log.info('otvaram oglase', { source: source.id, strana: pageNum });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await humanDelay(1800, 3800);

        if (await looksBlocked(page)) {
          log.warn('oglasnik nas blokira — prekidam izvor', { source: source.id });
          break;
        }

        await humanScroll(page, 'body', 5);

        const cards = await readCards(page, source, maxPerPage);
        if (cards.length === 0) {
          const text = (await page.textContent('main')) ?? (await page.textContent('body')) ?? '';
          const viaLlm = await extractLeadsFromText(text, {
            craft: opts.craft,
            zoneId: opts.zoneId,
            source: 'oglasi',
            sourceUrl: url,
            sourceLabel: `Oglasi za nekretnine — ${source.label}`,
          });
          results.push(...viaLlm.map((l) => ({ ...l, meta: { ...l.meta, listingType: null } })));
          continue;
        }

        for (const card of cards) {
          const priceEur = parsePrice(card.price);
          if (priceEur !== null && priceEur < minPriceEur) continue;
          if (onlyAgencies && !looksLikeAgency(card.text)) continue;

          const phones = extractPhones(card.text);
          results.push({
            source: 'oglasi',
            sourceUrl: card.href || url,
            name: card.title || 'Oglas za nekretninu',
            rawAddress: card.location || zone.label,
            rawPhone: phones[0]?.e164 ?? null,
            rawCategory: 'Oglas — nekretnina',
            rawDescription: card.text.slice(0, 1200),
            craft: opts.craft,
            targetZone: opts.zoneId,
            scrapedAt: new Date().toISOString(),
            meta: {
              priceEur,
              areaM2: parseArea(card.text),
              listingType: /izdav|renta|rent/i.test(card.text) ? 'izdavanje' : 'prodaja',
            },
          });
        }

        await humanDelay(4000, 9000);
      } catch (error) {
        log.error('greška pri čitanju oglasa', { source: source.id, error: String(error).slice(0, 200) });
        break;
      }
    }
  }

  log.info(`oglasi ukupno: ${results.length}`, { zone: zone.label });
  return results;
}

interface ListingCard {
  title: string;
  price: string;
  location: string;
  href: string;
  text: string;
}

async function readCards(page: Page, source: ListingSourceConfig, limit: number): Promise<ListingCard[]> {
  return page.evaluate(
    ({ sel, max }) => {
      const pick = (root: Element, selector: string): string => {
        const el = root.querySelector(selector);
        return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
      };

      return Array.from(document.querySelectorAll(sel.card))
        .slice(0, max)
        .map((card) => {
          const linkEl = card.querySelector(sel.link) as HTMLAnchorElement | null;
          return {
            title: pick(card, sel.title),
            price: pick(card, sel.price),
            location: pick(card, sel.location),
            href: linkEl?.href ?? '',
            text: (card.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500),
          };
        })
        .filter((c) => c.title.length > 3);
    },
    { sel: source.selectors, max: limit },
  );
}

/** "250.000 €" / "1.200 EUR mesečno" -> broj */
function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "78 m2" / "120m²" -> 78 */
function parseArea(text: string): number | null {
  const match = text.match(/(\d{2,4})\s?m\s?[²2]/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/**
 * Filter "agencija, ne fizičko lice" — držimo se poslovnih kontakata.
 * Time izbegavamo i pravni rizik i najgori tip leada (vlasnik koji cenjka svaki dinar).
 */
function looksLikeAgency(text: string): boolean {
  const n = normalizeSr(text);
  return [
    'agencija', 'agencije', 'posrednik', 'nekretnine doo', 'real estate', 'd.o.o', 'doo',
    'licencirani posrednik', 'pib', 'agent', 'kancelarija',
  ].some((token) => n.includes(normalizeSr(token)));
}
