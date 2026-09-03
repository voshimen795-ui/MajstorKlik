/**
 * MULTI-AI QUALIFIER & SCORER — mozak mašine.
 *
 * Tok jednog leada:
 *   sirov unos -> telefon (E.164) -> geo klasifikacija -> deterministički skor
 *              -> AI verdikt (Gemini -> Groq -> OpenRouter)
 *              -> spajanje skorova -> provera poruke -> LeadRecord
 *
 * Ako AI nigde ne prođe, `usedFallback = true` i lead se i dalje generiše
 * sa šablonskim pitch-om. Mašina ne staje.
 */

import { route, routeJson } from './router';
import { buildExtractionPrompt, buildQualifyPrompt, buildPitchRewritePrompt } from './prompts';
import { AiVerdictSchema, type AiVerdict, type LeadRecord, type QualificationResult, type RawLead } from '../types/lead';
import { blendScores, fallbackPitch, fallbackReasoning, scoreLead, type ScoreBreakdown } from '../scoring/leadScore';
import { classifyLocation, resolveZone, RICH_ZONES } from '../config/zones';
import { TARGET_PROFILES, isCompetitor, type Craft, type TargetKind } from '../config/categories';
import { buildSmsLink, buildViberLink, buildWaLink, pickBestPhone, type ParsedPhone } from '../utils/phoneUtils';
import { fingerprint, normalizeSr, squash } from '../utils/text';
import { createLogger } from '../utils/logger';
import { z } from 'zod';

const log = createLogger('ai:engine');

/* ------------------------------------------------------------------ */
/*  EKSTRAKCIJA IZ SIROVOG TEKSTA (Groq primarni)                      */
/* ------------------------------------------------------------------ */

const ExtractionSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().default(''),
        address: z.string().default(''),
        phone: z.string().default(''),
        category: z.string().default(''),
        description: z.string().default(''),
        website: z.string().default(''),
      }),
    )
    .default([]),
});

export interface ExtractionContext {
  craft: Craft;
  zoneId: keyof typeof RICH_ZONES;
  source: RawLead['source'];
  sourceUrl: string;
  sourceLabel: string;
}

/**
 * Pretvara sirov tekst/HTML stranice u listu `RawLead`-ova.
 * Koristi se kada DOM parsiranje ne uspe (izvor promenio strukturu) —
 * LLM je otporniji na promenu markupa nego CSS selektori.
 */
