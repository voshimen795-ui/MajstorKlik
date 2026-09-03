/**
 * PRIMARY ENGINE — Groq (besplatan tier).
 *
 * Zašto prvi za ekstrakciju: Groq na LPU hardveru vraća 70B model za ~1s.
 * Kad prolaziš kroz 300 kartica sa Google Maps-a, razlika između 1s i 8s po
 * kartici je razlika između 5 minuta i 40 minuta po ciklusu skreovanja.
 *
 * Free tier (orijentaciono): ~30 req/min, ~14.400 req/dan.
 * Ključ: https://console.groq.com/keys
 */

import { OpenAiCompatibleProvider } from './base';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export class GroqProvider extends OpenAiCompatibleProvider {
  constructor() {
    super({
      id: 'groq',
      model: process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL,
      apiKey: process.env.GROQ_API_KEY,
      requestsPerMinute: Number(process.env.GROQ_RPM ?? 30),
      requestsPerDay: Number(process.env.GROQ_RPD ?? 14_000),
      defaultTimeoutMs: 30_000,
    });
  }

  protected endpoint(): string {
    return 'https://api.groq.com/openai/v1/chat/completions';
  }
}
