/**
 * RADAR POTRAŽNJE — ljudi koji su NAPISALI da im treba majstor.
 *
 * Ovo je suprotno od svega ostalog u mašini. Ostali izvori traže firme sa
 * parama pa ti hladno zoveš. Ovaj traži nekoga ko je već negde objavio da mu
 * treba gipsar — dakle potreba postoji SADA i ti samo stigneš prvi.
 *
 * Tok:
 *   Google veb pretraga tačnih fraza  ->  filter namere (traži vs nudi)
 *   ->  otvaranje najboljih rezultata  ->  telefon iz teksta stranice
 *
 * Najveći deo posla radi `classifyIntent`: bez njega su 9 od 10 rezultata
 * majstori koji reklamiraju sebe.
 */

import type { Page } from 'playwright';
import { acceptConsent, humanScroll, looksBlocked, isAllowedByRobots } from '../browser';
import { buildDemandQueries, googleSearchUrl, type Freshness } from '../../config/demandQueries';
import { RICH_ZONES, type RichZoneId } from '../../config/zones';
import type { Craft } from '../../config/categories';
import type { RawLead } from '../../types/lead';
import { classifyIntent, freshnessBonus } from '../../scoring/intent';
import { extractPhones } from '../../utils/phoneUtils';
import { createLogger } from '../../utils/logger';
import { humanDelay, randomBetween, sleep } from '../../utils/rateLimiter';
import { createDeadline, type Deadline } from '../../utils/deadline';
import { squash } from '../../utils/text';

const log = createLogger('scraper:potraznja');

export interface DemandScrapeOptions {
  craft: Craft;
  /** Ako se izostavi, traži se po celom Beogradu (šire, ali manje precizno). */
  zoneId?: RichZoneId;
  /** Koliko star oglas još uzimamo. Podrazumevano mesec dana. */
  freshness?: Freshness;
  /** Koliko upita iz paketa. */
  maxQueries?: number;
  /** Koliko rezultata otvaramo radi telefona (otvaranje je sporo). */
  maxOpen?: number;
  deadline?: Deadline;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
}

export async function scrapeDemandRadar(page: Page, opts: DemandScrapeOptions): Promise<RawLead[]> {
  const zone = opts.zoneId ? RICH_ZONES[opts.zoneId] : null;
  const queries = buildDemandQueries(opts.craft, zone?.label, opts.maxQueries ?? 10);
  const freshness = opts.freshness ?? 'mesec';
  const maxOpen = opts.maxOpen ?? 8;
  const deadline = opts.deadline ?? createDeadline();

  const results: RawLead[] = [];
  const seenUrls = new Set<string>();
  let opened = 0;

  log.info(`radar potražnje: ${queries.length} upita`, {
    zanat: opts.craft,
    zona: zone?.label ?? 'ceo Beograd',
    svezina: freshness,
  });

  for (const dq of queries) {
    if (!deadline.hasRoomFor(30_000)) {
      log.warn('budžet potrošen — prekidam radar', { skupljeno: results.length });
      break;
    }

    const url = googleSearchUrl(dq.query, freshness);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await acceptConsent(page);
      await humanDelay(900, 2200);

      if (await looksBlocked(page)) {
        log.warn('Google blokira pretragu — pauza i dalje');
        if (!deadline.hasRoomFor(200_000)) break;
        await sleep(randomBetween(120_000, 240_000));
        continue;
      }

      await humanScroll(page, 'body', 2);
      const hits = await collectSearchHits(page);
      log.info(`${hits.length} rezultata`, { upit: dq.query.slice(0, 60) });

      for (const hit of hits) {
        if (seenUrls.has(hit.url)) continue;
        seenUrls.add(hit.url);

        const tekst = `${hit.title}. ${hit.snippet}`;
        const namera = classifyIntent(tekst);

        // Ovde se odbacuje konkurencija — najvažniji filter u celom radaru.
        if (namera.intent === 'OFFERING') continue;
        if (namera.intent === 'UNCLEAR' && dq.kind === 'opšte') continue;

        const svezina = freshnessBonus(hit.snippet);
        const telefoniIzSnippeta = extractPhones(tekst);

        let opis = hit.snippet;
        let telefon = telefoniIzSnippeta[0]?.e164 ?? null;

        // Bez telefona lead ne vredi — otvaramo stranicu da ga nađemo.
        if (!telefon && opened < maxOpen && deadline.hasRoomFor(20_000)) {
          opened++;
          const detalji = await openListing(page, hit.url);
          if (detalji) {
            telefon = detalji.telefon;
            opis = detalji.tekst || opis;
            // Puni tekst stranice zna da promeni sliku — proveravamo nameru ponovo.
            if (classifyIntent(detalji.tekst).intent === 'OFFERING') continue;
          }
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await humanDelay(700, 1800);
        }

        results.push({
          source: 'potraznja',
          sourceUrl: hit.url,
          name: hit.title.slice(0, 180) || 'Oglas bez naslova',
          rawAddress: zone?.label ?? 'Beograd',
          rawPhone: telefon,
          rawCategory: `Potražnja — ${dq.kind}`,
          rawDescription: squash(`${opis} | ${namera.explanation} | svežina: ${svezina.days ?? '?'} dana`, 1500),
          craft: opts.craft,
          targetZone: opts.zoneId ?? 'vracar',
          scrapedAt: new Date().toISOString(),
          meta: {
            website: hit.displayUrl,
            intent: namera.intent,
            intentScore: namera.score,
            freshnessDays: svezina.days,
            sourceKind: dq.kind,
          },
        });
      }

      await humanDelay(4000, 9000);
    } catch (error) {
      log.error('upit pao', { upit: dq.query.slice(0, 50), error: String(error).slice(0, 160) });
      await humanDelay(3000, 7000);
    }
  }

  log.info(`radar ukupno: ${results.length} objava sa potražnjom`, { otvoreno: opened });
  return results;
}

