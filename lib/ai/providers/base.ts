/**
 * Zajednička osnova za sve provajdere: rate limit, cooldown posle 429,
 * timeout, telemetrija. Konkretan provajder implementira samo `send()`.
 */

import { RateLimiter } from '../../utils/rateLimiter';
import { createLogger } from '../../utils/logger';
import type { AiProvider, CompletionRequest, CompletionResponse, ProviderId, ProviderStats } from '../types';
import { ProviderError } from '../types';

export interface BaseProviderOptions {
  id: ProviderId;
  model: string;
  apiKey: string | undefined;
  requestsPerMinute: number;
  requestsPerDay?: number;
  defaultTimeoutMs?: number;
}

export abstract class BaseProvider implements AiProvider {
  readonly id: ProviderId;
  /** Nije `readonly` jer OpenRouter rotira modele u toku rada. */
  model: string;
  /** Dok je true, 429 ne gasi ceo provajder (koristi OpenRouter dok rotira modele). */
  protected suppressCooldown = false;
  protected readonly apiKey: string | undefined;
  protected readonly limiter: RateLimiter;
  protected readonly log;
  private readonly defaultTimeoutMs: number;

  private calls = 0;
  private failures = 0;
  private rateLimitHits = 0;
  private latencySum = 0;
  private cooldownUntil: number | null = null;

  constructor(opts: BaseProviderOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 45_000;
    this.limiter = new RateLimiter({
      name: opts.id,
      requestsPerMinute: opts.requestsPerMinute,
      requestsPerDay: opts.requestsPerDay,
      safetyFactor: 0.8,
    });
    this.log = createLogger(`ai:${opts.id}`);
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  isAvailable(): boolean {
    if (!this.isConfigured()) return false;
    if (this.limiter.dailyExhausted) return false;
    if (this.cooldownUntil !== null && Date.now() < this.cooldownUntil) return false;
    return true;
  }

  /** Konkretan HTTP poziv — implementira podklasa. */
  protected abstract send(req: CompletionRequest, signal: AbortSignal): Promise<{ text: string; usage?: CompletionResponse['usage'] }>;

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isConfigured()) {
      throw new ProviderError(this.id, 'API ključ nije podešen', 401);
    }
    if (!this.isAvailable()) {
      const waitSec = this.cooldownUntil ? Math.ceil((this.cooldownUntil - Date.now()) / 1000) : 0;
      throw new ProviderError(this.id, `provajder u cooldown-u još ${waitSec}s`, 429, waitSec);
    }

    await this.limiter.acquire();

    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const { text, usage } = await this.send(req, controller.signal);
      const latencyMs = Date.now() - startedAt;
      this.calls += 1;
      this.latencySum += latencyMs;
      if (!text.trim()) throw new ProviderError(this.id, 'prazan odgovor modela', 502);
      return { text, provider: this.id, model: this.model, latencyMs, usage };
    } catch (error) {
      this.failures += 1;
      if (error instanceof ProviderError) {
        if (error.isRateLimit) {
          this.rateLimitHits += 1;
          this.enterCooldown(error.retryAfterSec ?? 35);
        } else if (error.isAuth) {
          this.enterCooldown(600);
        } else if (error.status !== undefined && error.status >= 500) {
          this.enterCooldown(20);
        }
        throw error;
      }
      if ((error as Error)?.name === 'AbortError') {
        this.enterCooldown(10);
        throw new ProviderError(this.id, `timeout posle ${timeoutMs}ms`, 504);
      }
      throw new ProviderError(this.id, (error as Error)?.message ?? 'nepoznata greška');
    } finally {
      clearTimeout(timer);
    }
  }

  protected enterCooldown(seconds: number): void {
    if (this.suppressCooldown) return;
    this.cooldownUntil = Date.now() + seconds * 1000;
    this.limiter.penalize(seconds);
    this.log.warn(`cooldown ${seconds}s`, { model: this.model });
  }

  /** Ručno gašenje kazne — koristi se kad rotacija modela uspe. */
  protected clearCooldown(): void {
    this.cooldownUntil = null;
  }

  /** Pretvara HTTP odgovor u ProviderError sa `Retry-After` ako postoji. */
  protected async toError(res: Response): Promise<ProviderError> {
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      detail = res.statusText;
    }
    return new ProviderError(
      this.id,
      `HTTP ${res.status}: ${detail}`,
      res.status,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
    );
  }

  stats(): ProviderStats {
    const bucket = this.limiter.stats();
    return {
      id: this.id,
      model: this.model,
      configured: this.isConfigured(),
      available: this.isAvailable(),
      calls: this.calls,
      failures: this.failures,
      rateLimitHits: this.rateLimitHits,
      avgLatencyMs: this.calls > 0 ? Math.round(this.latencySum / this.calls) : 0,
      cooldownUntil: this.cooldownUntil,
      bucket: {
        tokens: bucket.tokens,
        capacity: bucket.capacity,
        dailyUsed: bucket.dailyUsed,
        dailyLimit: bucket.dailyLimit,
      },
    };
  }
}

/**
 * OpenAI-kompatibilan `chat/completions` — koriste ga i Groq i OpenRouter.
 */
export abstract class OpenAiCompatibleProvider extends BaseProvider {
  protected abstract endpoint(): string;
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  protected async send(req: CompletionRequest, signal: AbortSignal) {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 2048,
    };
    if (req.json) body.response_format = { type: 'json_object' };

    const res = await fetch(this.endpoint(), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw await this.toError(res);

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: { message?: string };
    };

    if (data.error?.message) throw new ProviderError(this.id, data.error.message, 502);

    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      usage: {
        prompt: data.usage?.prompt_tokens,
        completion: data.usage?.completion_tokens,
        total: data.usage?.total_tokens,
      },
    };
  }
}
