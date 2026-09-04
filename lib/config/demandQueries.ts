/**
 * RADAR POTRAŽNJE — upiti kojima se love ljudi koji TRAŽE majstora.
 *
 * Zašto Google veb pretraga a ne pojedinačni oglasnici:
 *   1. Jedan izvor pokriva sve — oglasnike, forume, javno vidljive objave,
 *      sajtove stambenih zajednica, portale nabavki. Ne moraš da održavaš
 *      deset skrepera koji svaki mesec pucaju.
 *   2. Google već ima filter svežine (`tbs=qdr:`) — a kod potražnje je svežina
 *      sve. Oglas star mesec dana je skoro sigurno rešen.
 *   3. Radi bez naloga i bez logina, za razliku od Facebook grupa.
 *
 * Navodnici u upitu su OBAVEZNI: bez njih Google vrati sve što sadrži te reči
 * bilo gde, a sa njima traži tačnu frazu — što je razlika između 300 reklama
 * majstora i 5 pravih poslova.
 */

import type { Craft } from './categories';

/** Kako se svaki zanat traži u srpskom govoru. */
const CRAFT_TERMS: Record<Craft, { nominativ: string[]; akuzativ: string[]; posao: string[] }> = {
  gipsar: {
    nominativ: ['gipsar', 'majstor za gips', 'knauf majstor'],
    akuzativ: ['gipsara', 'majstora za gips'],
    posao: ['spuštanje plafona', 'spušten plafon', 'pregradni zid', 'gipsani radovi', 'knauf'],
  },
  moler: {
    nominativ: ['moler', 'majstor za krečenje'],
    akuzativ: ['molera', 'majstora za krečenje'],
    posao: ['krečenje stana', 'gletovanje', 'moleraj', 'farbanje zidova', 'krečenje hodnika'],
  },
  vodoinstalater: {
    nominativ: ['vodoinstalater', 'majstor za vodu'],
    akuzativ: ['vodoinstalatera', 'majstora za vodu'],
    posao: ['pukla cev', 'curi voda', 'zapušena kanalizacija', 'zamena vertikale', 'renoviranje kupatila'],
  },
};

/**
 * Padez je ovde bitan kao i sve ostalo. "potreban moler" je ispravno,
 * "potreban molera" nije i vraca NULA rezultata. Zato su obrasci razdvojeni
 * po padezu koji traze, umesto da se slepo mnoze sa imenicama.
 */
const NOMINATIV_PATTERNS = ['potreban', 'hitno potreban', 'traži se'];
const AKUZATIV_PATTERNS = ['tražim', 'preporuka za', 'tražim dobrog'];
/**
 * Oglasnici i portali vredni ciljanja preko `site:`.
 * Ovim zaobilazimo njihove pretrage i anti-bot zaštite — Google je već ušao
 * umesto nas i indeksirao sadržaj.
 */
export const TARGET_SITES: readonly { domain: string; label: string; note: string }[] = [
  { domain: 'kupujemprodajem.com', label: 'KupujemProdajem', note: 'najveći oglasnik, sekcija Usluge' },
  { domain: 'halooglasi.com', label: 'Halo oglasi', note: 'usluge i nekretnine' },
  { domain: 'oglasi.rs', label: 'Oglasi.rs', note: 'opšti oglasnik' },
  { domain: 'nekretnine.rs', label: 'Nekretnine.rs', note: 'stanovi pred useljenje' },
  { domain: 'forum.krstarica.com', label: 'Krstarica forum', note: 'pitanja tipa "ko zna majstora"' },
  { domain: 'jnportal.ujn.gov.rs', label: 'Portal javnih nabavki', note: 'zvanični konkursi sa budžetom' },
  { domain: 'nabavke.beograd.gov.rs', label: 'Nabavke Grada Beograda', note: 'gradski konkursi' },
];

export interface DemandQuery {
  /** Ceo upit koji ide u Google. */
  query: string;
  /** Odakle očekujemo rezultate — samo za izveštaj. */
  kind: 'opšte' | 'oglasnik' | 'nabavka' | 'forum';
  /** Bazni prioritet 0-1 — nabavke su najtvrđi dokaz da posao postoji. */
  weight: number;
}