/**
 * Čita organske rezultate Google pretrage.
 * Google menja klase, pa gađamo strukturu (h3 unutar linka) umesto imena klasa —
 * to preživi mnogo više promena.
 */
async function collectSearchHits(page: Page): Promise<SearchHit[]> {
  return page.evaluate(() => {
    const out: { title: string; url: string; snippet: string; displayUrl: string }[] = [];
    const naslovi = Array.from(document.querySelectorAll('a h3'));

    for (const h3 of naslovi) {
      const link = h3.closest('a') as HTMLAnchorElement | null;
      if (!link?.href) continue;
      if (link.href.includes('google.com/')) continue;

      // Kontejner rezultata — penjemo se dok ne nađemo blok sa opisom
      let blok: HTMLElement | null = link.parentElement;
      for (let i = 0; i < 5 && blok; i++) {
        if (blok.innerText && blok.innerText.length > (h3.textContent ?? '').length + 40) break;
        blok = blok.parentElement;
      }

      const ceoTekst = (blok?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const naslov = (h3.textContent ?? '').trim();
      const snippet = ceoTekst.replace(naslov, '').trim().slice(0, 600);

      out.push({
        title: naslov,
        url: link.href,
        snippet,
        displayUrl: link.hostname,
      });
    }

    return out.slice(0, 20);
  });
}

/** Otvara oglas i vadi telefon iz teksta stranice. */
async function openListing(page: Page, url: string): Promise<{ telefon: string | null; tekst: string } | null> {
  if (!(await isAllowedByRobots(url))) {
    log.debug('robots.txt zabranjuje — ne otvaram', { url: url.slice(0, 70) });
    return null;
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await humanDelay(800, 2000);

    // Mnogi oglasnici kriju broj iza dugmeta "Prikaži broj".
    for (const label of ['Prikaži broj', 'Prikazi broj', 'Prikaži kontakt', 'Pozovi', 'Prikaži telefon']) {
      try {
        const dugme = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
        if (await dugme.isVisible({ timeout: 1200 })) {
          await dugme.click({ timeout: 2500 });
          await humanDelay(600, 1400);
          break;
        }
      } catch {
        /* nema dugmeta — nastavi */
      }
    }

    const tekst = (await page.textContent('main')) ?? (await page.textContent('body')) ?? '';
    const ocisceno = squash(tekst, 4000);
    const telefoni = extractPhones(ocisceno);

    return { telefon: telefoni[0]?.e164 ?? null, tekst: ocisceno };
  } catch (error) {
    log.debug('oglas nije otvoren', { error: String(error).slice(0, 100) });
    return null;
  }
}
