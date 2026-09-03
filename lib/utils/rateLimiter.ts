/**
 * Token bucket + backoff — jer su besplatni tierovi jedini razlog zašto ovo
 * ne košta ništa, a jedini način da ih izgubiš je da udariš u 429.
 *
 * Groq free: ~30 req/min. Gemini Flash free: ~15 req/min. OpenRouter free: ~20 req/min.
 * Držimo se ISPOD tih granica namerno (safetyFactor), jer je bolje da lead stigne
 * 10 sekundi kasnije nego da ti ključ bude privremeno blokiran.
 */

export interface RateLimiterOptions {
  /** Dozvoljeno zahteva u minuti (nominalno, po dokumentaciji provajdera). */
  requestsPerMinute: number;
  /** Koliki deo limita stvarno koristimo (0.8 = 80%). */
  safetyFactor?: number;
  /** Dnevni limit zahteva, ako provajder ima (Gemini free ima ~1500/dan). */
  requestsPerDay?: number;
  name: string;
}

export class RateLimiter {
  readonly name: string;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;
  private readonly dailyLimit: number | null;
  private dailyUsed = 0;
  private dailyWindowStart = Date.now();
  /** Serijalizuje čekanja da 5 paralelnih poziva ne "pojede" isti token. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions) {
    const effective = Math.max(1, Math.floor(opts.requestsPerMinute * (opts.safetyFactor ?? 0.8)));
    this.name = opts.name;
    this.capacity = effective;
    this.tokens = effective;
    this.refillPerMs = effective / 60_000;
    this.lastRefill = Date.now();
    this.dailyLimit = opts.requestsPerDay ?? null;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;

    if (now - this.dailyWindowStart >= 86_400_000) {
      this.dailyWindowStart = now;
      this.dailyUsed = 0;
    }
  }

  /** Da li je dnevna kvota potrošena (tada uopšte ne pokušavamo). */
  get dailyExhausted(): boolean {
    this.refill();
    return this.dailyLimit !== null && this.dailyUsed >= this.dailyLimit;
  }

  /** Čeka dok ne dobije token. Serijalizovano — FIFO. */
  async acquire(): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.dailyLimit !== null && this.dailyUsed >= this.dailyLimit) {
          throw new Error(`${this.name}: dnevna kvota potrošena (${this.dailyLimit} zahteva)`);
        }
        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.dailyUsed += 1;
          return;
        }
        const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs) + 25;
        await sleep(Math.min(waitMs, 60_000));
      }
    });
    // Red se nastavlja i ako ovaj poziv pukne.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Kada provajder vrati 429 — ručno praznimo kofu na `seconds`. */
  penalize(seconds: number): void {
    this.tokens = Math.min(this.tokens, 0);
    this.lastRefill = Date.now() + Math.max(0, seconds) * 1000;
  }

  stats(): { name: string; tokens: number; capacity: number; dailyUsed: number; dailyLimit: number | null } {
    this.refill();
    return {
      name: this.name,
      tokens: Math.floor(this.tokens),
      capacity: this.capacity,
      dailyUsed: this.dailyUsed,
      dailyLimit: this.dailyLimit,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nasumična pauza — koristi se i za skreper (human-like) i za backoff jitter. */
export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

export async function humanDelay(minMs = 900, maxMs = 2600): Promise<void> {
  await sleep(randomBetween(minMs, maxMs));
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  label?: string;
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
  /** Vrati false da prekineš retry (npr. 401 — ključ je pogrešan, nema svrhe). */
  shouldRetry?: (error: unknown) => boolean;
}

/** Eksponencijalni backoff sa jitterom. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 800;
  const maxMs = opts.maxMs ?? 16_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (opts.shouldRetry && !opts.shouldRetry(error)) throw error;
      if (attempt === attempts) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const waitMs = backoff + randomBetween(0, Math.floor(backoff * 0.3));
      opts.onRetry?.(attempt, error, waitMs);
      await sleep(waitMs);
    }
  }
  throw lastError;
}
