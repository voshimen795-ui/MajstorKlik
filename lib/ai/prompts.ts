/**
 * Promptovi. Ovde se dobija ili gubi kvalitet leada — ne u modelu.
 *
 * Dva pravila koja se provlače kroz sve:
 *   1. Model NE izmišlja. Ako podatka nema, vraća prazan string, ne pretpostavku.
 *      (Izmišljen broj telefona je gori od nikakvog — majstor zove pogrešnog čoveka.)
 *   2. Poruka se piše kao da je kuca majstor sa telefona, a ne marketing agencija.
 */

import { CRAFTS, TARGET_PROFILES, type Craft, type TargetKind } from '../config/categories';
import { RICH_ZONES, type RichZone } from '../config/zones';
import type { ChatMessage } from './types';
import type { ScoreBreakdown } from '../scoring/leadScore';

/* ------------------------------------------------------------------ */
/*  1) EKSTRAKCIJA — Groq                                              */
/* ------------------------------------------------------------------ */

const EXTRACTION_SYSTEM = `Ti si precizan parser podataka o firmama u Beogradu.
Dobijaš sirov tekst sa veb stranice (Google Maps rezultati, registar, oglasnik).
Zadatak: izvuci SAMO ono što u tekstu STVARNO piše, u strogom JSON formatu.

APSOLUTNA PRAVILA:
- Nikada ne izmišljaj i ne dopunjuj podatke. Ako nešto ne piše, stavi prazan string "".
- Telefone prepiši TAČNO onako kako stoje u tekstu (npr. "011/2435-678"), bez preformatiranja.
- Ignoriši navigaciju, kolačiće, reklame, dugmad, footer i sve što nije podatak o objektu.
- Ne prevodi nazive firmi. Zadrži originalno pismo.
- Vrati isključivo JSON objekat, bez objašnjenja i bez markdown blokova.

FORMAT ODGOVORA:
{"items":[{"name":"","address":"","phone":"","category":"","description":"","website":""}]}`;

