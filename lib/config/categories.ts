/**
 * ŠTA TRAŽIMO — kategorije zanata i profili ciljnih klijenata.
 *
 * Bitna inverzija koju ljudi promaše: NE tražimo majstore (konkurenciju),
 * tražimo OBJEKTE KOJIMA MAJSTOR TREBA. Zato su `b2bQueries` upiti za
 * kafiće, ordinacije i salone — to su leadovi, ne konkurencija.
 */

import type { RichZoneId } from './zones';

export type Craft = 'vodoinstalater' | 'gipsar' | 'moler';

export type TargetKind =
  | 'ugostiteljstvo'
  | 'salon_lepote'
  | 'stomatologija'
  | 'privatna_klinika'
  | 'advokatska_kancelarija'
  | 'teretana'
  | 'stambena_zajednica'
  | 'agencija_nekretnine'
  | 'kancelarija'
  | 'maloprodaja'
  | 'nekretnina_oglas';

export interface TargetProfile {
  kind: TargetKind;
  label: string;
  /** Google Maps upiti (srpski, onako kako su objekti stvarno upisani). */
  queries: readonly string[];
  /** Zašto ovaj tip objekta plaća — ide u AI prompt kao kontekst. */
  painPoint: string;
  /** Koliko je relevantan po zanatu (0-1). */
  relevance: Readonly<Record<Craft, number>>;
  /** Bazni bonus na skor (0-20). */
  baseBonus: number;
  segment: 'B2B' | 'B2C';
}

