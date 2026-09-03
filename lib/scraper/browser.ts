/**
 * ANTI-BLOCKING SLOJ — Playwright kontekst koji ne izgleda kao bot.
 *
 * Ne koristimo plaćene proxije (budžet = 0€), pa se sve svodi na tri stvari:
 *   1. IZGLEDATI kao pravi beogradski korisnik (sr-RS, Europe/Belgrade, realan UA,
 *      pravi headeri, bez `navigator.webdriver`).
 *   2. PONAŠATI SE kao čovek (nasumične pauze, postepen scroll, pomeranje miša).
 *   3. NE BITI POHLEPAN (mali batch-evi, duge pauze između tura, keširanje
 *      pristanka na kolačiće da ne ponavljamo isti "prvi dolazak" 100 puta).
 *
 * Treća stavka je jedina koja stvarno drži IP živim. Skreper koji povuče 40
 * stranica u 30 sekundi biva blokiran bez obzira na to koliko je "stealth".
 */

import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { createLogger } from '../utils/logger';
import { humanDelay, randomBetween, sleep } from '../utils/rateLimiter';
import path from 'node:path';
import fs from 'node:fs/promises';

const log = createLogger('scraper:browser');

/** Realni UA-ovi. Rotiramo, ali držimo se Chrome/Windows i Chrome/macOS — najčešća kombinacija u Srbiji. */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

/** Beograd — centar. Koristi se za geolocation permission (Maps voli da zna gde si). */
const BELGRADE_GEO = { latitude: 44.8125, longitude: 20.4612, accuracy: 60 };

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
const BLOCKED_DOMAINS = [
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'facebook.net',
  'facebook.com/tr',
  'hotjar.com',
  'clarity.ms',
  'criteo.com',
  'adservice.google',
];

export interface BrowserSessionOptions {
  /** false = vidiš prozor (za debug lokalno). Na serveru uvek true. */
  headless?: boolean;
  /** Blokiranje slika/fontova — 3-5x brže učitavanje i mnogo manje saobraćaja. */
  blockAssets?: boolean;
  /** Folder za čuvanje kolačića/pristanka između pokretanja. */
  storageDir?: string;
  /** Ime profila (npr. "maps") — različiti izvori, različiti kolačići. */
  profile?: string;
  /** HTTP proxy — OPCIONO. Podrazumevano prazno: sistem radi bez ijednog proxy troška. */
  proxy?: { server: string; username?: string; password?: string };
  /** Timeout za navigaciju. */
  navigationTimeoutMs?: number;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Snima kolačiće da sledeći put preskočimo consent ekran. */
  saveState: () => Promise<void>;
  close: () => Promise<void>;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Pravi "očovečen" browser kontekst.
 * Sve ovo je besplatno — jedini trošak je par sekundi po pokretanju.
 */
export async function createSession(opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
  // Dinamički import: Playwright se NIKAD ne učitava u Next/serverless bundle.
  const { chromium } = await import('playwright');

  const headless = opts.headless ?? process.env.SCRAPER_HEADLESS !== 'false';
  const storageDir = opts.storageDir ?? process.env.SCRAPER_STORAGE_DIR ?? path.join(process.cwd(), '.scraper-state');
  const profile = opts.profile ?? 'default';
  const statePath = path.join(storageDir, `${profile}.json`);

  const browser = await chromium.launch({
    headless,
    args: [
      // Ključni flag: bez njega Chromium sam objavljuje da je automatizovan.
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Bez ovoga puca u Docker-u (Railway/Render) zbog malog /dev/shm.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
      '--lang=sr-RS',
      '--window-size=1440,900',
    ],
    proxy: opts.proxy,
  });

  const storageState = await loadState(statePath);
  const userAgent = pick(USER_AGENTS);
  const viewport = pick(VIEWPORTS);

  const context = await browser.newContext({
    userAgent,
    viewport,
    deviceScaleFactor: pick([1, 1, 2]),
    locale: 'sr-RS',
    timezoneId: 'Europe/Belgrade',
    geolocation: BELGRADE_GEO,
    permissions: ['geolocation'],
    colorScheme: pick(['light', 'light', 'dark']),
    ...(storageState ? { storageState } : {}),
    extraHTTPHeaders: {
      'Accept-Language': 'sr-RS,sr;q=0.9,bs;q=0.8,hr;q=0.7,en-US;q=0.6,en;q=0.5',
      'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': userAgent.includes('Macintosh') ? '"macOS"' : userAgent.includes('Linux') ? '"Linux"' : '"Windows"',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  context.setDefaultNavigationTimeout(opts.navigationTimeoutMs ?? 45_000);
  context.setDefaultTimeout(20_000);

  // --- Maskiranje automatizacije (izvršava se pre svakog skripta stranice) ---
  await context.addInitScript(() => {
    // 1) navigator.webdriver === true je prva stvar koju svaki anti-bot proverava
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 2) Headless Chromium prijavljuje 0 plugin-ova — pravi Chrome ih ima
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
      ],
    });

    Object.defineProperty(navigator, 'languages', { get: () => ['sr-RS', 'sr', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // 3) window.chrome postoji u pravom Chrome-u, ne postoji u headless-u
    const w = window as unknown as Record<string, unknown>;
    if (!w.chrome) w.chrome = { runtime: {}, app: { isInstalled: false } };

    // 4) Notification permission u headless-u vraća "denied" umesto "default"
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params: PermissionDescriptor) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(params);

    // 5) WebGL vendor/renderer — headless odaje "SwiftShader"
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  });

  // --- Blokiranje slika/fontova/trackera: brže, tiše, manje saobraćaja ---
  if (opts.blockAssets ?? true) {
    await context.route('**/*', (route: Route) => {
      const request = route.request();
      const url = request.url();
      if (BLOCKED_DOMAINS.some((d) => url.includes(d))) return route.abort();
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) return route.abort();
      return route.continue();
    });
  }

  const page = await context.newPage();

  log.info('sesija otvorena', { profile, headless, ua: userAgent.slice(0, 60), viewport: `${viewport.width}x${viewport.height}` });

  return {
    browser,
    context,
    page,
    saveState: async () => {
      await fs.mkdir(storageDir, { recursive: true });
      await context.storageState({ path: statePath });
    },
    close: async () => {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      await browser.close();
    },
  };
}

async function loadState(statePath: string): Promise<string | undefined> {
  try {
    await fs.access(statePath);
    return statePath;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  LJUDSKO PONAŠANJE                                                   */
/* ------------------------------------------------------------------ */

/** Postepen scroll kontejnera sa nasumičnim koracima i pauzama. */
export async function humanScroll(page: Page, selector: string, steps = 8): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(
      ({ sel, delta }) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop += delta;
        else window.scrollBy(0, delta);
      },
      { sel: selector, delta: randomBetween(320, 900) },
    );
    await sleep(randomBetween(450, 1400));
  }
}

