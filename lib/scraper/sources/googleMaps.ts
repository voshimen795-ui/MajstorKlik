/**
 * IZVOR 1 — Google Maps (B2B objekti u premium zonama).
 *
 * Ovo je najbogatiji besplatan izvor: naziv, adresa, TELEFON, kategorija,
 * sajt, broj recenzija — sve na jednom mestu, i sve javno vidljivo.
 *
 * Dve tehnike koje sve rešavaju:
 *   1. GEO ANKER u URL-u (`/@lat,lng,zoom`) — bez njega Maps vrati rezultate iz
 *      cele Srbije i "Vračar" filter ti ne znači ništa.
 *   2. `data-item-id="phone:tel:+381..."` na dugmetu telefona — Google tu već
 *      drži broj u E.164 formatu, pa ga uzimamo direktno umesto da parsiramo tekst.
 *
 * Ako Google promeni klase (dešava se par puta godišnje), skreper ne puca —
 * pada na `extractLeadsFromText` i pušta LLM da pročita tekst stranice.
 */

import type { Page } from 'playwright';
import { acceptConsent, humanMouse, humanScroll, looksBlocked } from '../browser';
import { anchorsFor, mapsSearchUrl, RICH_ZONES, type RichZoneId } from '../../config/zones';
import { buildQueryPack, type Craft } from '../../config/categories';
import type { RawLead } from '../../types/lead';
import { createLogger } from '../../utils/logger';
import { humanDelay, randomBetween, sleep } from '../../utils/rateLimiter';
import { extractLeadsFromText } from '../../ai/aiEngine';

const log = createLogger('scraper:maps');

export interface MapsScrapeOptions {
  craft: Craft;
  zoneId: RichZoneId;
  /** Ako ne prosediš, gradimo ih iz `buildQueryPack` (svi relevantni tipovi objekata). */
  queries?: string[];
  /** Koliko kartica maksimalno po jednom upitu. */
  maxPerQuery?: number;
  /** Koliko kartica otvaramo radi telefona (otvaranje je sporo i "skuplje" kod Google-a). */
  maxDetails?: number;
  /** Koliko ankera (kvartova) iz zone obilazimo. */
  maxAnchors?: number;
}

interface CardSnapshot {
  name: string;
  href: string;
  rating: number | null;
  reviews: number | null;
  category: string | null;
  addressHint: string | null;
  info: string;
}

export async function scrapeGoogleMaps(page: Page, opts: MapsScrapeOptions): Promise<RawLead[]> {
  const zone = RICH_ZONES[opts.zoneId];
  const queries = opts.queries ?? buildQueryPack(opts.craft, zone.label);
  const anchors = anchorsFor(opts.zoneId).slice(0, opts.maxAnchors ?? 2);
  const maxPerQuery = opts.maxPerQuery ?? 20;
  const maxDetails = opts.maxDetails ?? 12;

  const results: RawLead[] = [];
  const seenHrefs = new Set<string>();

  for (const query of queries) {
    for (const anchor of anchors) {
      const url = mapsSearchUrl(query, anchor);
      log.info('pretraga', { query, anchor: anchor.label });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await acceptConsent(page);
        await humanDelay(1200, 2600);

        if (await looksBlocked(page)) {
          log.warn('Google nas je blokirao — pauza 3-6 min i prelazak na sledeći upit');
          await sleep(randomBetween(180_000, 360_000));
          continue;
        }

        const feed = page.locator('div[role="feed"]');
        try {
          await feed.waitFor({ state: 'visible', timeout: 12_000 });
        } catch {
          // Nema liste — verovatno je Maps otvorio JEDAN objekat direktno.
          const single = await extractDetail(page, opts, url);
          if (single) results.push(single);
          continue;
        }

        await humanMouse(page);
        await humanScroll(page, 'div[role="feed"]', randomBetween(4, 9));

        const cards = await collectCards(page, maxPerQuery);
        log.info(`pronađeno ${cards.length} kartica`, { query, anchor: anchor.label });

        if (cards.length === 0) {
          // DOM se promenio — puštamo LLM na tekst stranice.
          const fallback = await llmFallback(page, opts, url);
          results.push(...fallback);
          continue;
        }

        let opened = 0;
        for (const card of cards) {
          if (seenHrefs.has(card.href)) continue;
          seenHrefs.add(card.href);

          // Bez telefona lead ne vredi ništa — zato otvaramo detalje za prvih N.
          if (opened < maxDetails) {
            opened++;
            const detail = await openDetail(page, card, opts);
            if (detail) {
              results.push(detail);
              await humanDelay(1400, 3600); // pauza između otvaranja kartica
              continue;
            }
          }

          // Ostale zapisujemo bez telefona — AI ih ionako odbaci, ali imamo trag.
          results.push(cardToLead(card, opts, url));
        }

        await humanDelay(3000, 7000); // pauza između upita
      } catch (error) {
        log.error('greška u pretrazi', { query, anchor: anchor.label, error: String(error).slice(0, 200) });
        await humanDelay(4000, 9000);
      }
    }
  }

  log.info(`Maps ukupno: ${results.length} sirovih leadova`, { zone: zone.label, craft: opts.craft });
  return results;
}

