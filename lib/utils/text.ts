/**
 * Tekstualne pomoćne funkcije za srpski jezik.
 *
 * Ključni problem: isti podatak u Beogradu dolazi u 4 varijante —
 *   "Njegoševa 15, Vračar" / "Његошева 15, Врачар" / "NJEGOSEVA 15, VRACAR" / "Njegoseva 15 Vracar"
 * Sve normalizujemo u jedan "ASCII lowercase latinica" oblik pre bilo kakvog poređenja.
 */

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'dj', е: 'e', ж: 'z', з: 'z', и: 'i',
  ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's',
};

/** Latinična slova sa dijakritikom -> ASCII (č/ć -> c, š -> s, ž -> z, đ -> dj) */
const LATIN_DIACRITICS: Record<string, string> = {
  č: 'c', ć: 'c', š: 's', ž: 'z', đ: 'dj',
};

/**
 * Normalizuje bilo koji srpski string u ASCII lowercase oblik pogodan za poređenje.
 * "Његошева 15, Врачар" -> "njegoseva 15, vracar"
 */
export function normalizeSr(input: string | null | undefined): string {
  if (!input) return '';
  let out = input.normalize('NFC').toLowerCase();

  out = Array.from(out)
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? LATIN_DIACRITICS[ch] ?? ch)
    .join('');

  // Sve što je ostalo od dijakritike (npr. iz NFD forme) skidamo.
  out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  return out.replace(/\s+/g, ' ').trim();
}

/** Da li `haystack` sadrži `needle`, nezavisno od pisma i dijakritike. */
export function containsSr(haystack: string | null | undefined, needle: string): boolean {
  const h = normalizeSr(haystack);
  const n = normalizeSr(needle);
  if (!h || !n) return false;
  return h.includes(n);
}

/** Vraća sve termine iz liste koji se pojavljuju u tekstu (normalizovano). */
export function matchedTerms(text: string | null | undefined, terms: readonly string[]): string[] {
  const h = normalizeSr(text);
  if (!h) return [];
  return terms.filter((t) => h.includes(normalizeSr(t)));
}

/** Sabija whitespace i seče na max dužinu — za slanje sirovog HTML/teksta u LLM. */
export function squash(input: string, maxChars = 12_000): string {
  const cleaned = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…[skraćeno]` : cleaned;
}

/** Stabilan slug za dedupe ključeve. */
export function slugify(input: string): string {
  return normalizeSr(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Deterministički hash (FNV-1a, 32-bit) — koristimo za dedupe fingerprint
 * kada lead nema telefon (npr. oglas sa formom umesto broja).
 */
export function fingerprint(...parts: (string | null | undefined)[]): string {
  const src = parts.map((p) => normalizeSr(p)).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Naslov -> "Title Case" za srpska imena firmi u izveštajima. */
export function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
    .trim();
}

/** Sigurno seče string bez bacanja izuzetka. */
export function clip(input: string | null | undefined, max: number): string {
  if (!input) return '';
  return input.length > max ? input.slice(0, max) : input;
}
