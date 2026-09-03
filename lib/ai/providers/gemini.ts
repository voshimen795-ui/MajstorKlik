/**
 * SECONDARY ENGINE — Google Gemini Flash (besplatan tier).
 *
 * Zašto on radi scoring a ne Groq: Gemini Flash je osetno bolji u
 * "meko" zaključivanje — proceni kupovnu moć iz konteksta i napiše poruku
 * na srpskom koja ne zvuči kao robot. To je tačno ono što nam treba za
 * `lead_score`, `reasoning` i `cold_pitch_message`.
 *
 * Free tier (orijentaciono): 15 req/min, 1500 req/dan.
 * Ključ: https://aistudio.google.com/apikey
 *
 * Napomena: Gemini ima drugačiji API oblik od OpenAI-ja (contents/parts,
 * system_instruction odvojeno), pa nasleđuje BaseProvider direktno.
 */

import { BaseProvider } from './base';
import type { CompletionRequest, CompletionResponse } from '../types';
import { ProviderError } from '../types';

const DEFAULT_MODEL = 'gemini-1.5-flash';

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; code?: number; status?: string };
  promptFeedback?: { blockReason?: string };
}

export class GeminiProvider extends BaseProvider {
  constructor() {
    super({
      id: 'gemini',
      model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      requestsPerMinute: Number(process.env.GEMINI_RPM ?? 15),
      requestsPerDay: Number(process.env.GEMINI_RPD ?? 1400),
      defaultTimeoutMs: 45_000,
    });
  }

  protected async send(req: CompletionRequest, signal: AbortSignal): Promise<{ text: string; usage?: CompletionResponse['usage'] }> {
    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxTokens ?? 2048,
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
      },
      // Skidamo agresivne filtere — opisi kvarova ("pukla cev, poplava") ume da
      // okine false positive na "dangerous content" i vrati prazan odgovor.
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };
    if (systemParts.length > 0) body.system_instruction = { parts: systemParts };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey ?? '',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw await this.toError(res);

    const data = (await res.json()) as GeminiResponse;
    if (data.error?.message) {
      throw new ProviderError(this.id, data.error.message, data.error.code ?? 502);
    }
    if (data.promptFeedback?.blockReason) {
      throw new ProviderError(this.id, `sadržaj blokiran: ${data.promptFeedback.blockReason}`, 422);
    }

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    return {
      text,
      usage: {
        prompt: data.usageMetadata?.promptTokenCount,
        completion: data.usageMetadata?.candidatesTokenCount,
        total: data.usageMetadata?.totalTokenCount,
      },
    };
  }
}
