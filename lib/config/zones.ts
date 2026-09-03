/**
 * GEO JEZGRO SISTEMA — "high ticket" zone Beograda.
 *
 * Ovo je najvažniji fajl u celoj mašini. Lead iz Dedinja i lead iz Padinske Skele
 * NISU isti posao: isti gipsani plafon se u Vračaru naplati 2-3x više i klijent
 * ne cenjka. Zato geografija ovde nosi najveću težinu u skoru.
 *
 * `weight` (0-1) je multiplikator kupovne moći — direktno ulazi u lead_score.
 * `anchors` su koordinate oko kojih Google Maps skreper "cilja" pretragu
 * (Maps rangira po blizini centra mape, pa bez ankera dobijaš celu Srbiju).
 */

import { normalizeSr } from '../utils/text';

export type PurchasingPowerTier = 'HIGH' | 'MEDIUM' | 'STANDARD';

export type RichZoneId =
  | 'vracar'
  | 'stari-grad'
  | 'dorcol'
  | 'savski-venac'
  | 'senjak'
  | 'dedinje'
  | 'zvezdara'
  | 'palilula-centar'
  | 'novi-beograd-lux';

export interface GeoAnchor {
  /** Ime tačke oko koje centriramo Maps pretragu. */
  label: string;
  lat: number;
  lng: number;
  /** Zoom za Google Maps URL (17-15 = kvart, 14 = širi kraj). */
  zoom: number;
}

export interface RichZone {
  id: RichZoneId;
  /** Kako se zove u UI-ju i u AI promptu. */
  label: string;
  /** Zvanična opština (za grupisanje i izveštaje). */
  municipality: string;
  tier: PurchasingPowerTier;
  /** 0-1, multiplikator kupovne moći. Dedinje 1.0, Zvezdara 0.72. */
  weight: number;
  /** Kvartovi/podnaselja — koriste se i za matching i za Maps upite. */
  quarters: readonly string[];
  /**
   * Ulice-signali. Ako se adresa poklopi sa nekom od ovih ulica, znamo
   * pouzdano da je lead u skupom delu, čak i kad opština nije navedena.
   */
  streetSignals: readonly string[];
  /** Poštanski brojevi koji pokrivaju zonu. */
  postalCodes: readonly string[];
  anchors: readonly GeoAnchor[];
  /** Kratka beleška koju prosleđujemo LLM-u kao kontekst za pitch. */
  note: string;
}

