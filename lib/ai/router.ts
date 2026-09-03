/**
 * MULTI-MODEL AI ROUTER
 *
 * Jedno pravilo: pipeline NIKAD ne sme da stane zbog rate-limita.
 *
 *   extraction  ->  Groq      ->  OpenRouter  ->  Gemini
 *   reasoning   ->  Gemini    ->  Groq        ->  OpenRouter
 *   bulk        ->  OpenRouter->  Groq        ->  Gemini
 *
 * Router prolazi kroz lanac, preskače provajdere koji su u cooldown-u ili
 * bez ključa, i tek ako SVI padnu baca grešku (koju pipeline hvata i pada
 * na deterministički fallback — vidi `lib/scoring/leadScore.ts`).
 */

import { GroqProvider } from './providers/groq';
import { GeminiProvider } from './providers/gemini';
import { OpenRouterProvider } from './providers/openrouter';
import type { AiProvider, ChatMessage, CompletionRequest, CompletionResponse, ProviderId, ProviderStats, TaskKind } from './types';
import { ProviderError } from './types';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/rateLimiter';

const log = createLogger('ai:router');

const CHAINS: Record<TaskKind, ProviderId[]> = {
  extraction: ['groq', 'openrouter', 'gemini'],
  reasoning: ['gemini', 'groq', 'openrouter'],
  bulk: ['openrouter', 'groq', 'gemini'],
};

/** Singleton — instance drže rate-limit stanje, ne smeju se praviti po pozivu. */
let registry: Map<ProviderId, AiProvider> | null = null;

function getRegistry(): Map<ProviderId, AiProvider> {
  if (!registry) {
    registry = new Map<ProviderId, AiProvider>([
      ['groq', new GroqProvider()],
      ['gemini', new GeminiProvider()],
      ['openrouter', new OpenRouterProvider()],
    ]);
  }
  return registry;
}

export function getProvider(id: ProviderId): AiProvider {
  const provider = getRegistry().get(id);
  if (!provider) throw new Error(`Nepoznat provajder: ${id}`);
  return provider;
}

export function providerStats(): ProviderStats[] {
  return Array.from(getRegistry().values()).map((p) => p.stats());
}

export function configuredProviders(): ProviderId[] {
  return Array.from(getRegistry().values())
    .filter((p) => p.isConfigured())
    .map((p) => p.id);
}

export interface RouteOptions extends Omit<CompletionRequest, 'messages'> {
  task: TaskKind;
  /** Forsira konkretan lanac (npr. test jednog provajdera). */
  only?: ProviderId[];
  /** Koliko puta pokušati kod ISTOG provajdera pre prelaska na sledećeg. */
  attemptsPerProvider?: number;
  label?: string;
}

export interface RouteResult extends CompletionResponse {
  /** Provajderi koji su pali pre uspeha — korisno za dijagnostiku u bazi. */
  attempted: { provider: ProviderId; error: string }[];
}

/**
 * Glavni ulaz: pošalji poruke, dobij odgovor od prvog provajdera koji uspe.
 */
export async function route(messages: ChatMessage[], opts: RouteOptions): Promise<RouteResult> {
  const chain = (opts.only ?? CHAINS[opts.task]).map((id) => getProvider(id));
  const attempted: { provider: ProviderId; error: string }[] = [];

  const usable = chain.filter((p) => p.isConfigured());
  if (usable.length === 0) {
    throw new Error(
      'Nijedan AI provajder nije konfigurisan. Podesi bar jedan: GROQ_API_KEY, GEMINI_API_KEY ili OPENROUTER_API_KEY.',
    );
  }

  // Prvo probamo one koji su "zdravi", pa tek onda one u cooldown-u.
  const ordered = [...usable.filter((p) => p.isAvailable()), ...usable.filter((p) => !p.isAvailable())];

  for (const provider of ordered) {
    try {
      const response = await withRetry(
        () =>
          provider.complete({
            messages,
            json: opts.json,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            timeoutMs: opts.timeoutMs,
          }),
        {
          attempts: opts.attemptsPerProvider ?? 2,
          baseMs: 700,
          label: `${opts.label ?? opts.task}@${provider.id}`,
          shouldRetry: (error) => {
            if (!(error instanceof ProviderError)) return true;
            // 429 i auth -> nema smisla ponavljati kod istog, idi na sledećeg.
            return !error.isRateLimit && !error.isAuth;
          },
          onRetry: (attempt, error, waitMs) =>
            log.warn(`retry ${attempt} za ${provider.id} kroz ${waitMs}ms`, { error: String(error).slice(0, 160) }),
        },
      );

      if (attempted.length > 0) {
        log.info(`fallback uspeo na ${provider.id}`, { preskočeno: attempted.map((a) => a.provider).join(',') });
      }
      return { ...response, attempted };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempted.push({ provider: provider.id, error: message.slice(0, 300) });
      log.warn(`provajder ${provider.id} pao — prelazim na sledećeg`, { error: message.slice(0, 200) });
    }
  }

  throw new Error(
    `Svi AI provajderi pali za zadatak "${opts.task}": ${attempted.map((a) => `${a.provider} (${a.error.slice(0, 80)})`).join(' | ')}`,
  );
}

/**
 * `route` + parsiranje JSON-a. LLM-ovi vole da obmotaju JSON u ```json blok
 * ili da dodaju rečenicu pre njega, pa izlaz čistimo pre `JSON.parse`.
 */
export async function routeJson<T>(
  messages: ChatMessage[],
  opts: RouteOptions & { validate?: (value: unknown) => T },
): Promise<{ data: T; meta: RouteResult }> {
  const meta = await route(messages, { ...opts, json: true });
  const raw = extractJson(meta.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Model ${meta.provider}/${meta.model} nije vratio validan JSON: ${(error as Error).message}. Odgovor: ${meta.text.slice(0, 300)}`,
    );
  }

  const data = opts.validate ? opts.validate(parsed) : (parsed as T);
  return { data, meta };
}

/**
 * Izvlači JSON iz odgovora modela — podržava:
 *   ```json {...} ```   |   "Evo rezultata: {...}"   |   čist {...} / [...]
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace === -1) return trimmed;

  const opening = trimmed[firstBrace];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opening) depth++;
    else if (ch === closing) {
      depth--;
      if (depth === 0) return trimmed.slice(firstBrace, i + 1);
    }
  }

  return trimmed.slice(firstBrace);
}

/** Za /api/health — da li mašina uopšte može da radi. */
export function aiHealth(): { ok: boolean; providers: ProviderStats[]; usableNow: number } {
  const providers = providerStats();
  const usableNow = providers.filter((p) => p.available).length;
  return { ok: providers.some((p) => p.configured), providers, usableNow };
}
