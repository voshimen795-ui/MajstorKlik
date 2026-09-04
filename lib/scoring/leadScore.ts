/**
 * DETERMINISTIČKI SKOR — "kičma" ocene leada.
 *
 * AI je odličan u nijansama, ali je nestabilan: isti lead danas dobije 82,
 * sutra 61. Zato skor računamo pravilima (uvek isto), a AI-ju dozvoljavamo
 * da ga pomeri u okviru težine od 40%. Tako rangiranje ostaje uporedivo
 * kroz vreme, a i dalje hvata kontekst koji pravila ne vide.
 *
 * Raspodela od 100 poena:
 *   40  lokacija (zona × pouzdanost geo-poklapanja)
 *   22  tip objekta (stambena zajednica 22, kafić 18, butik 12…)
 *   15  hitnost (poplava/renoviranje/otvaranje = novac danas)
 *   12  kvalitet kontakta (mobilni > fiksni > bez broja)
 *    8  signali imućnosti u tekstu (lux, penthouse, fine dining…)
 *    3  ozbiljnost firme (broj recenzija — postoji li objekat stvarno)
 *
 * Plus 0-30 za POTVRDJENU POTRAZNJU (radar): neko je javno napisao da mu treba
 * majstor. Zbir se secе na 100, pa takav lead prakticno uvek ide na vrh liste —
 * i treba, jer je to jedina komponenta koja meri stvarnu potrebu.
 */

import { AFFLUENCE_SIGNALS, CRAFTS, TARGET_BY_KIND, URGENCY_SIGNALS, type Craft, type TargetKind } from '../config/categories';
import { classifyLocation, type GeoMatch, type PurchasingPowerTier } from '../config/zones';
import { matchedTerms } from '../utils/text';
import type { ParsedPhone } from '../utils/phoneUtils';

export type Urgency = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface ScoreInput {
  craft: Craft;
  name: string;
  address: string | null;
  description: string | null;
  rawCategory: string | null;
  targetKind: TargetKind | null;
  phone: ParsedPhone | null;
  geo: GeoMatch;
  reviewCount?: number | null;
  rating?: number | null;
  /** Radar potraznje: neko je javno trazio majstora. */
  intent?: 'SEEKING' | 'OFFERING' | 'UNCLEAR';
  /** Starost objave u danima; sto svezije, to vrednije. */
  freshnessDays?: number | null;
}

export interface ScoreBreakdown {
  total: number;
  location: number;
  targetType: number;
  urgency: number;
  contact: number;
  affluence: number;
  credibility: number;
  /** Bonus za potvrdjenu potraznju (0-30). */
  demand: number;
  urgencyLevel: Urgency;
  tier: PurchasingPowerTier;
  signals: {
    urgency: string[];
    affluence: string[];
    demand: string[];
    geo: string[];
  };
  /** Ako je != null, lead treba odbaciti. */
  rejectReason: string | null;
}

const MAX = { location: 40, targetType: 22, urgency: 15, contact: 12, affluence: 8, credibility: 3 } as const;

export function scoreLead(input: ScoreInput): ScoreBreakdown {
  const haystack = [input.name, input.address, input.description, input.rawCategory].filter(Boolean).join(' \n ');

  // --- 1. LOKACIJA (40) ---
  const zone = input.geo.zone;
  const location = zone ? Math.round(MAX.location * zone.weight * Math.max(0.35, input.geo.confidence)) : 0;

  // --- 2. TIP OBJEKTA (22) ---
  const profile = input.targetKind ? TARGET_BY_KIND[input.targetKind] : null;
  const relevance = profile ? profile.relevance[input.craft] : 0.5;
  const targetType = profile ? Math.round(Math.min(MAX.targetType, profile.baseBonus * relevance)) : 6;

  // --- 3. HITNOST (15) ---
  const urgencySignals = matchedTerms(haystack, URGENCY_SIGNALS);
  const demandSignals = matchedTerms(haystack, CRAFTS[input.craft].demandSignals);
  const urgencyRaw = urgencySignals.length * 5 + demandSignals.length * 2.5;
  const urgency = Math.round(Math.min(MAX.urgency, urgencyRaw));
  const urgencyLevel: Urgency =
    urgencySignals.length >= 2 ? 'HIGH' : urgencySignals.length === 1 ? 'MEDIUM' : demandSignals.length > 0 ? 'LOW' : 'NONE';

  // --- 4. KONTAKT (12) ---
  let contact = 0;
  if (input.phone) {
    if (input.phone.whatsappCapable) contact = 12; // mobilni = WhatsApp = odgovor za 10 min
    else if (input.phone.isBelgrade) contact = 7; // fiksni 011 = ozbiljan objekat, ali sporiji kanal
    else contact = 4;
    if (input.phone.confidence < 0.7) contact = Math.round(contact * 0.6);
  }

  // --- 5. IMUĆNOST U TEKSTU (8) ---
  const affluenceSignals = matchedTerms(haystack, AFFLUENCE_SIGNALS);
  const affluence = Math.round(Math.min(MAX.affluence, affluenceSignals.length * 3));

  // --- 6. OZBILJNOST (3) ---
  const reviews = input.reviewCount ?? 0;
  const credibility = reviews >= 100 ? 3 : reviews >= 25 ? 2 : reviews >= 5 ? 1 : 0;

  // --- 7. POTVRDJENA POTRAZNJA (0-30) ---
  // Ovo je jedina komponenta koja meri STVARNU potrebu, a ne pretpostavku.
  // Neko ko je napisao "trazim gipsara" vredi vise od najbogatijeg kafica
  // kome mozda ne treba nista — zato bonus nadmasuje i punu lokaciju.
  let demand = 0;
  if (input.intent === 'SEEKING') {
    demand = 22;
    const dana = input.freshnessDays;
    if (dana !== null && dana !== undefined) {
      if (dana <= 1) demand += 8;
      else if (dana <= 7) demand += 5;
      else if (dana <= 30) demand += 2;
      else demand -= 6; // stariji od mesec dana — verovatno vec resen
    }
  } else if (input.intent === 'UNCLEAR') {
    demand = 6;
  }
  demand = clamp(demand, 0, 30);

  const total = clamp(location + targetType + urgency + contact + affluence + credibility + demand, 1, 100);

  return {
    total,
    location,
    targetType,
    urgency,
    contact,
    affluence,
    credibility,
    demand,
    urgencyLevel,
    tier: deriveTier(input.geo, total, input.intent === 'SEEKING'),
    signals: {
      urgency: urgencySignals,
      affluence: affluenceSignals,
      demand: demandSignals,
      geo: input.geo.evidence,
    },
    rejectReason: findRejectReason(input, total),
  };
}

