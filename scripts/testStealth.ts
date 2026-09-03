#!/usr/bin/env tsx
/**
 * Provera anti-blocking sloja: da li maska STVARNO radi u browseru.
 *
 *   npm run stealth:test                      # lokalni Chromium (worker put)
 *   SERVERLESS_CHROMIUM=true npm run stealth:test   # Lambda Chromium (Vercel put)
 *
 * Zašto ovaj test postoji: maska je jednom već tiho otkazala u celosti, jer
 * transpajler ubaci helper `__name` u serijalizovanu init funkciju i skripta
 * pukne u browseru sa `ReferenceError`. Greška ide u konzolu STRANICE — u
 * logovima skrepera se ne vidi ništa, a ti misliš da si nevidljiv dok te
 * Google blokira u tri poteza. Ovaj test to hvata za 5 sekundi.
 */

import 'dotenv/config';
import { createSession, isServerless } from '../lib/scraper/browser';

interface Check {
  naziv: string;
  vrednost: unknown;
  ocekivano: string;
  prolazi: boolean;
}

async function main(): Promise<void> {
  console.log(`\nSTEALTH TEST — režim: ${isServerless() ? 'serverless (@sparticuz/chromium)' : 'lokalni Playwright Chromium'}\n${'─'.repeat(78)}`);

  const session = await createSession({ profile: 'stealth-test' });
  const pageErrors: string[] = [];
  session.page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  try {
    await session.page.goto('data:text/html,<h1>stealth</h1>');

    const probe = await session.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      let webglVendor = 'n/a';
      try {
        const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
        webglVendor = gl ? String(gl.getParameter(37445)) : 'nema konteksta';
      } catch {
        webglVendor = 'greška';
      }
      return {
        webdriver: String((navigator as unknown as { webdriver: unknown }).webdriver),
        plugins: navigator.plugins.length,
        languages: navigator.languages.join(','),
        cores: navigator.hardwareConcurrency,
        deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
        hasChrome: !!w.chrome,
        webglVendor,
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    });

    const checks: Check[] = [
      { naziv: 'navigator.webdriver skriven', vrednost: probe.webdriver, ocekivano: 'undefined', prolazi: probe.webdriver === 'undefined' },
      { naziv: 'plugin-ovi prijavljeni', vrednost: probe.plugins, ocekivano: '>= 3', prolazi: probe.plugins >= 3 },
      { naziv: 'jezici (srpski prvi)', vrednost: probe.languages, ocekivano: 'sr-RS,sr,…', prolazi: probe.languages.startsWith('sr-RS,sr') },
      { naziv: 'broj jezgara', vrednost: probe.cores, ocekivano: '8', prolazi: probe.cores === 8 },
      { naziv: 'deviceMemory', vrednost: probe.deviceMemory, ocekivano: '8', prolazi: probe.deviceMemory === 8 },
      { naziv: 'window.chrome postoji', vrednost: probe.hasChrome, ocekivano: 'true', prolazi: probe.hasChrome === true },
      { naziv: 'WebGL vendor maskiran', vrednost: probe.webglVendor, ocekivano: 'Intel Inc.', prolazi: probe.webglVendor === 'Intel Inc.' },
      { naziv: 'vremenska zona', vrednost: probe.timezone, ocekivano: 'Europe/Belgrade', prolazi: probe.timezone === 'Europe/Belgrade' },
      { naziv: 'UA nije HeadlessChrome', vrednost: probe.userAgent.slice(0, 42), ocekivano: 'bez "Headless"', prolazi: !probe.userAgent.includes('Headless') },
      { naziv: 'nema grešaka u init skripti', vrednost: pageErrors.length, ocekivano: '0', prolazi: pageErrors.length === 0 },
    ];

    for (const check of checks) {
      console.log(
        `${check.prolazi ? '✓' : '✗'} ${check.naziv.padEnd(32)} ${String(check.vrednost).slice(0, 26).padEnd(28)} (očekivano: ${check.ocekivano})`,
      );
    }

    if (pageErrors.length > 0) {
      console.log('\nGREŠKE U STRANICI (ovo obara celu masku):');
      for (const error of pageErrors) console.log(`  ${error}`);
    }

    const failed = checks.filter((c) => !c.prolazi).length;
    console.log('─'.repeat(78));
    console.log(`${checks.length - failed} prošlo, ${failed} palo\n`);

    await session.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    await session.close();
    console.error('Test nije mogao da se izvrši:', error);
    process.exit(1);
  }
}

main();