export const RICH_ZONES: Readonly<Record<RichZoneId, RichZone>> = {
  vracar: {
    id: 'vracar',
    label: 'Vračar',
    municipality: 'Vračar',
    tier: 'HIGH',
    weight: 0.96,
    quarters: ['Neimar', 'Crveni krst', 'Kalenić', 'Kalenić pijaca', 'Cvetni trg', 'Hram Svetog Save', 'Slavija', 'Čubura', 'Katanićeva', 'Vračarski plato'],
    streetSignals: [
      'Njegoševa', 'Krunska', 'Kneginje Zorke', 'Molerova', 'Maksima Gorkog', 'Makenzijeva',
      'Katanićeva', 'Sveti Sava', 'Svetog Save', 'Golsvortijeva', 'Bulevar oslobođenja',
      'Cara Nikolaja II', 'Internacionalnih brigada', 'Mileševska', 'Gospodara Vučića',
      'Beogradska', 'Kičevska', 'Šumatovačka', 'Alekse Nenadovića', 'Vojvode Dragomira',
    ],
    postalCodes: ['11000', '11118'],
    anchors: [
      { label: 'Hram Svetog Save', lat: 44.7981, lng: 20.4692, zoom: 16 },
      { label: 'Kalenić pijaca', lat: 44.7967, lng: 20.4771, zoom: 16 },
      { label: 'Cvetni trg', lat: 44.8055, lng: 20.4657, zoom: 16 },
    ],
    note: 'Najgušća koncentracija stanova od 200k€+ i privatnih ordinacija u Beogradu. Stari stanovi (1930-1980) => stalno renoviranje, gipsani plafoni, kompletno krečenje pred prodaju.',
  },

  'stari-grad': {
    id: 'stari-grad',
    label: 'Stari Grad',
    municipality: 'Stari Grad',
    tier: 'HIGH',
    weight: 0.97,
    quarters: ['Kosančićev venac', 'Skadarlija', 'Knez Mihailova', 'Trg Republike', 'Kalemegdan', 'Obilićev venac', 'Studentski trg'],
    streetSignals: [
      'Knez Mihailova', 'Kneza Mihaila', 'Obilićev venac', 'Kosančićev venac', 'Skadarska',
      'Kralja Petra', 'Uzun Mirkova', 'Vuka Karadžića', 'Čika Ljubina', 'Simina',
      'Kapetan Mišina', 'Zmaj Jovina', 'Terazije', 'Nušićeva', 'Palmotićeva', 'Makedonska',
      'Braće Jugovića', 'Francuska', 'Balkanska',
    ],
    postalCodes: ['11000', '11103'],
    anchors: [
      { label: 'Trg Republike', lat: 44.8165, lng: 20.4602, zoom: 16 },
      { label: 'Knez Mihailova', lat: 44.8176, lng: 20.4568, zoom: 17 },
      { label: 'Skadarlija', lat: 44.8186, lng: 20.4638, zoom: 17 },
    ],
    note: 'Zona ugostiteljstva i turizma. Kafići i restorani renoviraju enterijer svakih 2-4 godine i imaju hitne vodoinstalaterske intervencije (kuhinja mora da radi ISTI DAN).',
  },

  dorcol: {
    id: 'dorcol',
    label: 'Dorćol',
    municipality: 'Stari Grad',
    tier: 'HIGH',
    weight: 0.94,
    quarters: ['Gornji Dorćol', 'Donji Dorćol', 'Strahinjića Bana', 'Silikonska dolina', 'Beton hala', 'Dunavska padina'],
    streetSignals: [
      'Strahinjića Bana', 'Cara Dušana', 'Gospodar Jevremova', 'Gospodar Jovanova',
      'Dobračina', 'Kralja Petra', 'Dositejeva', 'Cara Uroša', 'Visokog Stevana',
      'Skender-begova', 'Solunska', 'Braće Baruh', 'Jevrejska',
      'Mike Alasa', 'Tadeuša Košćuška', 'Dunavska', 'Rige od Fere', 'Knićaninova',
    ],
    postalCodes: ['11000', '11103'],
    anchors: [
      { label: 'Strahinjića Bana', lat: 44.8232, lng: 20.4635, zoom: 17 },
      { label: 'Dorćol / Cara Dušana', lat: 44.8253, lng: 20.4585, zoom: 16 },
      { label: 'Beton hala', lat: 44.8199, lng: 20.4477, zoom: 17 },
    ],
    note: 'Loftovi, agencije, butik saloni i "Silikonska dolina" kafići. Vlasnici su mlađi preduzetnici — odgovaraju na WhatsApp, plaćaju brzinu, ne cenjkaju se oko 10%.',
  },

  'savski-venac': {
    id: 'savski-venac',
    label: 'Savski venac',
    municipality: 'Savski venac',
    tier: 'HIGH',
    weight: 0.95,
    quarters: ['Beograd na vodi', 'Savamala', 'Mostar', 'Topčidersko brdo', 'Zapadni Vračar', 'Klinički centar', 'Prokop'],
    streetSignals: [
      'Kneza Miloša', 'Birčaninova', 'Nemanjina', 'Sarajevska', 'Balkanska',
      'Karađorđeva', 'Hercegovačka', 'Kraljice Natalije', 'Resavska', 'Deligradska',
      'Bulevar vojvode Mišića', 'Topčiderska', 'Andre Nikolića', 'Đušina',
      'Bulevar Vudroa Vilsona', 'Vojvode Milenka', 'Durmitorska',
    ],
    postalCodes: ['11000', '11040'],
    anchors: [
      { label: 'Beograd na vodi', lat: 44.8087, lng: 20.4471, zoom: 16 },
      { label: 'Kneza Miloša', lat: 44.8076, lng: 20.4589, zoom: 16 },
      { label: 'Topčidersko brdo', lat: 44.7862, lng: 20.4453, zoom: 15 },
    ],
    note: 'Ambasade, advokatske kancelarije, privatne klinike i novogradnja Beograda na vodi. Ovde firme plaćaju po fakturi bez pregovora, ali traže urednost i termin.',
  },

  senjak: {
    id: 'senjak',
    label: 'Senjak',
    municipality: 'Savski venac',
    tier: 'HIGH',
    weight: 0.98,
    quarters: ['Senjak', 'Mali Senjak', 'Topčider', 'Lisičji potok'],
    streetSignals: [
      'Vasilija Gaćeše', 'Bulevar vojvode Putnika', 'Petra Čajkovskog', 'Šekspirova',
      'Bogdana Popovića', 'Save Kovačevića', 'Radnička', 'Milovana Milovanovića',
      'Iločka', 'Puškinova', 'Vase Pelagića', 'Nedeljka Čabrinovića',
    ],
    postalCodes: ['11000', '11040'],
    anchors: [
      { label: 'Senjak', lat: 44.7893, lng: 20.4384, zoom: 16 },
      { label: 'Topčider park', lat: 44.7812, lng: 20.4499, zoom: 16 },
    ],
    note: 'Vile i rezidencije, mnogo iznajmljivanja diplomatama. Renoviranje se radi pred svaki novi zakup — moleraj + gips gotovo obavezno.',
  },

  dedinje: {
    id: 'dedinje',
    label: 'Dedinje',
    municipality: 'Savski venac',
    tier: 'HIGH',
    weight: 1.0,
    quarters: ['Gornje Dedinje', 'Donje Dedinje', 'Dedinje', 'Beli dvor', 'Banovo brdo (gornje)', 'Lisičji potok'],
    streetSignals: [
      'Užička', 'Tolstojeva', 'Puškinova', 'Bulevar kneza Aleksandra Karađorđevića',
      'Rumunska', 'Boška Buhe', 'Vase Pelagića', 'Teodora Drajzera', 'Aleksandra Stambolijskog',
      'Maglajska', 'Bulevar mira', 'Njegoševa (Dedinje)', 'Milana Rakića', 'Jovana Bijelića',
    ],
    postalCodes: ['11000', '11040'],
    anchors: [
      { label: 'Dedinje / Užička', lat: 44.7735, lng: 20.4507, zoom: 16 },
      { label: 'Tolstojeva', lat: 44.7784, lng: 20.4457, zoom: 16 },
    ],
    note: 'Najskuplja stambena zona u Srbiji. Malo objekata ali svaki posao je 5-6 cifara. Klijent traži diskreciju, tačnost i preporuku — cena je poslednja stavka o kojoj se priča.',
  },

  zvezdara: {
    id: 'zvezdara',
    label: 'Zvezdara',
    municipality: 'Zvezdara',
    tier: 'MEDIUM',
    weight: 0.78,
    quarters: ['Istra', 'Lion', 'Vukov spomenik', 'Đeram', 'Cvetkova pijaca', 'Zvezdarska šuma', 'Lipov lad', 'Bulbulder', 'Profesorska kolonija'],
    streetSignals: [
      'Vojislava Ilića', 'Ustanička', 'Bulevar kralja Aleksandra', 'Batutova',
      'Mite Ružića', 'Dimitrija Tucovića', 'Milana Rakića', 'Gospodara Vučića',
      'Živka Davidovića', 'Bulevar Peka Dapčevića', 'Preševska', 'Vjekoslava Kovača',
    ],
    postalCodes: ['11000', '11050', '11120'],
    anchors: [
      { label: 'Vukov spomenik', lat: 44.8062, lng: 20.4869, zoom: 16 },
      { label: 'Cvetkova pijaca / Lion', lat: 44.7975, lng: 20.4986, zoom: 16 },
      { label: 'Zvezdara - Istra', lat: 44.7938, lng: 20.5108, zoom: 16 },
    ],
    note: 'Solidna srednja klasa + puno novogradnje oko Ustaničke. Ne dostiže Vračar po ceni, ali ima ogroman VOLUMEN stambenih zajednica sa profesionalnim upravnicima (redovni ugovorni poslovi).',
  },

  'palilula-centar': {
    id: 'palilula-centar',
    label: 'Palilula (Centar)',
    municipality: 'Palilula',
    tier: 'MEDIUM',
    weight: 0.8,
    quarters: ['Tašmajdan', 'Profesorska kolonija', 'Hadžipopovac', 'Botanička bašta', 'Palilulska pijaca', 'Bogoslovija'],
    streetSignals: [
      'Takovska', 'Cvijićeva', 'Đušina', 'Kneza Danila', 'Starine Novaka',
      'Dalmatinska', 'Vojvode Dobrnjca', 'Zdravka Čelara', '27. marta', '29. novembra',
      'Ilije Garašanina', 'Palmotićeva', 'Beogradska',
    ],
    postalCodes: ['11000', '11060', '11108'],
    anchors: [
      { label: 'Tašmajdan', lat: 44.8113, lng: 20.4708, zoom: 16 },
      { label: 'Profesorska kolonija', lat: 44.8172, lng: 20.4795, zoom: 16 },
    ],
    note: 'Uži centar Palilule je faktički produžetak Vračara po cenama. Puno starih zgrada sa vlagom => gips + moler ide u paketu.',
  },

  'novi-beograd-lux': {
    id: 'novi-beograd-lux',
    label: 'Novi Beograd (lux blokovi)',
    municipality: 'Novi Beograd',
    tier: 'HIGH',
    weight: 0.88,
    quarters: [
      'A Blok', 'Blok 19a', 'Belville', 'West 65', 'Blok 67a', 'Bežanijska kosa',
      'Blok 11a', 'Blok 21', 'Blok 30', 'Airport City', 'Skyline', 'Wellport', 'Blok 63',
    ],
    streetSignals: [
      'Bulevar Mihajla Pupina', 'Bulevar Zorana Đinđića', 'Omladinskih brigada',
      'Španskih boraca', 'Milutina Milankovića', 'Vladimira Popovića', 'Antifašističke borbe',
      'Đorđa Stanojevića', 'Jurija Gagarina', 'Nehruova', 'Vojvođanska', 'Partizanske avijacije',
      'Aleksinačkih rudara', 'Bulevar Arsenija Čarnojevića', 'Tošin bunar',
    ],
    postalCodes: ['11070', '11080'],
    anchors: [
      { label: 'Belville / Blok 67', lat: 44.8093, lng: 20.3893, zoom: 16 },
      { label: 'A Blok / Bul. M. Pupina', lat: 44.8206, lng: 20.4171, zoom: 16 },
      { label: 'West 65 / Bežanijska kosa', lat: 44.8188, lng: 20.3826, zoom: 16 },
    ],
    note: 'Novogradnja + korporativni zakupci. Stanovi se izdaju stranim menadžerima => vlasnici osvežavaju stan između zakupa (moleraj svakih 12-24 meseca). Stambene zajednice imaju profesionalne upravnike i budžet.',
  },
} as const;