function findRejectReason(input: ScoreInput, total: number): string | null {
  const haystack = [input.name, input.rawCategory, input.description].filter(Boolean).join(' ').toLowerCase();

  for (const signal of CRAFTS[input.craft].competitorSignals) {
    if (haystack.includes(signal.toLowerCase())) {
      return `konkurencija — objekat i sam nudi uslugu "${signal}"`;
    }
  }
  if (!input.phone && !haystack.includes('kontakt')) {
    return 'nema upotrebljiv broj telefona';
  }
  // Potraznja se NE odbacuje zbog zone: neko ko trazi majstora je posao
  // bez obzira na kvart. Geo i dalje utice na skor, samo ne na odbacivanje.
  if (!input.geo.zone && input.intent !== 'SEEKING') {
    return 'van ciljanih premium zona';
  }
  if (total < Number(process.env.MIN_LEAD_SCORE ?? 45)) {
    return `skor ${total} ispod praga (${process.env.MIN_LEAD_SCORE ?? 45})`;
  }
  return null;
}

function deriveTier(geo: GeoMatch, total: number, isDemand = false): PurchasingPowerTier {
  if (!geo.zone) return isDemand && total >= 60 ? 'MEDIUM' : 'STANDARD';
  if (geo.zone.tier === 'HIGH' && geo.confidence >= 0.85) return 'HIGH';
  if (geo.zone.tier === 'HIGH' || total >= 70) return total >= 60 ? 'HIGH' : 'MEDIUM';
  if (geo.zone.tier === 'MEDIUM' || total >= 55) return 'MEDIUM';
  return 'STANDARD';
}

/**
 * Spaja pravila i AI: 60% pravila, 40% AI. Ako AI nije uspeo, ostaje čist rule score.
 */
export function blendScores(ruleScore: number, aiScore: number | null): number {
  if (aiScore === null || Number.isNaN(aiScore)) return clamp(Math.round(ruleScore), 1, 100);
  return clamp(Math.round(ruleScore * 0.6 + aiScore * 0.4), 1, 100);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Deterministički fallback kada SVI AI provajderi padnu — mašina i dalje
 * proizvodi upotrebljive leadove, samo sa šablonskim pitch-om umesto AI teksta.
 */
export function fallbackPitch(params: {
  craft: Craft;
  clientName: string;
  zoneLabel: string | null;
  targetKind: TargetKind | null;
  urgencyLevel: Urgency;
}): string {
  const craft = CRAFTS[params.craft];
  const profile = params.targetKind ? TARGET_BY_KIND[params.targetKind] : null;
  const objekat = profile ? profile.label.split(' (')[0]!.toLowerCase() : 'vaš prostor';
  const zona = params.zoneLabel ? ` na ${params.zoneLabel}u` : ' u Beogradu';

  const hitno =
    params.urgencyLevel === 'HIGH'
      ? 'Vidim da vam je trenutno hitno — mogu da izađem još danas. '
      : '';

  return (
    `Dobar dan, ${params.clientName}. ` +
    `${hitno}Zovem se [IME], radim ${craft.label.toLowerCase()}ske poslove${zona} — ${craft.pitchAngle}. ` +
    `Radim dosta za ${objekat}e u kraju, pa mogu da izađem na besplatnu procenu i pošaljem fiksnu cenu u roku od 24h, bez obaveze. ` +
    `Da li vam odgovara da svratim ove nedelje?`
  );
}

/** Kratko objašnjenje kad AI nije dostupan. */
export function fallbackReasoning(breakdown: ScoreBreakdown, zoneLabel: string | null): string {
  const parts: string[] = [];
  if (zoneLabel) parts.push(`Lokacija: ${zoneLabel} (${breakdown.location}/40 poena za kupovnu moć)`);
  if (breakdown.signals.urgency.length > 0) parts.push(`Hitnost: ${breakdown.signals.urgency.join(', ')}`);
  if (breakdown.signals.demand.length > 0) parts.push(`Potreba za zanatom: ${breakdown.signals.demand.join(', ')}`);
  if (breakdown.signals.affluence.length > 0) parts.push(`Signali imućnosti: ${breakdown.signals.affluence.join(', ')}`);
  parts.push(`Kontakt: ${breakdown.contact}/12`);
  return `[Automatska ocena bez AI-ja] ${parts.join('. ')}.`;
}
