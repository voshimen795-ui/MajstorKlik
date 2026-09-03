/**
 * VREMENSKI BUDŽET.
 *
 * Serverless funkcija ima tvrd limit (Vercel Pro: 300s). Ako je pređeš, proces
 * biva ubijen NASRED posla — skrejpovani leadovi se izgube, a AI kvota je već
 * potrošena. Zato svaki dugačak posao dobija budžet i sam staje na vreme,
 * uredno vrati ono što je do tada skupio.
 *
 * Pravilo: bolje 12 upisanih leadova nego 30 izgubljenih.
 */

export interface Deadline {
  /** Da li je vreme isteklo. */
  expired(): boolean;
  /** Koliko je ostalo (ms). Beskonačan budžet vraća Infinity. */
  remainingMs(): number;
  /** Ima li vremena za operaciju koja traje ~`ms`? */
  hasRoomFor(ms: number): boolean;
  /** Novi, kraći budžet izveden iz ovog (npr. 65% za skreper). */
  slice(fraction: number): Deadline;
  /** Za log. */
  describe(): string;
}

const UNLIMITED: Deadline = {
  expired: () => false,
  remainingMs: () => Number.POSITIVE_INFINITY,
  hasRoomFor: () => true,
  slice: () => UNLIMITED,
  describe: () => 'bez ograničenja',
};

/**
 * @param budgetMs  ukupno vreme; `undefined` ili 0 = bez ograničenja
 * @param safetyMs  rezerva koja se ostavlja za upis u bazu i odgovor (default 15s)
 */
export function createDeadline(budgetMs?: number, safetyMs = 15_000): Deadline {
  if (!budgetMs || budgetMs <= 0 || !Number.isFinite(budgetMs)) return UNLIMITED;

  const endsAt = Date.now() + Math.max(1_000, budgetMs - safetyMs);

  const deadline: Deadline = {
    expired: () => Date.now() >= endsAt,
    remainingMs: () => Math.max(0, endsAt - Date.now()),
    hasRoomFor: (ms: number) => endsAt - Date.now() > ms,
    slice: (fraction: number) => createDeadline(deadline.remainingMs() * fraction, 0),
    describe: () => `${Math.round(deadline.remainingMs() / 1000)}s preostalo`,
  };

  return deadline;
}

/** Podrazumevani budžet po okruženju — Vercel Pro seče na 300s. */
export function defaultBudgetMs(): number | undefined {
  const explicit = Number(process.env.RUN_TIME_BUDGET_MS ?? 0);
  if (explicit > 0) return explicit;
  // Na Vercel-u uvek radimo sa budžetom; worker/lokalno nema ograničenje.
  if (process.env.VERCEL === '1') return 280_000;
  return undefined;
}
