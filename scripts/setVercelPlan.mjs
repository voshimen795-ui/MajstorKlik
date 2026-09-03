#!/usr/bin/env node
/**
 * Prebacuje `vercel.json` između Hobby i Pro podešavanja.
 *
 *   npm run vercel:hobby   # deploy prolazi na SVAKOM planu (1 cron dnevno, 60s)
 *   npm run vercel:pro     # 5 cronova dnevno, 300s, 3009 MB — traži aktivan Pro
 *
 * Zašto ovo postoji: Vercel odbija ceo deploy ako `vercel.json` traži više nego
 * što plan dozvoljava. Pro se plaća PO SCOPE-U (lični nalog ili tim), pa se lako
 * desi da je plan kupljen na jednom nalogu a projekat živi na drugom — i deploy
 * i dalje puca sa "Hobby accounts are limited to daily cron jobs".
 *
 * Zato je podrazumevano stanje Hobby: bolje da uvek prođe deploy, pa da Pro
 * uključiš svesno kad potvrdiš da je aktivan na tom projektu.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = (process.argv[2] ?? '').toLowerCase();

if (plan !== 'pro' && plan !== 'hobby') {
  console.error('Upotreba: node scripts/setVercelPlan.mjs <hobby|pro>');
  process.exit(1);
}

const source = path.join(root, 'deploy', `vercel.${plan}.json`);
const target = path.join(root, 'vercel.json');

const content = readFileSync(source, 'utf8');
writeFileSync(target, content);

const config = JSON.parse(content);
const schedule = config.crons?.[0]?.schedule ?? '(nema crona)';
const duration = config.functions?.['app/api/cron/harvest/route.ts']?.maxDuration ?? '?';
const memory = config.functions?.['app/api/cron/harvest/route.ts']?.memory ?? 'podrazumevano';

console.log(`\nvercel.json podešen za: ${plan.toUpperCase()}`);
console.log(`  cron:       ${schedule}`);
console.log(`  maxDuration:${String(duration).padStart(5)}s`);
console.log(`  memorija:   ${memory}${typeof memory === 'number' ? ' MB' : ''}`);

if (plan === 'pro') {
  console.log(`
Pre deploya proveri da je Pro STVARNO aktivan na scope-u u kom je projekat:
  vercel whoami            # koji nalog je aktivan
  vercel teams ls          # timovi i njihovi planovi
U dashboardu: gore levo prebacivač scope-a pokazuje "Hobby" ili "Pro" pored imena.

Ne zaboravi i vremenski budžet (kod je podrazumevano na 50s, Hobby-safe):
  vercel env add RUN_TIME_BUDGET_MS     ->  280000

Ako deploy padne sa "Hobby accounts are limited to daily cron jobs",
plan nije aktivan na tom projektu — vrati se sa: npm run vercel:hobby\n`);
} else {
  console.log(`
Ovo podešavanje prolazi na svakom planu. Raspored i dalje radi:
  - worker (npm run harvest:loop) vrti ture svakih 45-120 min, nezavisno od Vercela
  - ili spoljni cron (cron-job.org) koji zove /api/cron/harvest koliko god puta hoćeš\n`);
}
