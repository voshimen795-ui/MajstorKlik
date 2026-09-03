/**
 * TERTIARY / FALLBACK ENGINE — OpenRouter (besplatni modeli).
 *
 * Uloga: kad Groq i Gemini udare u rate-limit, pipeline NE SME da stane.
 * OpenRouter drži listu modela sa `:free` sufiksom (DeepSeek R1, Qwen3, GPT-OSS…).
 * Ako model iz liste vrati 429/404, automatski prelazimo na sledeći iz iste liste.
 *
 * Free tier: ~20 req/min i ~50 req/dan bez kredita (1000/dan ako ubaciš $10 —
 * i dalje bez trošenja po pozivu). Ključ: https://openrouter.ai/keys
 */

import { OpenAiCompatibleProvider } from './base';
import type { CompletionRequest, CompletionResponse } from '../types';
import { ProviderError } from '../types';

/** Redosled je namerno: prvo jeftini/brzi, pa jači reasoning modeli. */
const DEFAULT_FREE_MODELS = [
  'deepseek/deepseek-r1-distill-llama-70b:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-2-9b-it:free',
  'mistralai/mistral-7b-instruct:free',
];

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  private readonly fallbackModels: string[];
  private modelIndex = 0;

  constructor() {
    const configured = process.env.OPENROUTER_MODELS?.split(',').map((m) => m.trim()).filter(Boolean);
    const models = configured && configured.length > 0 ? configured : DEFAULT_FREE_MODELS;
    super({
      id: 'openrouter',
      model: models[0] ?? DEFAULT_FREE_MODELS[0]!,
      apiKey: process.env.OPENROUTER_API_KEY,
      requestsPerMinute: Number(process.env.OPENROUTER_RPM ?? 18),
      requestsPerDay: Number(process.env.OPENROUTER_RPD ?? 900),
      defaultTimeoutMs: 60_000,
    });
    this.fallbackModels = models;
  }

  protected endpoint(): string {
    return 'https://openrouter.ai/api/v1/chat/completions';
  }

  protected extraHeaders(): Record<string, string> {
    return {
      // OpenRouter traži referer/title za free tier atribuciju.
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://majstorklik.rs',
      'X-Title': process.env.OPENROUTER_SITE_NAME || 'MajstorKlik Lead Machine',
    };
  }

  /** Aktuelni model iz rotacije (BaseProvider čita `this.model`, pa ga pregazimo). */
  get activeModel(): string {
    return this.fallbackModels[this.modelIndex] ?? this.fallbackModels[0]!;
  }

  /**
   * Rotacija modela: ako konkretan besplatan model padne (429/404/503),
   * probamo sledeći iz liste PRE nego što router pređe na drugog provajdera.
   */
  override async complete(req: CompletionRequest): Promise<CompletionResponse> {
    let lastError: unknown;
    // Dok rotiramo modele, 429 na jednom modelu ne sme da ugasi ceo provajder.
    this.suppressCooldown = true;
    try {
      for (let i = 0; i < this.fallbackModels.length; i++) {
        const index = (this.modelIndex + i) % this.fallbackModels.length;
        const model = this.fallbackModels[index]!;
        this.model = model;
        try {
          const result = await super.complete(req);
          this.modelIndex = index; // zapamti model koji radi
          this.clearCooldown();
          return result;
        } catch (error) {
          lastError = error;
          const status = error instanceof ProviderError ? error.status : undefined;
          // 429/404/5xx = ovaj konkretan besplatan model je pao; probaj sledeći.
          if (status === 429 || status === 404 || status === 502 || status === 503 || status === 504) {
            this.log.warn(`model nedostupan (${status}) — rotiram`, { model });
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.suppressCooldown = false;
    }
    // Svi besplatni modeli pali — sad je pošteno uspavati ceo provajder.
    this.enterCooldown(60);
    throw lastError;
  }
}
