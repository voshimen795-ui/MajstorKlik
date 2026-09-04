#!/usr/bin/env tsx
/**
 * Test detekcije namere na stvarnim formulacijama iz srpskih oglasa.
 *
 *   npm run intent:test
 *
 * Ovo je najvažniji test u radaru potražnje: ako klasifikator omane, dobiješ
 * bazu konkurencije umesto baze poslova.
 */

import { classifyIntent, freshnessBonus } from '../lib/scoring/intent';

type Ocekivano = 'SEEKING' | 'OFFERING' | 'UNCLEAR';

const SLUCAJEVI: [string, Ocekivano][] = [
  // --- POTRAŽNJA: ovo su leadovi ---
  ['Hitno tražim molera za dvosoban stan na Vračaru, gletovanje i krečenje.', 'SEEKING'],
  ['Potreban gipsar za spuštanje plafona u lokalu na Dorćolu.', 'SEEKING'],
  ['Da li neko zna majstora za sanaciju vlage u podrumu zgrade?', 'SEEKING'],
  ['Treba mi vodoinstalater, pukla cev u kupatilu, hitno.', 'SEEKING'],
  ['Tražim majstora za renoviranje kupatila, plaćam odmah.', 'SEEKING'],
  ['Javni poziv za podnošenje ponuda — molersko-farbarski radovi u OŠ "Vuk Karadžić"', 'SEEKING'],
  ['Preporuka za majstora koji radi knauf? Treba mi pregradni zid.', 'SEEKING'],
  ['Ko može da uradi gletovanje 60m2 na Senjaku? Koliko bi koštalo?', 'SEEKING'],
  ['Потребан мајстор за кречење станa на Врачару', 'SEEKING'],
  ['Stambena zajednica prikuplja ponude za krečenje hodnika i stepeništa.', 'SEEKING'],

  // --- PONUDA: ovo je konkurencija, mora napolje ---
  ['Molerski radovi, dugogodišnje iskustvo, besplatna procena. Pozovite nas!', 'OFFERING'],
  ['Nudimo usluge gipsara, sve vrste radova, garancija na radove.', 'OFFERING'],
  ['Vršim usluge krečenja i gletovanja, brzo i kvalitetno, najpovoljnije cene.', 'OFFERING'],
  ['Vodoinstalater — izvodim radove, dolazak na adresu, 20 godina iskustva.', 'OFFERING'],
  ['Naša firma radi sve vrste gipsarskih radova. Besplatna procena.', 'OFFERING'],
  ['Gipsar Beograd — spušteni plafoni, pregradni zidovi. Zakažite termin.', 'OFFERING'],
  ['Радимо све врсте молерских радова, повољно и квалитетно.', 'OFFERING'],

  // --- NEJASNO: ne odbacujemo, ali ne trošimo ni prioritet ---
  ['Gipsarski radovi Beograd', 'UNCLEAR'],
  ['Renoviranje stana', 'UNCLEAR'],
];

const SVEZINA: [string, number][] = [
  ['Objavljeno danas u 14:30', 15],
  ['juče', 13],
  ['pre 3 dana', 10],
  ['pre 2 nedelje', 5],
  ['pre 4 meseca', 0],
];

let prosli = 0;
let pali = 0;

console.log('\nDETEKCIJA NAMERE — test\n' + '─'.repeat(96));

for (const [tekst, ocekivano] of SLUCAJEVI) {
  const r = classifyIntent(tekst);
  const ok = r.intent === ocekivano;
  ok ? prosli++ : pali++;

  const oznaka = ok ? '✓' : '✗';
  const prikaz = tekst.length > 62 ? `${tekst.slice(0, 59)}…` : tekst;
  console.log(
    `${oznaka} ${prikaz.padEnd(64)} ${r.intent.padEnd(9)} skor ${String(r.score).padStart(3)}  siguran ${r.confidence.toFixed(2)}`,
  );
  if (!ok) console.log(`   očekivano ${ocekivano} · ${r.explanation}`);
}

console.log('─'.repeat(96));
console.log(`${prosli} prošlo, ${pali} palo\n`);

console.log('SVEŽINA OGLASA\n' + '─'.repeat(96));
let svezinaPala = 0;
for (const [tekst, ocekivano] of SVEZINA) {
  const r = freshnessBonus(tekst);
  const ok = r.bonus === ocekivano;
  if (!ok) svezinaPala++;
  console.log(`${ok ? '✓' : '✗'} ${tekst.padEnd(30)} bonus ${String(r.bonus).padStart(3)} (očekivano ${ocekivano})`);
}
console.log('─'.repeat(96));

process.exit(pali + svezinaPala > 0 ? 1 : 0);