export function buildExtractionPrompt(params: {
  rawText: string;
  sourceLabel: string;
  zoneLabel: string;
}): ChatMessage[] {
  return [
    { role: 'system', content: EXTRACTION_SYSTEM },
    {
      role: 'user',
      content: `IZVOR: ${params.sourceLabel}
CILJANA ZONA: ${params.zoneLabel}, Beograd

Izvuci sve objekte/firme/oglase iz teksta ispod. Ako ista firma ima više unosa, spoji ih u jedan.

--- POČETAK TEKSTA ---
${params.rawText}
--- KRAJ TEKSTA ---`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  2) KVALIFIKACIJA I SCORING — Gemini                                */
/* ------------------------------------------------------------------ */

function zoneBlock(zone: RichZone | null): string {
  if (!zone) return 'Zona: NIJE POTVRĐENA premium zona — tretiraj kupovnu moć kao STANDARD.';
  return `Zona: ${zone.label} (opština ${zone.municipality})
Nivo kupovne moći zone: ${zone.tier} (težina ${zone.weight})
Kontekst zone: ${zone.note}`;
}

function craftBlock(craft: Craft): string {
  const c = CRAFTS[craft];
  return `Zanat majstora: ${c.label}
Šta majstor nudi: ${c.pitchAngle}
Tipična vrednost posla u premium zoni: ${c.avgTicketEur[0]}–${c.avgTicketEur[1]} EUR`;
}

function targetBlock(kind: TargetKind | null): string {
  const profile = TARGET_PROFILES.find((p) => p.kind === kind);
  if (!profile) return 'Tip objekta: nepoznat — proceni iz naziva i opisa.';
  return `Tip objekta: ${profile.label} (${profile.segment})
Zašto ovaj tip plaća: ${profile.painPoint}`;
}

const QUALIFY_SYSTEM = `Ti si iskusan procenitelj poslovnih prilika za zanatlije u Beogradu.
Za dati objekat procenjuješ koliko je dobar klijent za majstora i pišeš prvu poruku.

KAKO OCENJUJEŠ (ai_score, 0-100):
- 85-100: premium lokacija + objekat koji hitno mora da reši problem + jasan kontakt.
- 65-84:  premium lokacija, ozbiljan objekat, potreba postoji ali nije hitna.
- 45-64:  dobra lokacija ali slab signal potrebe, ili slabiji kraj sa jakim signalom.
- 0-44:   slaba lokacija, nema signala potrebe, ili je objekat konkurencija.

KAKO PIŠEŠ cold_pitch_message (najvažnije polje):
- Srpski jezik, latinica, obraćanje sa "Vi". Ton: smiren profesionalac, NE prodavac.
- 300-500 karaktera. Bez emodžija, bez velikih slova, bez uzvičnika u nizu.
- Struktura: (1) pozdrav sa imenom objekta, (2) JEDNA konkretna rečenica koja pokazuje
  da znaš čime se bave i gde su, (3) konkretna ponuda vezana za njihov problem,
  (4) jedno pitanje na kraju na koje je lako odgovoriti sa "da".
- Zabranjeno: "poštovani", "najbolji u gradu", "akcija", "popust", laganje o preporukama,
  izmišljanje da si već radio za njih ili za nekog iz njihove zgrade.
- Ostavi doslovno [IME] i [TELEFON] kao rezervisana mesta koja majstor sam popunjava.

reasoning: 2-4 rečenice na srpskom, konkretno — zašto baš ovaj objekat ima novca
i zašto mu baš sada treba ovaj zanat. Bez opštih fraza.

Vrati ISKLJUČIVO JSON objekat sa tačno ovim poljima:
{"client_name":"","address":"","municipality":"","target_kind":"","ai_score":0,
 "purchasing_power_tier":"HIGH|MEDIUM|STANDARD","urgency":"NONE|LOW|MEDIUM|HIGH",
 "is_competitor":false,"reasoning":"","cold_pitch_message":""}`;

export function buildQualifyPrompt(params: {
  craft: Craft;
  name: string;
  address: string | null;
  phoneNational: string | null;
  rawCategory: string | null;
  description: string | null;
  sourceUrl: string;
  zone: RichZone | null;
  targetKind: TargetKind | null;
  breakdown: ScoreBreakdown;
}): ChatMessage[] {
  const b = params.breakdown;
  return [
    { role: 'system', content: QUALIFY_SYSTEM },
    {
      role: 'user',
      content: `PODACI O OBJEKTU
Naziv: ${params.name}
Adresa: ${params.address || '(nepoznata)'}
Telefon: ${params.phoneNational || '(nema)'}
Kategorija sa izvora: ${params.rawCategory || '(nema)'}
Opis / sadržaj: ${params.description ? params.description.slice(0, 1500) : '(nema)'}
Izvor: ${params.sourceUrl}

${zoneBlock(params.zone)}

${craftBlock(params.craft)}

${targetBlock(params.targetKind)}

AUTOMATSKA ANALIZA (već izračunata pravilima — koristi je, ne ponavljaj je):
- Ukupan skor po pravilima: ${b.total}/100
- Lokacija ${b.location}/40 | Tip objekta ${b.targetType}/22 | Hitnost ${b.urgency}/15 | Kontakt ${b.contact}/12 | Imućnost ${b.affluence}/8
- Prepoznati signali hitnosti: ${b.signals.urgency.join(', ') || 'nema'}
- Prepoznata potreba za zanatom: ${b.signals.demand.join(', ') || 'nema'}
- Geo dokazi: ${b.signals.geo.join(' | ') || 'nema'}

Proceni objekat i vrati JSON.`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  3) BATCH KVALIFIKACIJA — kad štedimo kvotu                         */
/* ------------------------------------------------------------------ */

const BATCH_SYSTEM = `${QUALIFY_SYSTEM}

Dobijaš VIŠE objekata odjednom. Vrati JSON: {"results":[ ...po jedan objekat kao gore... ]}
Redosled u nizu MORA odgovarati redosledu ulaznih objekata. Ako neki objekat nema
dovoljno podataka, i dalje vrati unos za njega sa ai_score 0 i objašnjenjem.`;

export function buildBatchQualifyPrompt(params: {
  craft: Craft;
  zoneLabel: string;
  items: {
    index: number;
    name: string;
    address: string | null;
    phoneNational: string | null;
    rawCategory: string | null;
    description: string | null;
    ruleScore: number;
    zoneId: string | null;
  }[];
}): ChatMessage[] {
  const zone = params.items[0]?.zoneId ? RICH_ZONES[params.items[0].zoneId as keyof typeof RICH_ZONES] ?? null : null;
  return [
    { role: 'system', content: BATCH_SYSTEM },
    {
      role: 'user',
      content: `${craftBlock(params.craft)}

Ciljana zona pretrage: ${params.zoneLabel}
${zoneBlock(zone)}

OBJEKTI (${params.items.length}):
${params.items
  .map(
    (it) =>
      `[${it.index}] ${it.name} | adresa: ${it.address || '-'} | tel: ${it.phoneNational || '-'} | kategorija: ${
        it.rawCategory || '-'
      } | skor pravila: ${it.ruleScore} | opis: ${(it.description || '-').slice(0, 400)}`,
  )
  .join('\n')}

Vrati JSON sa nizom "results" iste dužine (${params.items.length}).`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/*  4) POPRAVKA PORUKE — kad pitch ispadne loš                         */
/* ------------------------------------------------------------------ */

export function buildPitchRewritePrompt(params: {
  craft: Craft;
  clientName: string;
  zoneLabel: string | null;
  problem: string;
  previousMessage: string;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `Prepravljaš prvu poruku koju majstor šalje potencijalnom klijentu na WhatsApp.
Srpski, latinica, obraćanje sa "Vi", 300-500 karaktera, bez emodžija i bez marketinškog jezika.
Zadrži [IME] i [TELEFON] kao rezervisana mesta. Vrati JSON: {"cold_pitch_message":""}`,
    },
    {
      role: 'user',
      content: `Majstor: ${CRAFTS[params.craft].label} (${CRAFTS[params.craft].pitchAngle})
Klijent: ${params.clientName}${params.zoneLabel ? `, ${params.zoneLabel}` : ''}
Problem sa prethodnom porukom: ${params.problem}

Prethodna poruka:
"""${params.previousMessage}"""

Napiši bolju verziju.`,
    },
  ];
}