/** Nasumično pomeranje miša — jeftin signal "ovde je čovek". */
export async function humanMouse(page: Page): Promise<void> {
  const box = page.viewportSize() ?? { width: 1366, height: 768 };
  const points = randomBetween(2, 4);
  for (let i = 0; i < points; i++) {
    await page.mouse.move(randomBetween(50, box.width - 50), randomBetween(80, box.height - 80), { steps: randomBetween(5, 18) });
    await sleep(randomBetween(120, 420));
  }
}

/**
 * Klik na Google/EU consent dijalog. Bez ovoga Maps nikad ne prikaže rezultate,
 * a stanje se posle keširа u storageState pa se ovo dešava samo prvi put.
 */
export async function acceptConsent(page: Page): Promise<boolean> {
  const labels = [
    'Prihvati sve',
    'Prihvatam sve',
    'Accept all',
    'Slažem se',
    'Prihvati',
    'Alle akzeptieren',
    'Prihvati sve kolačiće',
  ];
  for (const label of labels) {
    try {
      const button = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await button.isVisible({ timeout: 1500 })) {
        await humanDelay(400, 1100);
        await button.click({ timeout: 3000 });
        await humanDelay(800, 1800);
        log.info('prihvaćen consent dijalog', { label });
        return true;
      }
    } catch {
      /* nema dijaloga — nastavi */
    }
  }
  return false;
}

/** Da li nas je izvor blokirao (captcha / "unusual traffic" / 429). */
export async function looksBlocked(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('/sorry/') || url.includes('captcha')) return true;
  try {
    const text = (await page.textContent('body'))?.toLowerCase() ?? '';
    return (
      text.includes('unusual traffic') ||
      text.includes('neuobičajen saobraćaj') ||
      text.includes('potvrdite da niste robot') ||
      text.includes('verify you are human') ||
      text.includes('access denied')
    );
  } catch {
    return false;
  }
}

/**
 * Provera robots.txt. Podrazumevano POŠTUJEMO pravila izvora.
 * Ovo nije samo pravna higijena — sajtovi koji te uhvate da ignorišeš robots.txt
 * blokiraju ceo opseg IP adresa, a ti nemaš proxy budžet da to rešiš.
 */
const robotsCache = new Map<string, string>();

export async function isAllowedByRobots(targetUrl: string, userAgent = '*'): Promise<boolean> {
  if (process.env.SCRAPER_IGNORE_ROBOTS === 'true') return true;

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  const robotsUrl = `${parsed.origin}/robots.txt`;
  let body = robotsCache.get(robotsUrl);

  if (body === undefined) {
    try {
      const res = await fetch(robotsUrl, { headers: { 'User-Agent': USER_AGENTS[0]! } });
      body = res.ok ? await res.text() : '';
    } catch {
      body = '';
    }
    robotsCache.set(robotsUrl, body);
  }

  if (!body) return true; // nema robots.txt = nema zabrane

  const lines = body.split('\n').map((l) => l.trim());
  let applies = false;
  const disallowed: string[] = [];

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey) continue;
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase() === userAgent.toLowerCase();
    } else if (applies && key === 'disallow' && value) {
      disallowed.push(value);
    }
  }

  const pathname = parsed.pathname + parsed.search;
  return !disallowed.some((rule) => rule !== '/' ? pathname.startsWith(rule) : pathname.startsWith('/'));
}
