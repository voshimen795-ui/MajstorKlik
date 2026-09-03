/** Tipovi lead-a kroz ceo pipeline: sirovo -> kvalifikovano -> u bazi. */

import { z } from 'zod';
import type { Craft, TargetKind } from '../config/categories';
import type { PurchasingPowerTier, RichZoneId } from '../config/zones';

export type LeadSource = 'google_maps' | 'registar_sz' | 'oglasi' | 'manual' | 'import';

/** Ono što skreper izvuče sa stranice — sirovo, neočišćeno. */
export interface RawLead {
  source: LeadSource;
  sourceUrl: string;
  /** Naziv firme / ime kontakta / naslov oglasa. */
  name: string;
  rawAddress: string | null;
  rawPhone: string | null;
  /** Kategorija objekta kako je izvor prijavljuje ("Restoran", "Stomatolog"…). */
  rawCategory: string | null;
  /** Sirovi opis / snippet / sadržaj oglasa. */
  rawDescription: string | null;
  /** Za koji zanat je ovaj lead skrejpovan. */
  craft: Craft;
  /** Zona koju smo ciljali (ne mora biti ista kao ona koju AI potvrdi). */
  targetZone: RichZoneId;
  scrapedAt: string;
  /** Dodatni signali sa izvora. */
  meta?: {
    rating?: number | null;
    reviewCount?: number | null;
    website?: string | null;
    priceLevel?: string | null;
    openingHours?: string | null;
    /** Za oglase: cena, kvadratura, broj soba. */
    priceEur?: number | null;
    areaM2?: number | null;
    listingType?: 'prodaja' | 'izdavanje' | null;
  };
}

/** Izlaz AI kvalifikacije — TAČNO polja iz specifikacije + interni dodaci. */
export const QualifiedLeadSchema = z.object({
  client_name: z.string().min(1),
  address: z.string(),
  municipality: z.string(),
  is_high_income_location: z.boolean(),
  phone_e164: z.string(),
  whatsapp_link: z.string(),
  lead_score: z.number().min(1).max(100),
  purchasing_power_tier: z.enum(['HIGH', 'MEDIUM', 'STANDARD']),
  reasoning: z.string(),
  cold_pitch_message: z.string(),
});

export type QualifiedLead = z.infer<typeof QualifiedLeadSchema>;

/** Ono što AI sme da vrati — sve ostalo računamo mi (telefon, link, zona). */
export const AiVerdictSchema = z.object({
  client_name: z.string().min(1).max(200),
  address: z.string().max(300).default(''),
  municipality: z.string().max(120).default(''),
  target_kind: z.string().max(60).optional(),
  /** AI-jeva procena 1-100 pre nego što je ukrstimo sa determinističkim skorom. */
  ai_score: z.number().min(0).max(100),
  purchasing_power_tier: z.enum(['HIGH', 'MEDIUM', 'STANDARD']),
  urgency: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).default('NONE'),
  is_competitor: z.boolean().default(false),
  reasoning: z.string().max(1200),
  cold_pitch_message: z.string().max(700),
});

export type AiVerdict = z.infer<typeof AiVerdictSchema>;

/** Puni zapis koji ide u Supabase. */
export interface LeadRecord extends QualifiedLead {
  id?: string;
  craft: Craft;
  source: LeadSource;
  source_url: string;
  zone_id: RichZoneId | null;
  zone_label: string | null;
  target_kind: TargetKind | string | null;
  segment: 'B2B' | 'B2C';
  urgency: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  phone_national: string | null;
  phone_type: string | null;
  viber_link: string | null;
  sms_link: string | null;
  /** Deterministički deo skora — da se vidi koliko je AI "pomerio" ocenu. */
  rule_score: number;
  ai_score: number | null;
  /** Fingerprint za dedupe kad nema telefona. */
  dedupe_key: string;
  raw_description: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  status: LeadStatus;
  scraped_at: string;
  created_at?: string;
}

export type LeadStatus = 'new' | 'contacted' | 'replied' | 'won' | 'lost' | 'rejected';

export interface QualificationResult {
  lead: LeadRecord | null;
  /** Zašto je lead odbačen (ako jeste). */
  rejectedReason: string | null;
  tier: PurchasingPowerTier;
  usedFallback: boolean;
  aiProvider: string | null;
}