export const RICH_ZONE_IDS = Object.keys(RICH_ZONES) as RichZoneId[];

/**
 * Alias mapa: kako korisnik/skreper/AI može da napiše zonu -> kanonski id.
 * Namerno uključuje i tvoje skraćenice iz brifa ("Dordol", "Vracar").
 */
const ZONE_ALIASES: Record<string, RichZoneId> = {};
function registerAlias(alias: string, id: RichZoneId) {
  ZONE_ALIASES[normalizeSr(alias)] = id;
}
for (const zone of Object.values(RICH_ZONES)) {
  registerAlias(zone.id, zone.id);
  registerAlias(zone.label, zone.id);
  for (const q of zone.quarters) registerAlias(q, zone.id);
}
registerAlias('Dordol', 'dorcol');
registerAlias('Dorcol', 'dorcol');
registerAlias('Vracar', 'vracar');
registerAlias('Stari grad', 'stari-grad');
registerAlias('Savski Venac', 'savski-venac');
registerAlias('Novi Beograd', 'novi-beograd-lux');
registerAlias('Novi Bgd', 'novi-beograd-lux');
registerAlias('NBG', 'novi-beograd-lux');
registerAlias('Palilula', 'palilula-centar');

export function resolveZone(input: string | null | undefined): RichZone | null {
  const key = normalizeSr(input);
  if (!key) return null;
  const direct = ZONE_ALIASES[key];
  if (direct) return RICH_ZONES[direct];
  // Fuzzy: da li se neki alias pojavljuje unutar stringa ("Beograd, Vračar, Njegoševa 12")
  for (const [alias, id] of Object.entries(ZONE_ALIASES)) {
    if (alias.length >= 5 && key.includes(alias)) return RICH_ZONES[id];
  }
  return null;
}