export const TARGET_PROFILES: readonly TargetProfile[] = [
  {
    kind: 'ugostiteljstvo',
    label: 'Ugostiteljski objekat (kafić / restoran / bar)',
    queries: ['restoran', 'kafić', 'kafe bar', 'bar', 'kafana', 'picerija', 'bistro', 'poslastičarnica', 'kafeterija'],
    painPoint:
      'Kuhinja i toalet rade 16h dnevno. Curenje ili zapušenje = zatvaranje objekta i gubitak dnevnog pazara (300-1500€), pa plaćaju hitnu intervenciju bez pogovora. Enterijer se osvežava na 2-4 godine.',
    relevance: { vodoinstalater: 1.0, gipsar: 0.75, moler: 0.85 },
    baseBonus: 18,
    segment: 'B2B',
  },
  {
    kind: 'salon_lepote',
    label: 'Salon lepote / frizerski / kozmetički salon',
    queries: ['frizerski salon', 'kozmetički salon', 'salon lepote', 'nadogradnja noktiju', 'beauty salon', 'barbershop', 'spa salon'],
    painPoint:
      'Voda je alat zanata (glave za pranje kose, sudopere, sterilizacija). Izgled prostora je direktno marketing — zid sa flekom tera mušterije. Renoviraju često i vole "instagramabilan" gips i boju.',
    relevance: { vodoinstalater: 0.9, gipsar: 0.85, moler: 0.95 },
    baseBonus: 16,
    segment: 'B2B',
  },
  {
    kind: 'stomatologija',
    label: 'Stomatološka ordinacija',
    queries: ['stomatološka ordinacija', 'zubar', 'stomatolog', 'dental centar', 'ortodoncija', 'implantologija'],
    painPoint:
      'Sanitarni uslovi su zakonska obaveza (inspekcija). Instalacije za stolice, kompresor i aspiraciju traže stručnjaka, a prostor mora izgledati sterilno-besprekorno. Marže su ogromne — cena majstora im je zanemarljiva stavka.',
    relevance: { vodoinstalater: 0.95, gipsar: 0.8, moler: 0.9 },
    baseBonus: 20,
    segment: 'B2B',
  },
  {
    kind: 'privatna_klinika',
    label: 'Privatna klinika / poliklinika / laboratorija',
    queries: ['privatna klinika', 'poliklinika', 'ordinacija', 'medicinska laboratorija', 'estetska hirurgija', 'fizikalna terapija'],
    painPoint:
      'Isto kao stomatologija, samo veći kvadrat i veći budžet. Plaćaju po fakturi, traže PDV račun i majstora koji može da radi van radnog vremena.',
    relevance: { vodoinstalater: 0.9, gipsar: 0.9, moler: 0.9 },
    baseBonus: 20,
    segment: 'B2B',
  },
  {
    kind: 'advokatska_kancelarija',
    label: 'Advokatska / notarska / konsalting kancelarija',
    queries: ['advokatska kancelarija', 'advokat', 'javni beležnik', 'notar', 'knjigovodstvena agencija', 'konsalting'],
    painPoint:
      'Reprezentativan prostor je deo imidža pred klijentima. Ne cenjkaju se, ali traže tačnost i da se posao završi vikendom da ne prekida rad kancelarije.',
    relevance: { vodoinstalater: 0.6, gipsar: 0.85, moler: 0.95 },
    baseBonus: 15,
    segment: 'B2B',
  },
  {
    kind: 'teretana',
    label: 'Teretana / fitnes / pilates / joga studio',
    queries: ['teretana', 'fitnes centar', 'pilates studio', 'joga studio', 'crossfit', 'wellness centar'],
    painPoint:
      'Tuševi i svlačionice su non-stop pod vodom — česti kvarovi, vlaga i buđ. Zidovi stradaju od opreme. Renoviranje se planira u niskoj sezoni (jul-avgust).',
    relevance: { vodoinstalater: 1.0, gipsar: 0.7, moler: 0.9 },
    baseBonus: 15,
    segment: 'B2B',
  },
  {
    kind: 'stambena_zajednica',
    label: 'Stambena zajednica / profesionalni upravnik',
    queries: [
      'profesionalni upravnik zgrade', 'upravnik stambene zajednice', 'upravljanje zgradama',
      'održavanje zgrada', 'agencija za upravljanje zgradama',
    ],
    painPoint:
      'NAJVREDNIJI B2B LEAD: jedan upravnik drži 20-80 zgrada. Ako uđeš kod njega, dobijaš ponavljajuće poslove (krečenje hodnika, sanacija vlage u podrumu, zamena vertikala) bez ijednog daljeg marketinga. Imaju budžet iz mesečne naknade i moraju da ga potroše.',
    relevance: { vodoinstalater: 1.0, gipsar: 0.8, moler: 1.0 },
    baseBonus: 22,
    segment: 'B2B',
  },
  {
    kind: 'agencija_nekretnine',
    label: 'Agencija za nekretnine',
    queries: ['agencija za nekretnine', 'real estate agencija', 'posredovanje u prometu nekretnina'],
    painPoint:
      'Agent zarađuje na brzoj prodaji. Osvežen stan se prodaje 15-20 dana brže i za 3-5% više, pa agencije aktivno traže "svog" molera i gipsara kojeg preporučuju vlasnicima. Jedan dobar odnos = 10+ stanova godišnje.',
    relevance: { vodoinstalater: 0.7, gipsar: 0.9, moler: 1.0 },
    baseBonus: 19,
    segment: 'B2B',
  },
  {
    kind: 'kancelarija',
    label: 'Poslovni prostor / co-working / IT firma',
    queries: ['poslovni prostor', 'coworking', 'IT kompanija', 'poslovni centar', 'kancelarijski prostor'],
    painPoint:
      'Pregradni zidovi i spušteni plafoni (gips) se prave pri svakom preseljenju ili rastu tima. Rade po projektu i po fakturi.',
    relevance: { vodoinstalater: 0.5, gipsar: 1.0, moler: 0.85 },
    baseBonus: 14,
    segment: 'B2B',
  },
  {
    kind: 'maloprodaja',
    label: 'Butik / prodavnica / apoteka',
    queries: ['butik', 'apoteka', 'prodavnica', 'showroom', 'optika', 'zlatara'],
    painPoint:
      'Izlog i enterijer se menjaju sezonski. Gipsani elementi za osvetljenje i police su standard, a krečenje ide uz svaku promenu kolekcije/brendinga.',
    relevance: { vodoinstalater: 0.4, gipsar: 0.9, moler: 0.9 },
    baseBonus: 12,
    segment: 'B2B',
  },
  {
    kind: 'nekretnina_oglas',
    label: 'Oglas za prodaju/izdavanje lux nekretnine',
    queries: [],
    painPoint:
      'Stan koji se prodaje ili izdaje mora da izgleda useljivo. Vlasnik zna da mu ulaganje od 1500€ u moleraj i gips vrati 5000€ na ceni. Najhitniji tip B2C leada — ima rok (useljenje/otvaranje oglasa).',
    relevance: { vodoinstalater: 0.6, gipsar: 0.85, moler: 1.0 },
    baseBonus: 13,
    segment: 'B2C',
  },
] as const;

export const TARGET_BY_KIND: Readonly<Record<TargetKind, TargetProfile>> = Object.fromEntries(
  TARGET_PROFILES.map((p) => [p.kind, p]),
) as Record<TargetKind, TargetProfile>;

