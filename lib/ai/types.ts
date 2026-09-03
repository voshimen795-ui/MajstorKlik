/** Zajednički tipovi Multi-AI sloja. */

export type ProviderId = 'groq' | 'gemini' | 'openrouter';

/**
 * Tip zadatka određuje redosled provajdera:
 *  - `extraction`  -> brzina i propusnost  (Groq prvi)
 *  - `reasoning`   -> kvalitet zaključivanja i pisanja (Gemini prvi)
 *  - `bulk`        -> šta god je trenutno slobodno (OpenRouter prvi, štedi kvotu)
 */
export type TaskKind = 'extraction' | 'reasoning' | 'bulk';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Traži strogi JSON izlaz (svi provajderi to podržavaju na svoj način). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Tvrdi timeout po pozivu (ms). */
  timeoutMs?: number;
}

export interface CompletionResponse {
  text: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  /** Ako provajder vrati potrošnju tokena. */
  usage?: { prompt?: number; completion?: number; total?: number };
}

export interface AiProvider {
  id: ProviderId;
  /** Ime modela koji je trenutno aktivan. */
  model: string;
  /** Da li je konfigurisan (ima API ključ). */
  isConfigured(): boolean;
  /** Da li je trenutno "zdrav" (nije u kazni zbog 429/5xx). */
  isAvailable(): boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /** Statistika za /api/health. */
  stats(): ProviderStats;
}

export interface ProviderStats {
  id: ProviderId;
  model: string;
  configured: boolean;
  available: boolean;
  calls: number;
  failures: number;
  rateLimitHits: number;
  avgLatencyMs: number;
  cooldownUntil: number | null;
  bucket: { tokens: number; capacity: number; dailyUsed: number; dailyLimit: number | null };
}

/** Greška koju router prepoznaje kao "probaj sledećeg provajdera". */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  /** 401/403 = pogrešan ključ; nema svrhe ponavljati, ali ima smisla preći na drugog. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isTransient(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }
}
