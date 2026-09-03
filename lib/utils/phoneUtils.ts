/**
 * DOMAĆI PARSER BROJEVA TELEFONA (Srbija / +381)
 *
 * Zašto ovo postoji: u Beogradu isti broj sretneš kao
 *   "011/2435-678", "063 123 456", "+381 64 111 2233", "00381641112233",
 *   "tel: 011 24 35 678 lok. 4", "064/555-4444 i 011/3033-100"
 * a WhatsApp link radi SAMO sa čistim E.164 bez plusa (wa.me/381641112233).
 *
 * Bez ovoga ti pola baze ne može da primi poruku — a poenta cele mašine je
 * da majstor otvori lead i pošalje poruku u jednom kliku.
 */

export type PhoneType = 'mobile' | 'landline' | 'tollfree' | 'premium' | 'unknown';

export interface ParsedPhone {
  /** +381641112233 */
  e164: string;
  /** 381641112233 — oblik koji traži wa.me */
  msisdn: string;
  /** 064 111 2233 — za prikaz u UI */
  national: string;
  type: PhoneType;
  /** Yettel / mts / A1 / Beograd (fiksni) / ... */
  operator: string | null;
  /** Da li je broj beogradski fiksni (011). */
  isBelgrade: boolean;
  /** Da li se na njega može poslati WhatsApp (samo mobilni). */
  whatsappCapable: boolean;
  /** https://wa.me/381... (prazan string za fiksne) */
  whatsappLink: string;
  /** tel: link — uvek dostupan */
  telLink: string;
  /** Lokal, ako je nađen ("lok. 4" -> "4"). */
  extension: string | null;
  /** 0-1 — koliko verujemo da je ovo stvaran telefon a ne PIB/matični broj. */
  confidence: number;
}

export interface PhoneParseFailure {
  ok: false;
  raw: string;
  reason: string;
}

export type PhoneParseResult = ({ ok: true } & ParsedPhone) | PhoneParseFailure;

const CC = '381';

/** Mobilni prefiksi (bez vodeće nule) -> operater. */
const MOBILE_PREFIXES: Record<string, string> = {
  '60': 'A1',
  '61': 'A1',
  '62': 'Yettel',
  '63': 'Yettel',
  '64': 'mts',
  '65': 'mts',
  '66': 'mts',
  '67': 'MVNO',
  '68': 'Globaltel',
  '69': 'Yettel',
};

/** Geografski pozivni brojevi (bez vodeće nule). Beograd = 11. */
const AREA_CODES: Record<string, string> = {
  '11': 'Beograd',
  '10': 'Bor',
  '12': 'Požarevac',
  '13': 'Pančevo',
  '14': 'Valjevo',
  '15': 'Šabac',
  '16': 'Leskovac',
  '17': 'Vranje',
  '18': 'Niš',
  '19': 'Zaječar',
  '20': 'Novi Pazar',
  '21': 'Novi Sad',
  '22': 'Sremska Mitrovica',
  '23': 'Zrenjanin',
  '24': 'Subotica',
  '25': 'Sombor',
  '26': 'Smederevo',
  '27': 'Prokuplje',
  '28': 'Kosovska Mitrovica',
  '29': 'Prizren',
  '30': 'Pirot',
  '31': 'Užice',
  '32': 'Čačak',
  '33': 'Prijepolje',
  '34': 'Kragujevac',
  '35': 'Jagodina',
  '36': 'Kraljevo',
  '37': 'Kruševac',
  '38': 'Priština',
};

/** Kandidati za broj u slobodnom tekstu. */
const PHONE_CANDIDATE_RE =
  /(?:\+?\s?3\s?8\s?1|00\s?381|\b0)[\s./\-()]*\d[\d\s./\-()]{5,18}\d/g;

const EXTENSION_RE = /(?:lok(?:al)?\.?|ext\.?|int\.?)\s*[:.]?\s*(\d{1,5})/i;

/** Sekvence koje sigurno NISU telefon (PIB, matični broj, tekući račun, cena). */
const NEGATIVE_CONTEXT = /\b(pib|mat(?:ični)?\s*br|maticni|račun|racun|žiro|ziro|iban|rsd|din|eur|€|godin|kvadrat|m2)\b/i;

function digitsOnly(input: string): string {
  return input.replace(/\D+/g, '');
}

/**
 * Svodi bilo koji zapis na nacionalni značajni broj (NSN) — bez pozivnog broja
 * države i bez vodeće nule. "011/2435-678" -> "112435678"
 */
