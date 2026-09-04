/**
 * DETEKCIJA NAMERE — traži li neko majstora, ili se sam nudi?
 *
 * Ovo je jedini razlog zašto radar potražnje uopšte može da radi. Ako na
 * oglasniku ukucaš "gipsar Beograd", 90% rezultata su MAJSTORI koji reklamiraju
 * sebe. Bez ovog filtera dobiješ bazu konkurencije umesto baze poslova.
 *
 * Radi deterministički, na frazama, bez AI-ja — jer mora da bude brz (prolazi
 * kroz stotine snippeta) i predvidiv. AI se poziva samo za granične slučajeve.
 */

import { normalizeSr } from '../utils/text';

export type Intent = 'SEEKING' | 'OFFERING' | 'UNCLEAR';

/**
 * "TRAŽI SE" — neko ima potrebu.
 * Težina 3 = fraza koja skoro nikad ne znači ništa drugo.
 */
const SEEKING_PHRASES: readonly { fraza: string; tezina: number }[] = [
  // najjače — direktna potražnja
  { fraza: 'trazim majstora', tezina: 3 },
  { fraza: 'trazim gipsara', tezina: 3 },
  { fraza: 'trazim molera', tezina: 3 },
  { fraza: 'trazim vodoinstalatera', tezina: 3 },
  { fraza: 'potreban majstor', tezina: 3 },
  { fraza: 'potreban gipsar', tezina: 3 },
  { fraza: 'potreban moler', tezina: 3 },
  { fraza: 'potreban vodoinstalater', tezina: 3 },
  { fraza: 'potrebni majstori', tezina: 3 },
  { fraza: 'potrebna je usluga', tezina: 3 },
  { fraza: 'trazi se majstor', tezina: 3 },
  { fraza: 'trazi se izvodjac', tezina: 3 },
  { fraza: 'ko moze da uradi', tezina: 3 },
  { fraza: 'da li neko zna majstora', tezina: 3 },
  { fraza: 'preporuka za majstora', tezina: 3 },
  { fraza: 'preporuku za majstora', tezina: 3 },

  // javne nabavke / konkursi — najtvrđi dokaz da posao postoji
  { fraza: 'javni poziv', tezina: 3 },
  { fraza: 'poziv za podnosenje ponuda', tezina: 3 },
  { fraza: 'javna nabavka', tezina: 3 },
  { fraza: 'konkursna dokumentacija', tezina: 3 },
  { fraza: 'prikupljanje ponuda', tezina: 3 },
  { fraza: 'prikuplja ponude', tezina: 3 },
  { fraza: 'prikupljamo ponude', tezina: 3 },
  { fraza: 'poziva zainteresovane', tezina: 3 },
  { fraza: 'raspisuje', tezina: 2 },
  { fraza: 'skupstina stanara', tezina: 2 },
  { fraza: 'stambena zajednica', tezina: 2 },
  { fraza: 'poziv za dostavljanje ponuda', tezina: 3 },

  // srednje — potreba postoji ali formulacija je šira
  { fraza: 'treba mi', tezina: 2 },
  { fraza: 'trebalo bi mi', tezina: 2 },
  { fraza: 'hitno mi treba', tezina: 3 },
  { fraza: 'angazovao bih', tezina: 2 },
  { fraza: 'angazujem', tezina: 2 },
  { fraza: 'placam', tezina: 2 },
  { fraza: 'nudim posao', tezina: 3 },
  { fraza: 'posao za majstora', tezina: 3 },
  { fraza: 'isplata odmah', tezina: 2 },
  { fraza: 'koliko bi kostalo', tezina: 2 },
  { fraza: 'kolika je cena', tezina: 1 },
  { fraza: 'zainteresovan sam za', tezina: 1 },
  { fraza: 'moze li neko', tezina: 2 },

  // opis posla koji treba uraditi
  { fraza: 'treba okreciti', tezina: 3 },
  { fraza: 'treba gletovati', tezina: 3 },
  { fraza: 'treba spustiti plafon', tezina: 3 },
  { fraza: 'treba zameniti', tezina: 2 },
  { fraza: 'treba sanirati', tezina: 3 },
  { fraza: 'treba adaptirati', tezina: 3 },
  { fraza: 'pukla cev', tezina: 3 },
  { fraza: 'curi voda', tezina: 3 },
  { fraza: 'imam problem sa', tezina: 2 },
];

/**
 * "NUDIM USLUGU" — konkurencija. Ovo su fraze iz reklama majstora.
 */
const OFFERING_PHRASES: readonly { fraza: string; tezina: number }[] = [
  { fraza: 'nudim usluge', tezina: 3 },
  { fraza: 'nudimo usluge', tezina: 3 },
  { fraza: 'vrsim usluge', tezina: 3 },
  { fraza: 'vrsimo usluge', tezina: 3 },
  { fraza: 'izvodimo radove', tezina: 3 },
  { fraza: 'izvodim radove', tezina: 3 },
  { fraza: 'radimo sve vrste', tezina: 3 },
  { fraza: 'radim sve vrste', tezina: 3 },
  { fraza: 'sve vrste radova', tezina: 3 },
  { fraza: 'dugogodisnje iskustvo', tezina: 3 },
  { fraza: 'godina iskustva', tezina: 2 },
  { fraza: 'besplatna procena', tezina: 3 },
  { fraza: 'besplatan izlazak', tezina: 3 },
  { fraza: 'garancija na radove', tezina: 3 },
  { fraza: 'brzo i kvalitetno', tezina: 3 },
  { fraza: 'povoljno i kvalitetno', tezina: 3 },
  { fraza: 'profesionalno i povoljno', tezina: 3 },
  { fraza: 'pozovite nas', tezina: 2 },
  { fraza: 'pozovite me', tezina: 2 },
  { fraza: 'kontaktirajte nas', tezina: 2 },
  { fraza: 'zakazite termin', tezina: 3 },
  { fraza: 'najpovoljnije cene', tezina: 3 },
  { fraza: 'popust', tezina: 2 },
  { fraza: 'akcija', tezina: 1 },
  { fraza: 'majstor sa iskustvom', tezina: 2 },
  { fraza: 'strucno lice', tezina: 2 },
  { fraza: 'nas tim', tezina: 2 },
  { fraza: 'nasa firma', tezina: 2 },
  { fraza: 'agencija za', tezina: 1 },
  { fraza: 'usluge molera', tezina: 3 },
  { fraza: 'usluge gipsara', tezina: 3 },
  { fraza: 'molerski radovi', tezina: 2 },
  { fraza: 'gipsarski radovi', tezina: 1 },
  { fraza: 'radno vreme', tezina: 1 },
  { fraza: 'dolazak na adresu', tezina: 2 },
];