export interface CraftConfig {
  craft: Craft;
  label: string;
  /** Reči koje u opisu objekta signaliziraju POTREBU za ovim zanatom. */
  demandSignals: readonly string[];
  /** Reči koje znače da je objekat KONKURENCIJA, ne klijent — izbacujemo ih. */
  competitorSignals: readonly string[];
  /** Prosečna vrednost posla u premium zoni (EUR) — za ROI kalkulaciju u UI. */
  avgTicketEur: readonly [number, number];
  /** Kratak opis usluge za pitch. */
  pitchAngle: string;
}

export const CRAFTS: Readonly<Record<Craft, CraftConfig>> = {
  vodoinstalater: {
    craft: 'vodoinstalater',
    label: 'Vodoinstalater',
    demandSignals: [
      'curenje', 'poplava', 'vlaga', 'zapušen', 'začepljen', 'odvod', 'kanalizacija',
      'bojler', 'vodokotlić', 'slavina', 'kupatilo', 'sanitarije', 'vertikala',
      'cevi', 'kotao', 'grejanje', 'radijator', 'hitno', 'kvar', 'renoviranje kupatila',
    ],
    competitorSignals: ['vodoinstalater', 'vodoinstalaterske usluge', 'servis bojlera', 'odgušenje', 'majstor za vodu'],
    avgTicketEur: [80, 2500],
    pitchAngle: 'hitne intervencije bez čekanja + kompletno renoviranje kupatila',
  },
  gipsar: {
    craft: 'gipsar',
    label: 'Gipsar',
    demandSignals: [
      'spušten plafon', 'spušteni plafon', 'gips', 'knauf', 'pregradni zid', 'rigips',
      'led rasveta', 'niša', 'renoviranje', 'adaptacija', 'preuređenje', 'zvučna izolacija',
      'termoizolacija', 'sanacija plafona', 'lux enterijer', 'projekat enterijera',
    ],
    competitorSignals: ['gipsar', 'gipsarski radovi', 'knauf montaža', 'suva gradnja'],
    avgTicketEur: [400, 8000],
    pitchAngle: 'spušteni plafoni sa LED rasvetom, pregradni zidovi i suva gradnja',
  },
  moler: {
    craft: 'moler',
    label: 'Moler',
    demandSignals: [
      'krečenje', 'moleraj', 'gletovanje', 'farbanje', 'boja zidova', 'osvežavanje',
      'renoviranje', 'useljivo', 'pred useljenje', 'sređen stan', 'vlaga', 'buđ',
      'dekorativni malter', 'tapete', 'fasada', 'hodnik zgrade',
    ],
    competitorSignals: ['moler', 'molerski radovi', 'moleraj usluge', 'gletovanje i krečenje'],
    avgTicketEur: [250, 5000],
    pitchAngle: 'gletovanje i krečenje bez prašine, useljivo isti dan',
  },
} as const;

/** Signali hitnosti — najjači pojedinačni multiplikator konverzije. */
export const URGENCY_SIGNALS: readonly string[] = [
  'hitno', 'hitna', 'odmah', 'danas', 'isti dan', 'poplava', 'curi', 'pukla cev',
  'ne radi', 'kvar', 'zatvoreno zbog', 'u toku renoviranja', 'renoviranje u toku',
  'otvaramo uskoro', 'uskoro otvaranje', 'privremeno zatvoreno', 'preseljenje',
  'novi lokal', 'useljenje', 'primopredaja',
];

/** Signali da objekat ima novca (nezavisno od lokacije). */
export const AFFLUENCE_SIGNALS: readonly string[] = [
  'lux', 'luks', 'luxury', 'premium', 'exclusive', 'ekskluziv', 'vip', 'boutique', 'butik',
  'penthouse', 'duplex', 'vila', 'salonac', 'salonski stan', 'novogradnja', 'visoka klasa',
  'dizajnerski', 'projektovan enterijer', 'concept store', 'fine dining',
];

/** Upiti za jednu kategoriju i zonu — ono čime hranimo skreper. */
export function buildQueryPack(craft: Craft, zoneLabel: string): string[] {
  const cfg = CRAFTS[craft];
  const queries: string[] = [];

  for (const profile of TARGET_PROFILES) {
    if (profile.relevance[craft] < 0.7) continue;
    for (const q of profile.queries) {
      queries.push(`${q} ${zoneLabel} Beograd`);
    }
  }

  // Jedan "demand" upit — objekti koji su bukvalno u renoviranju.
  queries.push(`renoviranje ${zoneLabel} Beograd`);
  void cfg;

  return Array.from(new Set(queries));
}

export function isCompetitor(text: string, craft: Craft): boolean {
  const normalized = text.toLowerCase();
  return CRAFTS[craft].competitorSignals.some((s) => normalized.includes(s.toLowerCase()));
}