function toNsn(raw: string): { nsn: string; hadCountryCode: boolean } | null {
  let d = digitsOnly(raw);
  if (!d) return null;

  let hadCountryCode = false;

  // 00381... / 000381 (retko, loš unos)
  if (d.startsWith('00381')) {
    d = d.slice(5);
    hadCountryCode = true;
  } else if (d.startsWith('381')) {
    d = d.slice(3);
    hadCountryCode = true;
  }

  // Posle pozivnog broja države neki ipak ostave nulu: +381 064 ...
  if (hadCountryCode && d.startsWith('0')) d = d.slice(1);

  // Nacionalni zapis: vodeća nula je trunk prefiks
  if (!hadCountryCode) {
    if (!d.startsWith('0')) return null; // bez 0 i bez 381 ne znamo šta je
    d = d.slice(1);
  }

  if (!d) return null;
  return { nsn: d, hadCountryCode };
}

interface NsnClassification {
  type: PhoneType;
  operator: string | null;
  /** Dužina prefiksa unutar NSN-a. */
  prefixLen: number;
  minNsn: number;
  maxNsn: number;
}

function classifyNsn(nsn: string): NsnClassification | null {
  const p2 = nsn.slice(0, 2);
  const p3 = nsn.slice(0, 3);

  if (MOBILE_PREFIXES[p2]) {
    // 6X + 6-8 cifara pretplatnika
    return { type: 'mobile', operator: MOBILE_PREFIXES[p2] ?? null, prefixLen: 2, minNsn: 8, maxNsn: 10 };
  }

  if (p3 === '800') return { type: 'tollfree', operator: 'Besplatan poziv', prefixLen: 3, minNsn: 8, maxNsn: 10 };
  if (p3 === '700') return { type: 'tollfree', operator: 'Jedinstveni broj', prefixLen: 3, minNsn: 8, maxNsn: 10 };
  if (nsn.startsWith('9')) return { type: 'premium', operator: 'Premium (naplata)', prefixLen: 3, minNsn: 8, maxNsn: 10 };

  if (AREA_CODES[p2]) {
    const isBelgrade = p2 === '11';
    return {
      type: 'landline',
      operator: AREA_CODES[p2] ?? null,
      prefixLen: 2,
      // Beograd ima 7-8 cifara pretplatnika, ostali gradovi 6-7
      minNsn: isBelgrade ? 9 : 8,
      maxNsn: isBelgrade ? 10 : 9,
    };
  }

  return null;
}

function formatNational(nsn: string, c: NsnClassification): string {
  const prefix = `0${nsn.slice(0, c.prefixLen)}`;
  const rest = nsn.slice(c.prefixLen);
  // 6 cifara -> "123 456", 7-8 cifara -> "123 4567" / "1234 5678"
  const split = rest.length <= 6 ? 3 : rest.length - 4;
  return `${prefix} ${rest.slice(0, split)} ${rest.slice(split)}`.trim();
}

/**
 * GLAVNA FUNKCIJA — bilo koji domaći format -> E.164 + WhatsApp link.
 *
 * @example
 *   parsePhone('011/2435-678')      -> +381112435678, tip landline, bez WhatsApp-a
 *   parsePhone('063 123 456')       -> +38163123456,  wa.me/38163123456
 *   parsePhone('+381 64 111 2233')  -> +381641112233, wa.me/381641112233
 */
export function parsePhone(
  raw: string | null | undefined,
  opts: { waMessage?: string } = {},
): PhoneParseResult {
  const input = (raw ?? '').toString().trim();
  if (!input) return { ok: false, raw: input, reason: 'prazan unos' };

  const extMatch = input.match(EXTENSION_RE);
  const extension = extMatch?.[1] ?? null;
  // Lokal skidamo pre parsiranja da ne "zalepi" cifre na glavni broj.
  const withoutExt = extension ? input.replace(EXTENSION_RE, ' ') : input;

  const nsnResult = toNsn(withoutExt);
  if (!nsnResult) {
    return { ok: false, raw: input, reason: 'nije prepoznat srpski format (nema 0 ni +381)' };
  }

  const { nsn, hadCountryCode } = nsnResult;
  const classification = classifyNsn(nsn);
  if (!classification) {
    return { ok: false, raw: input, reason: `nepoznat prefiks: 0${nsn.slice(0, 3)}` };
  }

  if (nsn.length < classification.minNsn || nsn.length > classification.maxNsn) {
    return {
      ok: false,
      raw: input,
      reason: `pogrešna dužina (${nsn.length} cifara, očekivano ${classification.minNsn}-${classification.maxNsn})`,
    };
  }

  if (/^(\d)\1+$/.test(nsn.slice(classification.prefixLen))) {
    return { ok: false, raw: input, reason: 'lažan broj (sve iste cifre)' };
  }

  const msisdn = `${CC}${nsn}`;
  const e164 = `+${msisdn}`;
  const isMobile = classification.type === 'mobile';

  // Pouzdanost: eksplicitan +381 ili jasan mobilni prefiks = visoka.
  let confidence = 0.7;
  if (hadCountryCode) confidence += 0.2;
  if (isMobile) confidence += 0.1;
  if (NEGATIVE_CONTEXT.test(input)) confidence -= 0.35;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  return {
    ok: true,
    e164,
    msisdn,
    national: formatNational(nsn, classification),
    type: classification.type,
    operator: classification.operator,
    isBelgrade: classification.type === 'landline' && nsn.startsWith('11'),
    whatsappCapable: isMobile,
    whatsappLink: isMobile ? buildWaLink(msisdn, opts.waMessage) : '',
    telLink: `tel:${e164}`,
    extension,
    confidence,
  };
}

