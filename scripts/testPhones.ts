#!/usr/bin/env tsx
/**
 * Test parsera telefona na stvarnim formatima iz Beograda.
 *   npm run phone:test
 */

import { parsePhone, extractPhones, pickBestPhone } from '../lib/utils/phoneUtils';

const CASES: [string, string | null][] = [
  ['011/2435-678', '+381112435678'],
  ['011 2435 678', '+381112435678'],
  ['+381 11 2435 678', '+381112435678'],
  ['063 123 456', '+38163123456'],
  ['063/123-456', '+38163123456'],
  ['064 555 4444', '+381645554444'],
  ['+381641112233', '+381641112233'],
  ['00381641112233', '+381641112233'],
  ['381 64 111 2233', '+381641112233'],
  ['+381 (0)64 111 2233', '+381641112233'],
  ['tel. 011 3033-100 lok. 4', '+381113033100'],
  ['0800 123 456', '+381800123456'],
  ['069/1234-567', '+381691234567'],
  ['12345', null],
  ['PIB 100123456', null],
  ['+385 91 123 4567', null],
];

let passed = 0;
let failed = 0;

console.log('\nPARSER TELEFONA — test\n' + '─'.repeat(78));

for (const [input, expected] of CASES) {
  const result = parsePhone(input);
  const actual = result.ok ? result.e164 : null;
  const ok = actual === expected;
  ok ? passed++ : failed++;

  const detail = result.ok
    ? `${result.national.padEnd(16)} ${result.type.padEnd(9)} ${result.operator ?? ''} ${result.whatsappCapable ? '· WhatsApp' : ''}`
    : `odbijeno: ${result.reason}`;

  console.log(`${ok ? '✓' : '✗'} ${input.padEnd(26)} → ${(actual ?? '—').padEnd(16)} ${detail}`);
  if (!ok) console.log(`   očekivano: ${expected ?? '—'}`);
}

console.log('─'.repeat(78));
console.log(`${passed} prošlo, ${failed} palo\n`);

// Ekstrakcija iz slobodnog teksta
const messyText = `
  Stomatološka ordinacija "Beli zub", Njegoševa 45, Vračar.
  Zakazivanje: 011/3444-555 ili mobilni 064 202 3030.
  PIB: 105998877, matični broj 20123456. Radno vreme 09-20h.
`;

console.log('EKSTRAKCIJA IZ TEKSTA\n' + '─'.repeat(78));
for (const phone of extractPhones(messyText)) {
  console.log(`  ${phone.e164.padEnd(16)} ${phone.type.padEnd(9)} pouzdanost ${phone.confidence}  ${phone.whatsappLink || '(bez WhatsApp-a)'}`);
}

const best = pickBestPhone(messyText, { waMessage: 'Dobar dan, zovem u vezi krečenja ordinacije.' });
console.log(`\nNajbolji kontakt: ${best?.e164} (${best?.type})`);
console.log(`WhatsApp link:    ${best?.whatsappLink}\n`);

process.exit(failed > 0 ? 1 : 0);