export interface GeoMatch {
  zone: RichZone | null;
  /** Kako smo zaključili — za `reasoning` polje i debug. */
  evidence: string[];
  /** 0-1 pouzdanost geo-poklapanja. */
  confidence: number;
  isHighIncome: boolean;
  tier: PurchasingPowerTier;
}

/**
 * Sr(ce) geo-filtera: iz slobodnog teksta (adresa + opis + naziv) zaključuje
 * u kojoj smo zoni i koliko smo sigurni.
 *
 * Prioritet dokaza:
 *   1. Eksplicitno ime kvarta/opštine  (confidence 0.95)
 *   2. Poklapanje ulice-signala        (confidence 0.85)
 *   3. Poštanski broj                  (confidence 0.5, sam po sebi slab)
 */
export function classifyLocation(rawText: string | null | undefined, hintZone?: RichZoneId | null): GeoMatch {
  const text = normalizeSr(rawText);
  const evidence: string[] = [];

  if (!text) {
    const hinted = hintZone ? RICH_ZONES[hintZone] : null;
    return {
      zone: hinted,
      evidence: hinted ? [`bez adrese — nasleđeno iz cilja pretrage (${hinted.label})`] : [],
      confidence: hinted ? 0.35 : 0,
      isHighIncome: hinted ? hinted.tier === 'HIGH' : false,
      tier: hinted?.tier ?? 'STANDARD',
    };
  }

  let best: { zone: RichZone; confidence: number } | null = null;

  for (const zone of Object.values(RICH_ZONES)) {
    let confidence = 0;

    const nameHits = [zone.label, ...zone.quarters].filter((n) => text.includes(normalizeSr(n)));
    if (nameHits.length > 0) {
      confidence = Math.max(confidence, 0.95);
      evidence.push(`kvart/opština: ${nameHits.join(', ')}`);
    }

    const streetHits = zone.streetSignals.filter((s) => text.includes(normalizeSr(s)));
    if (streetHits.length > 0) {
      confidence = Math.max(confidence, 0.85);
      evidence.push(`ulica-signal: ${streetHits.join(', ')}`);
    }

    const postalHits = zone.postalCodes.filter((p) => text.includes(p));
    if (postalHits.length > 0) {
      confidence = Math.max(confidence, Math.max(0.5, confidence));
      evidence.push(`poštanski broj: ${postalHits.join(', ')}`);
    }

    if (confidence > 0 && (!best || confidence > best.confidence || (confidence === best.confidence && zone.weight > best.zone.weight))) {
      best = { zone, confidence };
    }
  }

  if (!best) {
    const hinted = hintZone ? RICH_ZONES[hintZone] : null;
    return {
      zone: hinted,
      evidence: hinted ? [`adresa van poznatih signala — nasleđeno iz cilja pretrage (${hinted.label})`] : ['nije prepoznata nijedna premium zona'],
      confidence: hinted ? 0.3 : 0,
      isHighIncome: false,
      tier: 'STANDARD',
    };
  }

  return {
    zone: best.zone,
    evidence,
    confidence: best.confidence,
    isHighIncome: best.zone.tier === 'HIGH' && best.confidence >= 0.85,
    tier: best.zone.tier,
  };
}

/** Google Maps URL centriran na anker — bez ovoga Maps vrati pola Srbije. */
export function mapsSearchUrl(query: string, anchor: GeoAnchor): string {
  const q = encodeURIComponent(query);
  return `https://www.google.com/maps/search/${q}/@${anchor.lat},${anchor.lng},${anchor.zoom}z?hl=sr`;
}

/** Sve ankere jedne zone (za rotaciju kroz kvartove). */
export function anchorsFor(zoneId: RichZoneId): readonly GeoAnchor[] {
  return RICH_ZONES[zoneId].anchors;
}