/** wa.me link sa opcionom pripremljenom porukom. */
export function buildWaLink(msisdnOrE164: string, message?: string): string {
  const msisdn = digitsOnly(msisdnOrE164);
  if (!msisdn) return '';
  const base = `https://wa.me/${msisdn}`;
  if (!message) return base;
  return `${base}?text=${encodeURIComponent(message)}`;
}

/** viber:// deep link — u Srbiji Viber ima veću penetraciju od WhatsApp-a kod 45+. */
export function buildViberLink(msisdnOrE164: string, message?: string): string {
  const msisdn = digitsOnly(msisdnOrE164);
  if (!msisdn) return '';
  const params = new URLSearchParams({ number: `+${msisdn}` });
  if (message) params.set('text', message);
  return `viber://chat?${params.toString()}`;
}

/** SMS deep link — fallback kad nema ni WhatsApp ni Viber. */
export function buildSmsLink(e164: string, message?: string): string {
  if (!e164) return '';
  return message ? `sms:${e164}?body=${encodeURIComponent(message)}` : `sms:${e164}`;
}

/**
 * Vadi SVE brojeve iz slobodnog teksta (opis firme, HTML stranica, oglas).
 * Vraća samo validne, deduplicirane, sortirane tako da mobilni idu prvi
 * (mobilni = WhatsApp = najveća šansa za odgovor).
 */
export function extractPhones(text: string | null | undefined, opts: { waMessage?: string } = {}): ParsedPhone[] {
  if (!text) return [];

  const found = new Map<string, ParsedPhone>();
  const matches = text.match(PHONE_CANDIDATE_RE) ?? [];

  for (const candidate of matches) {
    // Kontekst oko broja — da odbacimo PIB/matični broj.
    const idx = text.indexOf(candidate);
    const context = text.slice(Math.max(0, idx - 40), idx + candidate.length + 10);

    const parsed = parsePhone(candidate, opts);
    if (!parsed.ok) continue;
    if (NEGATIVE_CONTEXT.test(context) && parsed.type !== 'mobile') continue;
    if (parsed.type === 'premium') continue;

    const existing = found.get(parsed.e164);
    if (!existing || parsed.confidence > existing.confidence) {
      const { ok: _ok, ...rest } = parsed;
      void _ok;
      found.set(parsed.e164, rest);
    }
  }

  return Array.from(found.values()).sort((a, b) => {
    if (a.whatsappCapable !== b.whatsappCapable) return a.whatsappCapable ? -1 : 1;
    return b.confidence - a.confidence;
  });
}

/**
 * Bira NAJBOLJI broj za kontakt iz teksta: mobilni sa najvišom pouzdanošću,
 * a ako mobilnog nema — beogradski fiksni.
 */
export function pickBestPhone(text: string | null | undefined, opts: { waMessage?: string } = {}): ParsedPhone | null {
  const all = extractPhones(text, opts);
  if (all.length === 0) return null;
  return all.find((p) => p.whatsappCapable) ?? all.find((p) => p.isBelgrade) ?? all[0] ?? null;
}

/** Normalizacija za dedupe ključ u bazi — uvek E.164 ili null. */
export function toE164(raw: string | null | undefined): string | null {
  const parsed = parsePhone(raw);
  return parsed.ok ? parsed.e164 : null;
}

/** Da li dva zapisa predstavljaju isti broj (za dupes check). */
export function isSamePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ea = toE164(a);
  const eb = toE164(b);
  return !!ea && ea === eb;
}
