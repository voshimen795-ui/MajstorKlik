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

/** Flagovi koji važe u SVAKOM okruženju. */
const COMMON_ARGS = [
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
];

/** Da li radimo u serverless okruženju (Vercel funkcija). */
export function isServerless(): boolean {
  if (process.env.SERVERLESS_CHROMIUM === 'true') return true;
  if (process.env.SERVERLESS_CHROMIUM === 'false') return false;
  return process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

/**
 * Pokretanje browsera — dva potpuno različita puta:
 *
 *  1. WORKER / LOKALNO: pun `playwright` paket sa svojim Chromium-om.
 *  2. VERCEL FUNKCIJA:  `playwright-core` + `@sparticuz/chromium` — Chromium
 *     spakovan za Lambdu, raspakuje se u /tmp pri prvom pozivu (~2-4s hladan start).
 *     Bez ovoga na Vercel-u ne postoji browser uopšte.
 *
 * Serverless put zahteva Vercel Pro (funkcija do 300s i do 3008 MB memorije);
 * na Hobby planu 60s ne stigne ni da raspakuje Chromium i uradi pretragu.
 */
async function launchBrowser(opts: { headless: boolean; proxy?: BrowserSessionOptions['proxy'] }): Promise<Browser> {
  if (isServerless()) {
    log.info('pokrećem serverless Chromium (@sparticuz/chromium)');
    const [{ chromium: playwrightCore }, chromiumModule] = await Promise.all([
      import('playwright-core'),
      import('@sparticuz/chromium'),
    ]);
    // Paket se objavljuje i kao CJS i kao ESM — `default` postoji samo u jednom slučaju.
    const raw = chromiumModule as unknown as { default?: ServerlessChromium } & ServerlessChromium;
    const pack: ServerlessChromium = raw.default ?? raw;

    const executablePath = await pack.executablePath();
    return playwrightCore.launch({
      headless: true,
      executablePath,
      args: Array.from(new Set([...(pack.args ?? []), ...COMMON_ARGS])),
      ...(opts.proxy ? { proxy: opts.proxy } : {}),
    });
  }

  const { chromium } = await import('playwright');
  return chromium.launch({
    headless: opts.headless,
    args: [...COMMON_ARGS, '--window-size=1440,900'],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  });
}

interface ServerlessChromium {
  args: string[];
  executablePath: (input?: string) => Promise<string>;
}

/**
 * STEALTH SKRIPTA — namerno kao STRING, a ne kao funkcija.
 *
 * Ovo je plaćeno debagovanjem i vredi zapamtiti: `addInitScript(fn)` šalje
 * `fn.toString()` u browser. Kada kod prolazi kroz esbuild/tsx (a worker se
 * pokreće baš tako: `npx tsx scripts/worker.ts`), transpajler ubaci svoj
 * helper `__name(...)` u telo funkcije. Taj helper u browseru NE POSTOJI, pa
 * skripta pukne sa `ReferenceError: __name is not defined` — i to tiho, jer
 * greška ide u konzolu stranice koju niko ne gleda.
 *
 * Posledica je bila da maska nije radila UOPŠTE: `navigator.webdriver`,
 * plugin-ovi, jezici, WebGL — sve ostane na podrazumevanim, prepoznatljivo
 * headless vrednostima. Kao string nema transpilacije, pa nema ni helpera.
 *
 * Drugo pravilo: svaka izmena ide u svoj try/catch. Neka svojstva u pojedinim
 * Chromium build-ovima nisu konfigurabilna i `defineProperty` baci TypeError —
 * bez izolacije, jedan izuzetak obori sve izmene posle sebe.
 */
const STEALTH_SCRIPT = `
(function () {
  function define(target, prop, getter) {
    try {
      Object.defineProperty(target, prop, { get: getter, configurable: true });
    } catch (e1) {
      try {
        Object.defineProperty(Object.getPrototypeOf(target), prop, { get: getter, configurable: true });
      } catch (e2) { /* svojstvo je zaključano — idemo dalje */ }
    }
  }
  function attempt(fn) { try { fn(); } catch (e) { /* jedna izmena ne obara ostale */ } }

  // 1) navigator.webdriver === true je prva provera svakog anti-bot sistema
  define(navigator, 'webdriver', function () { return undefined; });

  // 2) Headless prijavljuje 0 plugin-ova; pravi Chrome ih ima
  define(navigator, 'plugins', function () {
    return [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' }
    ];
  });
  define(navigator, 'mimeTypes', function () {
    return [{ type: 'application/pdf' }, { type: 'text/pdf' }];
  });

  define(navigator, 'languages', function () { return ['sr-RS', 'sr', 'en-US', 'en']; });
  define(navigator, 'hardwareConcurrency', function () { return 8; });
  define(navigator, 'deviceMemory', function () { return 8; });

  // 3) window.chrome postoji u pravom Chrome-u, u headless-u ne
  attempt(function () {
    if (!window.chrome) {
      window.chrome = { runtime: {}, app: { isInstalled: false }, csi: function () {}, loadTimes: function () {} };
    }
  });

  // 4) Notification permission u headless-u vraća "denied" umesto "default"
  attempt(function () {
    var permissions = window.navigator.permissions;
    if (!permissions || !permissions.query) return;
    var originalQuery = permissions.query.bind(permissions);
    permissions.query = function (params) {
      return params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params);
    };
  });

  // 5) WebGL vendor/renderer — headless odaje "SwiftShader"/"Google Inc."
  attempt(function () {
    if (typeof WebGLRenderingContext === 'undefined') return;
    var patch = function (proto) {
      var original = proto.getParameter;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return original.call(this, parameter);
      };
    };
    patch(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
  });
})();
`;

/**
 * Pravi "očovečen" browser kontekst.
 * Sve ovo je besplatno — jedini trošak je par sekundi po pokretanju.
 */
export async function createSession(opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
  const headless = opts.headless ?? process.env.SCRAPER_HEADLESS !== 'false';
  // Na Vercel-u je ceo fajl-sistem read-only osim /tmp.
  const defaultStorageDir = isServerless() ? '/tmp/scraper-state' : path.join(process.cwd(), '.scraper-state');
  const storageDir = opts.storageDir ?? process.env.SCRAPER_STORAGE_DIR ?? defaultStorageDir;
  const profile = opts.profile ?? 'default';
  const statePath = path.join(storageDir, `${profile}.json`);

  const browser = await launchBrowser({ headless, proxy: opts.proxy });

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
  await context.addInitScript({ content: STEALTH_SCRIPT });

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