export async function extractLeadsFromText(rawText: string, ctx: ExtractionContext): Promise<RawLead[]> {
  const text = squash(rawText, 14_000);
  if (text.length < 40) return [];

  const zone = RICH_ZONES[ctx.zoneId];

  try {
    const { data, meta } = await routeJson(
      buildExtractionPrompt({ rawText: text, sourceLabel: ctx.sourceLabel, zoneLabel: zone.label }),
      {
        task: 'extraction',
        temperature: 0.1,
        maxTokens: 4000,
        label: 'extract',
        validate: (value) => ExtractionSchema.parse(value),
      },
    );

    log.info(`ekstrahovano ${data.items.length} unosa`, { provider: meta.provider, model: meta.model, ms: meta.latencyMs });

    return data.items
      .filter((item) => item.name.trim().length > 1)
      .map<RawLead>((item) => ({
        source: ctx.source,
        sourceUrl: ctx.sourceUrl,
        name: item.name.trim(),
        rawAddress: item.address.trim() || null,
        rawPhone: item.phone.trim() || null,
        rawCategory: item.category.trim() || null,
        rawDescription: item.description.trim() || null,
        craft: ctx.craft,
        targetZone: ctx.zoneId,
        scrapedAt: new Date().toISOString(),
        meta: { website: item.website.trim() || null },
      }));
  } catch (error) {
    log.error('ekstrakcija pala na svim provajderima', { error: String(error).slice(0, 300) });
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  POGAĐANJE TIPA OBJEKTA (bez AI-ja, deterministički)                */
/* ------------------------------------------------------------------ */

export function inferTargetKind(raw: Pick<RawLead, 'name' | 'rawCategory' | 'rawDescription' | 'source'>): TargetKind | null {
  if (raw.source === 'registar_sz') return 'stambena_zajednica';
  if (raw.source === 'oglasi') return 'nekretnina_oglas';

  const haystack = normalizeSr([raw.name, raw.rawCategory, raw.rawDescription].filter(Boolean).join(' '));
  if (!haystack) return null;

  let best: { kind: TargetKind; hits: number } | null = null;
  for (const profile of TARGET_PROFILES) {
    const hits = profile.queries.filter((q) => haystack.includes(normalizeSr(q))).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { kind: profile.kind, hits };
  }
  return best?.kind ?? null;
}

/* ------------------------------------------------------------------ */
/*  KVALIFIKACIJA JEDNOG LEADA                                          */
/* ------------------------------------------------------------------ */

export interface QualifyOptions {
  /** Preskoči AI i koristi samo pravila (za testiranje ili kad je kvota gotova). */
  rulesOnly?: boolean;
  /** Minimalni skor ispod kog lead odbacujemo. */
  minScore?: number;
  /** Ubaci pripremljenu poruku direktno u wa.me link. */
  prefillWhatsApp?: boolean;
}

export async function qualifyLead(raw: RawLead, opts: QualifyOptions = {}): Promise<QualificationResult> {
  const minScore = opts.minScore ?? Number(process.env.MIN_LEAD_SCORE ?? 45);

  // --- 1. Telefon ---
  const phoneSource = [raw.rawPhone, raw.rawDescription, raw.rawAddress].filter(Boolean).join(' \n ');
  const phone: ParsedPhone | null = pickBestPhone(phoneSource);

  // --- 2. Geografija ---
  const geoText = [raw.rawAddress, raw.name, raw.rawDescription].filter(Boolean).join(' , ');
  const geo = classifyLocation(geoText, raw.targetZone);

  // --- 3. Tip objekta ---
  const targetKind = inferTargetKind(raw);
  const profile = targetKind ? TARGET_PROFILES.find((p) => p.kind === targetKind) ?? null : null;

  // --- 4. Deterministički skor ---
  const breakdown: ScoreBreakdown = scoreLead({
    craft: raw.craft,
    name: raw.name,
    address: raw.rawAddress,
    description: raw.rawDescription,
    rawCategory: raw.rawCategory,
    targetKind,
    phone,
    geo,
    reviewCount: raw.meta?.reviewCount ?? null,
    rating: raw.meta?.rating ?? null,
  });

  // Rana odbacivanja — ne trošimo AI kvotu na smeće.
  const competitorHit = isCompetitor([raw.name, raw.rawCategory ?? ''].join(' '), raw.craft);
  if (competitorHit) {
    return { lead: null, rejectedReason: 'konkurencija (isti zanat)', tier: breakdown.tier, usedFallback: false, aiProvider: null };
  }
  if (!phone) {
    return { lead: null, rejectedReason: 'nema upotrebljiv telefon', tier: breakdown.tier, usedFallback: false, aiProvider: null };
  }
  if (!geo.zone) {
    return { lead: null, rejectedReason: 'van premium zona', tier: breakdown.tier, usedFallback: false, aiProvider: null };
  }
  if (breakdown.total < minScore - 15) {
    // -15 tolerancije: AI sme da podigne granični lead, ali očigledno smeće ne šaljemo.
    return {
      lead: null,
      rejectedReason: `skor pravila ${breakdown.total} previše nizak (prag ${minScore})`,
      tier: breakdown.tier,
      usedFallback: false,
      aiProvider: null,
    };
  }

  // --- 5. AI verdikt ---
  let verdict: AiVerdict | null = null;
  let aiProvider: string | null = null;
  let aiModel: string | null = null;

  if (!opts.rulesOnly) {
    try {
      const { data, meta } = await routeJson(
        buildQualifyPrompt({
          craft: raw.craft,
          name: raw.name,
          address: raw.rawAddress,
          phoneNational: phone.national,
          rawCategory: raw.rawCategory,
          description: raw.rawDescription,
          sourceUrl: raw.sourceUrl,
          zone: geo.zone,
          targetKind,
          breakdown,
        }),
        {
          task: 'reasoning',
          temperature: 0.55,
          maxTokens: 1200,
          label: 'qualify',
          validate: (value) => AiVerdictSchema.parse(coerceVerdict(value)),
        },
      );
      verdict = data;
      aiProvider = meta.provider;
      aiModel = meta.model;
    } catch (error) {
      log.warn('AI kvalifikacija pala — koristim deterministički fallback', { error: String(error).slice(0, 200) });
    }
  }

  if (verdict?.is_competitor) {
    return { lead: null, rejectedReason: 'AI prepoznao konkurenciju', tier: breakdown.tier, usedFallback: false, aiProvider };
  }

  // --- 6. Finalni skor i poruka ---
  const finalScore = blendScores(breakdown.total, verdict ? verdict.ai_score : null);
  if (finalScore < minScore) {
    return {
      lead: null,
      rejectedReason: `finalni skor ${finalScore} ispod praga ${minScore}`,
      tier: breakdown.tier,
      usedFallback: verdict === null,
      aiProvider,
    };
  }

  let pitch = verdict?.cold_pitch_message?.trim() || '';
  const pitchIssue = validatePitch(pitch);
  if (pitchIssue && verdict) {
    pitch = (await repairPitch({ raw, pitch, problem: pitchIssue, zoneLabel: geo.zone.label })) ?? '';
  }
  if (!pitch || validatePitch(pitch)) {
    pitch = fallbackPitch({
      craft: raw.craft,
      clientName: verdict?.client_name || raw.name,
      zoneLabel: geo.zone.label,
      targetKind,
      urgencyLevel: breakdown.urgencyLevel,
    });
  }

  const clientName = (verdict?.client_name || raw.name).trim();
  const address = (verdict?.address || raw.rawAddress || '').trim();
  const municipality = resolveMunicipality(verdict?.municipality, geo.zone.municipality);

  const whatsappLink = phone.whatsappCapable
    ? buildWaLink(phone.msisdn, opts.prefillWhatsApp === false ? undefined : pitch)
    : '';

  const tier = pickTier(verdict?.purchasing_power_tier, breakdown.tier);

  const lead: LeadRecord = {
    // --- polja iz specifikacije ---
    client_name: clientName,
    address,
    municipality,
    is_high_income_location: geo.isHighIncome || tier === 'HIGH',
    phone_e164: phone.e164,
    whatsapp_link: whatsappLink,
    lead_score: finalScore,
    purchasing_power_tier: tier,
    reasoning: verdict?.reasoning?.trim() || fallbackReasoning(breakdown, geo.zone.label),
    cold_pitch_message: pitch,

    // --- interna polja ---
    craft: raw.craft,
    source: raw.source,
    source_url: raw.sourceUrl,
    zone_id: geo.zone.id,
    zone_label: geo.zone.label,
    target_kind: targetKind,
    segment: profile?.segment ?? 'B2B',
    urgency: verdict?.urgency ?? breakdown.urgencyLevel,
    phone_national: phone.national,
    phone_type: phone.type,
    viber_link: phone.whatsappCapable ? buildViberLink(phone.msisdn, pitch) : null,
    sms_link: buildSmsLink(phone.e164, pitch),
    rule_score: breakdown.total,
    ai_score: verdict?.ai_score ?? null,
    dedupe_key: buildDedupeKey(phone.e164, clientName, address),
    raw_description: raw.rawDescription ? raw.rawDescription.slice(0, 2000) : null,
    ai_provider: aiProvider,
    ai_model: aiModel,
    status: 'new',
    scraped_at: raw.scrapedAt,
  };

  return { lead, rejectedReason: null, tier, usedFallback: verdict === null, aiProvider };
}

/* ------------------------------------------------------------------ */
/*  BATCH — kontrolisana paralelnost                                    */
/* ------------------------------------------------------------------ */

export interface BatchResult {
  leads: LeadRecord[];
  rejected: { name: string; reason: string }[];
  usedFallbackCount: number;
}

/**
 * Kvalifikuje listu leadova sa ograničenom paralelnošću.
 * Concurrency 3 je namerno nisko — free tier je 15-30 req/min, a rate limiter
 * ionako čeka; veći paralelizam samo pravi red čekanja i timeout-e.
 */
export async function qualifyBatch(
  raws: RawLead[],
  opts: QualifyOptions & { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BatchResult> {
  const concurrency = Math.max(1, opts.concurrency ?? Number(process.env.AI_CONCURRENCY ?? 3));
  const leads: LeadRecord[] = [];
  const rejected: { name: string; reason: string }[] = [];
  let usedFallbackCount = 0;
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= raws.length) return;
      const raw = raws[index]!;
      try {
        const result = await qualifyLead(raw, opts);
        if (result.lead) leads.push(result.lead);
        else rejected.push({ name: raw.name, reason: result.rejectedReason ?? 'nepoznato' });
        if (result.usedFallback) usedFallbackCount++;
      } catch (error) {
        rejected.push({ name: raw.name, reason: `greška: ${String(error).slice(0, 160)}` });
      } finally {
        done++;
        opts.onProgress?.(done, raws.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, raws.length) }, () => worker()));

  leads.sort((a, b) => b.lead_score - a.lead_score);
  return { leads, rejected, usedFallbackCount };
}

/* ------------------------------------------------------------------ */
/*  POMOĆNE                                                             */
/* ------------------------------------------------------------------ */

/** Modeli povremeno vrate broj kao string ili tier malim slovima — popravljamo pre validacije. */
function coerceVerdict(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = { ...(value as Record<string, unknown>) };

  if (typeof v.ai_score === 'string') v.ai_score = Number.parseFloat(v.ai_score) || 0;
  if (typeof v.lead_score === 'number' && typeof v.ai_score !== 'number') v.ai_score = v.lead_score;
  if (typeof v.purchasing_power_tier === 'string') v.purchasing_power_tier = v.purchasing_power_tier.toUpperCase();
  if (typeof v.urgency === 'string') v.urgency = v.urgency.toUpperCase();
  if (v.purchasing_power_tier !== 'HIGH' && v.purchasing_power_tier !== 'MEDIUM' && v.purchasing_power_tier !== 'STANDARD') {
    v.purchasing_power_tier = 'STANDARD';
  }
  if (v.urgency !== 'NONE' && v.urgency !== 'LOW' && v.urgency !== 'MEDIUM' && v.urgency !== 'HIGH') {
    v.urgency = 'NONE';
  }
  if (typeof v.is_competitor === 'string') v.is_competitor = v.is_competitor.toLowerCase() === 'true';
  if (typeof v.ai_score === 'number') v.ai_score = Math.max(0, Math.min(100, v.ai_score));
  return v;
}

/** Provera kvaliteta poruke. Vraća opis problema ili null ako je poruka OK. */
export function validatePitch(message: string): string | null {
  const text = message.trim();
  if (text.length < 120) return 'poruka je prekratka da bi bila ubedljiva';
  if (text.length > 700) return 'poruka je predugačka za WhatsApp — niko je neće pročitati';

  const banned = ['poštovani', 'akcija', 'popust', 'najbolji u gradu', 'najpovoljnije', 'lorem ipsum'];
  const lower = normalizeSr(text);
  for (const word of banned) {
    if (lower.includes(normalizeSr(word))) return `sadrži zabranjenu frazu "${word}"`;
  }
  if ((text.match(/!/g) ?? []).length > 1) return 'previše uzvičnika';
  if (/[\u{1F300}-\u{1FAFF}]/u.test(text)) return 'sadrži emodžije';
  if (text === text.toUpperCase()) return 'sve velikim slovima';
  return null;
}

async function repairPitch(params: {
  raw: RawLead;
  pitch: string;
  problem: string;
  zoneLabel: string;
}): Promise<string | null> {
  try {
    const { data } = await routeJson(
      buildPitchRewritePrompt({
        craft: params.raw.craft,
        clientName: params.raw.name,
        zoneLabel: params.zoneLabel,
        problem: params.problem,
        previousMessage: params.pitch,
      }),
      {
        task: 'reasoning',
        temperature: 0.6,
        maxTokens: 500,
        label: 'pitch-repair',
        validate: (value) => z.object({ cold_pitch_message: z.string() }).parse(value),
      },
    );
    const fixed = data.cold_pitch_message.trim();
    return validatePitch(fixed) ? null : fixed;
  } catch {
    return null;
  }
}

function resolveMunicipality(aiValue: string | undefined, zoneMunicipality: string): string {
  const candidate = (aiValue ?? '').trim();
  if (!candidate) return zoneMunicipality;
  // Ako AI vrati kvart ("Dorćol"), prevodimo ga u zvaničnu opštinu ("Stari Grad").
  const resolved = resolveZone(candidate);
  return resolved ? resolved.municipality : candidate;
}

function pickTier(aiTier: AiVerdict['purchasing_power_tier'] | undefined, ruleTier: AiVerdict['purchasing_power_tier']): AiVerdict['purchasing_power_tier'] {
  if (!aiTier) return ruleTier;
  // Pravila imaju pravo veta na naduvavanje: AI ne sme da podigne STANDARD zonu u HIGH.
  const rank = { STANDARD: 0, MEDIUM: 1, HIGH: 2 } as const;
  return rank[aiTier] > rank[ruleTier] ? ruleTier : aiTier;
}

/** Ključ za dedupe: telefon je primaran, ime+adresa kao rezerva. */
export function buildDedupeKey(e164: string | null, name: string, address: string): string {
  if (e164) return `tel:${e164}`;
  return `fp:${fingerprint(name, address)}`;
}

/**
 * Brzi "smoke test" AI sloja — koristi /api/health i `npm run harvest -- --dry`.
 */
export async function pingAi(): Promise<{ ok: boolean; provider?: string; model?: string; error?: string }> {
  try {
    const res = await route(
      [
        { role: 'system', content: 'Odgovaraš isključivo jednom rečju.' },
        { role: 'user', content: 'Napiši reč: radi' },
      ],
      { task: 'bulk', maxTokens: 10, temperature: 0, label: 'ping' },
    );
    return { ok: true, provider: res.provider, model: res.model };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 300) };
  }
}