/** Čita kartice iz liste bez otvaranja (brzo, jeftino kod Google-a). */
async function collectCards(page: Page, limit: number): Promise<CardSnapshot[]> {
  return page.evaluate((max) => {
    const out: CardSnapshot[] = [];
    const anchors = Array.from(document.querySelectorAll('a.hfpxzc')) as HTMLAnchorElement[];

    for (const a of anchors.slice(0, max)) {
      const container = a.closest('div.Nv2PK') ?? a.parentElement;
      const text = (container?.textContent ?? '').replace(/\s+/g, ' ').trim();

      const ratingEl = container?.querySelector('.MW4etd');
      const reviewsEl = container?.querySelector('.UY7F9');
      const infoRows = Array.from(container?.querySelectorAll('.W4Efsd') ?? []).map((el) =>
        (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      );

      // Prvi info red je obično "Kategorija · Adresa"
      const firstInfo = infoRows.find((r) => r.includes('·')) ?? '';
      const [categoryRaw, addressRaw] = firstInfo.split('·').map((s) => s.trim());

      out.push({
        name: a.getAttribute('aria-label')?.trim() || (container?.querySelector('.qBF1Pd')?.textContent ?? '').trim(),
        href: a.href,
        rating: ratingEl ? Number.parseFloat((ratingEl.textContent ?? '').replace(',', '.')) || null : null,
        reviews: reviewsEl ? Number.parseInt((reviewsEl.textContent ?? '').replace(/\D/g, ''), 10) || null : null,
        category: categoryRaw || null,
        addressHint: addressRaw || null,
        info: text.slice(0, 600),
      });
    }
    return out.filter((c) => c.name.length > 1);
  }, limit) as Promise<CardSnapshot[]>;
}

/** Otvara karticu i vadi telefon + punu adresu iz panela sa detaljima. */
async function openDetail(page: Page, card: CardSnapshot, opts: MapsScrapeOptions): Promise<RawLead | null> {
  try {
    const link = page.locator(`a.hfpxzc[href="${card.href.replace(/"/g, '\\"')}"]`).first();
    if (await link.count()) {
      await link.scrollIntoViewIfNeeded();
      await humanDelay(300, 900);
      await link.click({ timeout: 8000 });
    } else {
      await page.goto(card.href, { waitUntil: 'domcontentloaded' });
    }

    await page.waitForSelector('h1.DUwDvf, [data-item-id="address"]', { timeout: 10_000 });
    await humanDelay(700, 1800);
    return await extractDetail(page, opts, card.href, card);
  } catch (error) {
    log.debug('detalji nedostupni', { name: card.name, error: String(error).slice(0, 120) });
    return null;
  }
}

/** Čita panel sa detaljima objekta. */
async function extractDetail(
  page: Page,
  opts: MapsScrapeOptions,
  sourceUrl: string,
  card?: CardSnapshot,
): Promise<RawLead | null> {
  const detail = await page.evaluate(() => {
    const txt = (sel: string): string | null => {
      const el = document.querySelector(sel);
      return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() || null : null;
    };

    // Telefon je u atributu — Google ga već drži u E.164 obliku.
    const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
    const phoneFromAttr = phoneBtn?.getAttribute('data-item-id')?.replace('phone:tel:', '') ?? null;
    const phoneFromLabel = phoneBtn?.getAttribute('aria-label')?.replace(/^[^:]*:\s*/, '') ?? null;

    const addressBtn = document.querySelector('button[data-item-id="address"]');
    const address = addressBtn?.getAttribute('aria-label')?.replace(/^[^:]*:\s*/, '') ?? null;

    const websiteEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null;

    const hours = txt('[aria-label*="radno vreme" i]') ?? txt('.t39EBf');
    const reviewsRaw = txt('button[jsaction*="reviewChart"] span') ?? txt('.F7nice span:nth-child(2)');
    const ratingRaw = txt('.F7nice span[aria-hidden="true"]');

    // Ceo tekst panela — koristi se za signale hitnosti ("privremeno zatvoreno", "u renoviranju")
    const panelText = (document.querySelector('div[role="main"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();

    return {
      name: txt('h1.DUwDvf'),
      address,
      phone: phoneFromAttr || phoneFromLabel,
      category: txt('button.DkEaL'),
      website: websiteEl?.href ?? null,
      hours,
      rating: ratingRaw ? Number.parseFloat(ratingRaw.replace(',', '.')) || null : null,
      reviews: reviewsRaw ? Number.parseInt(reviewsRaw.replace(/\D/g, ''), 10) || null : null,
      panelText: panelText.slice(0, 1500),
    };
  });

  const name = detail.name ?? card?.name ?? null;
  if (!name) return null;

  return {
    source: 'google_maps',
    sourceUrl: page.url() || sourceUrl,
    name,
    rawAddress: detail.address ?? card?.addressHint ?? null,
    rawPhone: detail.phone,
    rawCategory: detail.category ?? card?.category ?? null,
    rawDescription: [detail.hours, detail.panelText].filter(Boolean).join(' | ').slice(0, 1800) || card?.info || null,
    craft: opts.craft,
    targetZone: opts.zoneId,
    scrapedAt: new Date().toISOString(),
    meta: {
      rating: detail.rating ?? card?.rating ?? null,
      reviewCount: detail.reviews ?? card?.reviews ?? null,
      website: detail.website,
      openingHours: detail.hours,
    },
  };
}

function cardToLead(card: CardSnapshot, opts: MapsScrapeOptions, sourceUrl: string): RawLead {
  return {
    source: 'google_maps',
    sourceUrl: card.href || sourceUrl,
    name: card.name,
    rawAddress: card.addressHint,
    rawPhone: null,
    rawCategory: card.category,
    rawDescription: card.info,
    craft: opts.craft,
    targetZone: opts.zoneId,
    scrapedAt: new Date().toISOString(),
    meta: { rating: card.rating, reviewCount: card.reviews },
  };
}

/** Kad DOM selektori otkažu — LLM čita tekst stranice. */
async function llmFallback(page: Page, opts: MapsScrapeOptions, url: string): Promise<RawLead[]> {
  log.warn('DOM selektori nisu vratili ništa — prelazim na LLM ekstrakciju');
  try {
    const text = (await page.textContent('div[role="main"]')) ?? (await page.textContent('body')) ?? '';
    return await extractLeadsFromText(text, {
      craft: opts.craft,
      zoneId: opts.zoneId,
      source: 'google_maps',
      sourceUrl: url,
      sourceLabel: 'Google Maps rezultati pretrage',
    });
  } catch {
    return [];
  }
}