export interface IntentResult {
  intent: Intent;
  /** 0-1 — koliko smo sigurni. */
  confidence: number;
  /** Zbir težina za potražnju minus ponudu. Pozitivno = neko traži. */
  score: number;
  matched: { seeking: string[]; offering: string[] };
  /** Kratko objašnjenje za log i za `reasoning` polje leada. */
  explanation: string;
}

/**
 * Klasifikuje tekst oglasa/objave.
 *
 * @example
 *   classifyIntent('Hitno tražim molera za dvosoban stan na Vračaru')
 *   -> { intent: 'SEEKING', confidence: 0.9, ... }
 *
 *   classifyIntent('Molerski radovi, dugogodišnje iskustvo, besplatna procena')
 *   -> { intent: 'OFFERING', ... }
 */
export function classifyIntent(text: string | null | undefined): IntentResult {
  const haystack = normalizeSr(text);

  if (!haystack || haystack.length < 10) {
    return {
      intent: 'UNCLEAR',
      confidence: 0,
      score: 0,
      matched: { seeking: [], offering: [] },
      explanation: 'nedovoljno teksta za procenu',
    };
  }

  const seeking: string[] = [];
  const offering: string[] = [];
  let score = 0;

  for (const { fraza, tezina } of SEEKING_PHRASES) {
    if (haystack.includes(fraza)) {
      seeking.push(fraza);
      score += tezina;
    }
  }
  for (const { fraza, tezina } of OFFERING_PHRASES) {
    if (haystack.includes(fraza)) {
      offering.push(fraza);
      score -= tezina;
    }
  }

  // Prvo lice množine u reklamnom tonu ("nudimo", "radimo") je jak signal ponude
  // i kad nijedna cela fraza ne pogodi.
  if (/\b(nudimo|radimo|izvodimo|vrsimo|montiramo|ugradjujemo)\b/.test(haystack)) {
    score -= 2;
    offering.push('reklamni ton (1. lice množine)');
  }

  let intent: Intent;
  let confidence: number;

  if (score >= 3) {
    intent = 'SEEKING';
    confidence = Math.min(1, 0.55 + score * 0.08);
  } else if (score <= -3) {
    intent = 'OFFERING';
    confidence = Math.min(1, 0.55 + Math.abs(score) * 0.08);
  } else {
    intent = 'UNCLEAR';
    confidence = 0.3;
  }

  const explanation =
    intent === 'SEEKING'
      ? `traži majstora (signali: ${seeking.slice(0, 3).join(', ')})`
      : intent === 'OFFERING'
        ? `sam nudi uslugu — konkurencija (signali: ${offering.slice(0, 3).join(', ')})`
        : 'nejasno iz teksta — treba otvoriti oglas';

  return { intent, confidence, score, matched: { seeking, offering }, explanation };
}

/** Brza provera za filtriranje liste rezultata. */
export function isSeeking(text: string | null | undefined, minConfidence = 0.6): boolean {
  const result = classifyIntent(text);
  return result.intent === 'SEEKING' && result.confidence >= minConfidence;
}

/** Da li vredi otvoriti stranicu — ne odbacujemo UNCLEAR odmah, samo OFFERING. */
export function worthOpening(text: string | null | undefined): boolean {
  return classifyIntent(text).intent !== 'OFFERING';
}

/**
 * Koliko je oglas svež, iz teksta datuma koji sajtovi ispisuju.
 * Svežina je kod potražnje presudna: oglas star mesec dana je skoro sigurno rešen.
 */
export function freshnessBonus(text: string | null | undefined): { days: number | null; bonus: number } {
  const h = normalizeSr(text);
  if (!h) return { days: null, bonus: 0 };

  if (/\b(danas|pre \d+ (min|sat|sati|casa))\b/.test(h)) return { days: 0, bonus: 15 };
  if (/\bjuce\b/.test(h)) return { days: 1, bonus: 13 };
  if (/\bpre (2|3|4|5|6|7) dana\b/.test(h)) return { days: 4, bonus: 10 };
  if (/\bpre \d+ nedelj/.test(h)) return { days: 14, bonus: 5 };
  if (/\bpre \d+ mesec/.test(h)) return { days: 45, bonus: 0 };

  const match = h.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (match) {
    const [, d, m, y] = match;
    const datum = new Date(Number(y), Number(m) - 1, Number(d));
    const days = Math.floor((Date.now() - datum.getTime()) / 86_400_000);
    if (days < 0 || days > 400) return { days: null, bonus: 0 };
    if (days <= 1) return { days, bonus: 15 };
    if (days <= 7) return { days, bonus: 10 };
    if (days <= 30) return { days, bonus: 4 };
    return { days, bonus: 0 };
  }

  return { days: null, bonus: 0 };
}