/**
 * Gradi paket upita za jedan zanat i (opciono) jednu zonu.
 *
 * @param craft   zanat
 * @param zone    naziv zone; ako se izostavi, traži se po celom Beogradu
 * @param limit   koliko upita najviše (radar je skup — svaki upit je jedna pretraga)
 */
export function buildDemandQueries(craft: Craft, zone?: string, limit = 14): DemandQuery[] {
  const terms = CRAFT_TERMS[craft];
  const mesto = zone ? `${zone} Beograd` : 'Beograd';
  const out: DemandQuery[] = [];

  // 1. Direktna potražnja — svaki obrazac sa imenicom u PRAVOM padežu
  for (const pattern of NOMINATIV_PATTERNS) {
    for (const imenica of terms.nominativ.slice(0, 2)) {
      out.push({ query: `"${pattern} ${imenica}" ${mesto}`, kind: 'opšte', weight: 0.9 });
    }
  }
  for (const pattern of AKUZATIV_PATTERNS) {
    for (const imenica of terms.akuzativ.slice(0, 2)) {
      out.push({ query: `"${pattern} ${imenica}" ${mesto}`, kind: 'opšte', weight: 0.9 });
    }
  }

  // 2. Opis posla — "treba mi spuštanje plafona"
  for (const posao of terms.posao.slice(0, 3)) {
    out.push({ query: `"treba mi ${posao}" ${mesto}`, kind: 'opšte', weight: 0.85 });
  }

  // 3. Oglasnici preko site: — Google je već ušao umesto nas
  for (const site of TARGET_SITES.slice(0, 3)) {
    out.push({
      query: `site:${site.domain} "${NOMINATIV_PATTERNS[0]} ${terms.nominativ[0]}"`,
      kind: 'oglasnik',
      weight: 0.95,
    });
  }

  // 4. Javne nabavke — najtvrđi dokaz: postoji budžet, rok i papir
  const nabavkaTermin =
    craft === 'moler'
      ? 'molersko farbarski radovi'
      : craft === 'gipsar'
        ? 'gipsarski radovi'
        : 'vodoinstalaterski radovi';
  out.push({ query: `site:jnportal.ujn.gov.rs "${nabavkaTermin}"`, kind: 'nabavka', weight: 1 });
  out.push({ query: `"${nabavkaTermin}" "javni poziv" Beograd`, kind: 'nabavka', weight: 1 });

  // 5. Stambene zajednice — ponavljajući poslovi
  out.push({ query: `"stambena zajednica" "prikuplja ponude" ${nabavkaTermin} Beograd`, kind: 'nabavka', weight: 0.95 });

  // 6. Forumi — tu se pita za preporuku, a preporuka je najtopliji lead
  out.push({ query: `"preporuka za ${terms.akuzativ[0]}" ${mesto}`, kind: 'forum', weight: 0.8 });

  return out.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/**
 * Google filter svežine. Kod potražnje je ovo najvažniji parametar:
 * oglas star dva meseca je posao koji je neko drugi već uzeo.
 */
export type Freshness = 'dan' | 'nedelja' | 'mesec' | 'godina' | 'bilo kada';

export function freshnessParam(freshness: Freshness): string {
  switch (freshness) {
    case 'dan':
      return 'qdr:d';
    case 'nedelja':
      return 'qdr:w';
    case 'mesec':
      return 'qdr:m';
    case 'godina':
      return 'qdr:y';
    default:
      return '';
  }
}

/** URL Google veb pretrage (ne Maps) sa filterom svežine i srpskim jezikom. */
export function googleSearchUrl(query: string, freshness: Freshness = 'mesec', page = 0): string {
  const params = new URLSearchParams({
    q: query,
    hl: 'sr',
    gl: 'rs',
    num: '20',
  });
  const tbs = freshnessParam(freshness);
  if (tbs) params.set('tbs', tbs);
  if (page > 0) params.set('start', String(page * 20));
  return `https://www.google.com/search?${params.toString()}`;
}
