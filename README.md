# MajstorKlik — Lead Generation Machine

Mašina koja svakog dana pronalazi, kvalifikuje i rangira **poslovne prilike za gipsare,
vodoinstalatere i molere u najbogatijim delovima Beograda** — i za svaku napiše poruku
spremnu za slanje na WhatsApp u jednom kliku.

**Trošak pokretanja: 0 €.** Bez plaćenih API-ja, bez proxy servisa.

---

## Sadržaj

1. [Kako radi (arhitektura)](#1-kako-radi-arhitektura)
2. [Brzi start — 15 minuta](#2-brzi-start--15-minuta)
3. [Multi-AI routing](#3-multi-ai-routing)
4. [Geografsko ciljanje i skor](#4-geografsko-ciljanje-i-skor)
5. [Komande](#5-komande)
6. [Struktura koda](#6-struktura-koda)
7. [Deployment](#7-deployment)
8. [Anti-blocking strategija](#8-anti-blocking-strategija)
9. [Pravni okvir — pročitaj pre puštanja u rad](#9-pravni-okvir--pročitaj-pre-puštanja-u-rad)
10. [Kad nešto pukne](#10-kad-nešto-pukne)

---

## 1. Kako radi (arhitektura)

```
        ┌──────────────────────────────────────────────────────────────┐
        │  IZVORI (svi javni, svi besplatni)                           │
        │                                                              │
        │  Google Maps          Registri i direktorijumi    Oglasi     │
        │  kafići, ordinacije   profesionalni upravnici     lux stanovi│
        │  saloni, teretane     stambene zajednice          (opt-in)   │
        └───────────────────────────┬──────────────────────────────────┘
                                    │  Playwright + anti-blocking sloj
                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  NORMALIZACIJA                                               │
        │  • phoneUtils: 011/2435-678 → +381112435678 → wa.me/381…     │
        │  • text: ćirilica/latinica/dijakritika → jedan oblik          │
        │  • zones: adresa → zona → kupovna moć                        │
        └───────────────────────────┬──────────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  SKOR PO PRAVILIMA (deterministički, 0-100)                  │
        │  40 lokacija · 22 tip objekta · 15 hitnost                   │
        │  12 kontakt  ·  8 imućnost   ·  3 ozbiljnost                 │
        └───────────────────────────┬──────────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  MULTI-AI SLOJ (fallback lanac, nikad ne staje)              │
        │                                                              │
        │  ekstrakcija →  Groq      →  OpenRouter  →  Gemini           │
        │  scoring     →  Gemini    →  Groq        →  OpenRouter       │
        │  bulk        →  OpenRouter→  Groq        →  Gemini           │
        │                                                              │
        │  Ako svi padnu → deterministički fallback (mašina radi dalje)│
        └───────────────────────────┬──────────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  DEDUPE + SUPABASE                                           │
        │  3 nivoa zaštite od duplog kontakta:                         │
        │  unutar ture · bulk upit nad bazom · UNIQUE indeks           │
        └───────────────────────────┬──────────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  DASHBOARD (Next.js App Router)                              │
        │  sortirano po skoru · WhatsApp dugme sa upisanom porukom     │
        └──────────────────────────────────────────────────────────────┘
```

**Podela odgovornosti pri deployu** — ovo je jedina stvar koju ljudi tu obično promaše:

| Gde | Šta radi | Zašto tu |
|---|---|---|
| **Vercel Pro** | sajt, dashboard, API, cron **i skreper** | 300s po funkciji + Chromium preko `@sparticuz/chromium` |
| **Railway / Render** *(opciono)* | worker za duge ture | bez vremenskog limita, drugačiji IP opseg |
| **Supabase** | baza leadova | besplatnih 500 MB ≈ pola miliona leadova |

> Na Hobby planu Vercel ne može da skrejpuje (60s i bez Chromium-a) — tamo je
> worker obavezan. Sa Pro planom je opcion.

---

## 2. Brzi start — 15 minuta

```bash
# 1. zavisnosti + Chromium
npm install
npm run playwright:install

# 2. podešavanja
cp .env.example .env.local          # popuni ključeve (vidi ispod)

# 3. provera da AI radi
npm run harvest -- --ping

# 4. prva tura, bez upisa u bazu
npm run harvest -- --craft gipsar --zone Vracar --dry

# 5. dashboard
npm run dev                          # http://localhost:3000
```

**Ključevi koje treba uzeti (svi besplatni, bez kartice):**

| Servis | Link | Šta dobijaš |
|---|---|---|
| Groq | https://console.groq.com/keys | ~30 req/min, Llama 3.3 70B |
| Google AI Studio | https://aistudio.google.com/apikey | 15 req/min, 1500/dan, Gemini Flash |
| OpenRouter | https://openrouter.ai/keys | besplatni modeli (DeepSeek R1, Qwen…) |
| Supabase | https://supabase.com | Postgres 500 MB |

Za bazu: napravi projekat → **SQL Editor** → nalepi ceo `supabase/schema.sql` → Run.

Mašina radi i **bez** Supabase-a — leadovi tada idu u `./export/*.json`.

---

## 3. Multi-AI routing

Poenta nije "koristimo AI", nego **da pipeline nikad ne stane zbog rate-limita**.

```ts
// lib/ai/router.ts
extraction  ->  groq       ->  openrouter  ->  gemini
reasoning   ->  gemini     ->  groq        ->  openrouter
bulk        ->  openrouter ->  groq        ->  gemini
```

Zašto baš tako:

- **Groq je prvi za ekstrakciju** jer vraća 70B model za ~1s. Na 300 kartica sa Maps-a,
  razlika 1s vs 8s po kartici je razlika između 5 i 40 minuta po turi.
- **Gemini je prvi za scoring** jer je osetno bolji u mekom zaključivanju i piše srpski
  koji ne zvuči kao robot — a `cold_pitch_message` je polje od kog zavisi konverzija.
- **OpenRouter je mreža za pad**, i sam ima internu rotaciju besplatnih modela: ako
  `deepseek-r1:free` vrati 429, prelazi na `qwen`, pa na `llama` — sve pre nego što
  router uopšte pređe na sledećeg provajdera.

Svaki provajder ima **token bucket na 80% deklarisanog limita**, dnevnu kvotu i
cooldown posle 429. Kad svi padnu, `qualifyLead` koristi deterministički skor i
šablonsku poruku — dobiješ slabiji lead, ali ga dobiješ.

Stanje u svakom trenutku: `GET /api/health` ili `npm run harvest -- --ping`.

---

## 4. Geografsko ciljanje i skor

### Zone

Definisane u `lib/config/zones.ts`, svaka sa težinom kupovne moći:

| Zona | Opština | Tier | Težina |
|---|---|---|---|
| Dedinje | Savski venac | HIGH | 1.00 |
| Senjak | Savski venac | HIGH | 0.98 |
| Stari Grad | Stari Grad | HIGH | 0.97 |
| Vračar | Vračar | HIGH | 0.96 |
| Savski venac | Savski venac | HIGH | 0.95 |
| Dorćol | Stari Grad | HIGH | 0.94 |
| Novi Beograd (lux blokovi) | Novi Beograd | HIGH | 0.88 |
| Palilula (Centar) | Palilula | MEDIUM | 0.80 |
| Zvezdara | Zvezdara | MEDIUM | 0.78 |

Zona se prepoznaje iz slobodnog teksta na tri načina, po pouzdanosti:

1. **ime kvarta/opštine** (0.95) — "Neimar", "Belville", "Silikonska dolina"
2. **ulica-signal** (0.85) — Njegoševa, Strahinjića Bana, Užička, Vasilija Gaćeše…
   Ovo hvata leadove kod kojih opština uopšte nije navedena.
3. **poštanski broj** (0.5) — sam po sebi slab signal

Sve poređenje ide preko `normalizeSr()`, pa "Његошева", "Njegoševa" i "NJEGOSEVA"
daju isti rezultat.

### Skor (0-100)

```
40  lokacija        zona.težina × pouzdanost geo-poklapanja
22  tip objekta     stambena zajednica 22 · stomatologija 20 · kafić 18 · butik 12
15  hitnost         "pukla cev", "privremeno zatvoreno", "otvaramo uskoro"
12  kontakt         mobilni 12 (WhatsApp) · fiksni 011 7 · ostalo 4
 8  imućnost        lux, penthouse, fine dining, salonac…
 3  ozbiljnost      broj recenzija (postoji li objekat stvarno)
```

Finalni skor = **60% pravila + 40% AI**. Razlog: AI je odličan u nijansama ali
nestabilan — isti lead danas dobije 82, sutra 61. Ovako rangiranje ostaje uporedivo
kroz vreme. Pravila takođe imaju **pravo veta**: AI ne sme da podigne STANDARD zonu u HIGH.

### Koga tražimo (i koga ne)

Ključna inverzija: **ne tražimo majstore, tražimo objekte kojima majstor treba.**
Ako se u nazivu ili kategoriji pojavi "vodoinstalater", "gipsar", "moler" — to je
konkurencija i ide u otpad automatski (`isCompetitor`).

Najvredniji lead u sistemu je **profesionalni upravnik zgrade**: jedan upravnik drži
20-80 zgrada, pa jedan uspešan kontakt znači ponavljajuće poslove godinama. Zato ima
najveći bonus (22) i sopstveni izvor (`registarSZ.ts`).

---

## 5. Komande

```bash
npm run dev                                          # dashboard, localhost:3000
npm run build && npm start                           # produkcijski build

npm run harvest -- --craft gipsar --zone Vracar      # jedna tura
npm run harvest -- --craft moler --zone Dedinje --dry        # bez upisa u bazu
npm run harvest -- --craft moler --zone Senjak --headful     # gledaš browser uživo
npm run harvest -- --craft vodoinstalater --zone Dorcol --rules-only  # bez AI-ja
npm run harvest -- --plan                            # sve zone × zanat (satima)
npm run harvest -- --ping                            # samo provera AI provajdera

npm run harvest:loop                                 # kontinualni worker
npm run phone:test                                   # test parsera telefona
npm run stealth:test                                 # da li maska STVARNO radi u browseru
SERVERLESS_CHROMIUM=true npm run stealth:test        # isto, ali Lambda Chromium (Vercel put)
npm run typecheck
```

Dozvoljene zone (prihvata i skraćenice bez dijakritike):
`Vracar` `Stari Grad` `Dorcol` `Savski Venac` `Senjak` `Dedinje` `Zvezdara` `Palilula` `Novi Beograd`

### API

```bash
# lista leadova
curl "http://localhost:3000/api/leads?craft=gipsar&tier=HIGH&minScore=70" \
  -H "Authorization: Bearer $API_TOKEN"

# ručni unos (prolazi kroz punu AI kvalifikaciju)
curl -X POST http://localhost:3000/api/leads \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"leads":[{"name":"Salon Bella","rawAddress":"Krunska 22","rawPhone":"064 111 2233","craft":"moler","targetZone":"vracar"}]}'

# stanje mašine
curl http://localhost:3000/api/health
```

---

## 6. Struktura koda

```
lib/
  config/
    zones.ts          ← GEO JEZGRO: zone, ulice-signali, težine, Maps ankeri
    categories.ts     ← koga tražimo: tipovi objekata, signali potrebe, konkurencija
  utils/
    phoneUtils.ts     ← 011/2435-678 → +381112435678 → wa.me link
    text.ts           ← ćirilica/latinica/dijakritika → jedan oblik
    rateLimiter.ts    ← token bucket, backoff, ljudske pauze
    logger.ts
  ai/
    router.ts         ← multi-provider routing + fallback + JSON parser
    aiEngine.ts       ← kvalifikacija, scoring, provera poruke
    prompts.ts        ← promptovi (ovde se dobija ili gubi kvalitet)
    providers/        ← groq.ts · gemini.ts · openrouter.ts · base.ts
  scoring/
    leadScore.ts      ← deterministički skor + fallback poruka
  scraper/
    browser.ts        ← ANTI-BLOCKING: stealth kontekst, robots.txt, ljudsko ponašanje
    scraper.ts        ← glavni ulaz: scrape({ category, rich_zone })
    sources/          ← googleMaps.ts · registarSZ.ts · oglasi.ts
  db/
    supabase.ts       ← service/anon klijenti
    leads.ts          ← DUPES CHECK + upis + statistika
  pipeline/
    runPipeline.ts    ← skreper → AI → dedupe → baza → log ture
app/                  ← Next.js App Router (dashboard + API rute)
scripts/              ← harvest.ts (CLI) · worker.ts (loop) · testPhones.ts
supabase/schema.sql   ← tabele, indeksi, RLS, pogledi
```

---

## 7. Deployment

### A) Vercel — sajt, dashboard, API (besplatno)

```bash
npm i -g vercel
vercel                                # prvi deploy
vercel env add GROQ_API_KEY           # …i ostale iz .env.example
vercel --prod
```

`vercel.json` ima cron jednom dnevno u 9h. Cron **ne skrejpuje sam** — prosleđuje
posao workeru na `WORKER_URL`, jer Vercel nema Chromium.

> Obavezno postavi `API_TOKEN` i `CRON_SECRET` (`openssl rand -hex 32`).
> Bez njih ti bilo ko može isprazniti AI kvotu ili pročitati bazu leadova.

#### Vercel Pro: cela mašina na jednom mestu

Repo je podešen za **Pro plan**, što menja tri stvari:

| | Hobby | Pro (podešeno ovde) |
|---|---|---|
| cron | 1× dnevno | **5× dnevno** (`0 8,11,14,17,20 * * *`) |
| trajanje funkcije | 60s | **300s** |
| memorija | 1024 MB | **3009 MB** |
| skreper u funkciji | nemoguć | **moguć** (`SERVERLESS_CHROMIUM=true`) |

Sa Pro planom ti **više ne treba Railway ni Render** — Chromium radi u samoj
Vercel funkciji preko `@sparticuz/chromium` (Chromium spakovan za Lambdu,
raspakuje se u `/tmp` pri prvom pozivu). Uključuje se jednom promenljivom:

```bash
vercel env add SERVERLESS_CHROMIUM   # vrednost: true
```

Posle deploya proveri da browser stvarno radi — **ne čekaj da cron tiho ne uradi ništa**:

```bash
curl "https://tvoj-sajt.vercel.app/api/health?browser=1" \
  -H "Authorization: Bearer $API_TOKEN"
# -> "browser": { "ok": true, "mode": "serverless", "ms": 3400, ... }
```

**Kako je vreme podeljeno.** Funkcija ima 300s, pa pipeline radi sa budžetom od
280s: 70% skreper, 30% AI kvalifikacija. Kad budžet istekne, posao **staje sam** i
uredno upiše ono što je skupio (`stoppedEarly: true` u izveštaju). Nikad ne biva
ubijen nasred posla — jer tada bi se skrejpovani leadovi izgubili, a AI kvota
bi već bila potrošena. Zato su ture u serverlessu kraće (12 rezultata po upitu,
8 otvaranja) ali ih ima 5 dnevno — zbir je isti kao jedna duga tura.

**Kada ipak zadržati worker (Railway/Render/lokalno):**

- hoćeš duge ture bez ikakvog vremenskog limita (20+ minuta po zoni)
- hoćeš pauze 45-120 min između tura, što je najbolja zaštita od blokade
- kućni ili Railway IP je "čistiji" od Vercel/AWS opsega, koji Google češće gleda popreko

Najbolje od oba: **worker vrti glavninu**, a Vercel cron radi kao rezerva i
kao ručni okidač iz dashboarda. Ako imaš oba, `WORKER_URL` ima prednost samo
kada `SERVERLESS_CHROMIUM` i `RUN_SCRAPER_HERE` nisu uključeni.

### B) Railway — worker koji skrejpuje (besplatan kredit)

```bash
npm i -g @railway/cli
railway login
railway init
railway up                            # koristi Dockerfile.worker
```

Env varijable u Railway dashboardu: AI ključevi, Supabase, `RUN_SCRAPER_HERE=true`,
`TZ=Europe/Belgrade`.

### C) Render — alternativa (`render.yaml` je već tu)

New → Blueprint → izaberi repo. Servis je tipa `worker`, ne `web` — besplatni **web**
servisi se gase posle 15 min neaktivnosti, worker se ne gasi.

### D) Bez oblaka — bilo koji računar koji je upaljen

```bash
npm run harvest:loop
```

Najjeftinija i najotpornija varijanta: kućni IP je "čistiji" od IP opsega data centara,
pa te izvori ređe blokiraju nego Railway ili Render.

---

## 8. Anti-blocking strategija

Bez plaćenih proxija sve se svodi na tri stvari — i **treća je najvažnija**.

**1. Izgledati kao pravi korisnik** (`lib/scraper/browser.ts`)

- `locale: sr-RS`, `timezoneId: Europe/Belgrade`, geolokacija Beograd
- rotacija realnih Chrome UA + odgovarajući `Sec-Ch-Ua` headeri
- `--disable-blink-features=AutomationControlled`
- maskiranje: `navigator.webdriver`, `plugins`, `mimeTypes`, `languages`,
  `hardwareConcurrency`, `deviceMemory`, `window.chrome`, `permissions.query`,
  WebGL vendor/renderer
- keširanje kolačića pristanka (`.scraper-state/`) — pravi korisnik ne prihvata
  kolačiće 100 puta dnevno

> **Zašto je stealth skripta pisana kao string, a ne kao funkcija.**
> `addInitScript(fn)` šalje `fn.toString()` u browser. Kad kod prođe kroz
> esbuild/tsx (a worker se pokreće baš tako), transpajler ubaci svoj helper
> `__name(...)` u telo funkcije. Taj helper u browseru ne postoji → skripta
> pukne sa `ReferenceError`, i to **tiho**, jer greška ide u konzolu stranice.
> Posledica: maska ne radi uopšte, a ti to ne vidiš u logovima. Zato je skripta
> string, svaka izmena ima svoj `try/catch`, i postoji `npm run stealth:test`
> koji za 5 sekundi potvrdi da sve stvarno radi.

**2. Ponašati se kao čovek**

- nasumične pauze 0.9-3.6s između akcija, postepen scroll, pomeranje miša
- 1.4-3.6s između otvaranja kartica, 3-7s između upita, 8-20s između izvora

**3. Ne biti pohlepan — ovo je jedino što stvarno drži IP živim**

| Pravilo | Vrednost | Podešavanje |
|---|---|---|
| radno vreme | 08-22h po Beogradu | `WORKER_ACTIVE_FROM_HOUR/TO_HOUR` |
| pauza između tura | 45-120 min | `WORKER_MIN/MAX_PAUSE_MIN` |
| jedna zona po turi | uvek | rotacija u `buildDailyPlan()` |
| posle 2 problema | hlađenje 1-6h | eksponencijalno u `worker.ts` |
| robots.txt | poštuje se | `SCRAPER_IGNORE_ROBOTS=false` |

Skreper koji povuče 40 stranica za 30 sekundi biva blokiran bez obzira na to koliko je
"stealth". Ovaj namerno radi sporo: **~150-400 kvalifikovanih leadova nedeljno** je
realan i održiv tempo.

**Kad te ipak blokiraju:** `looksBlocked()` prepoznaje captcha/`/sorry/`/"unusual
traffic", pauzira 3-6 minuta i prelazi na sledeći upit. Ako se ponovi dva puta,
worker hladi IP satima. Nikad ne pokušava odmah ponovo — to je najbrži put do
trajne blokade.

**Bez proxija?** Da. Ako ti ipak zatreba, `createSession({ proxy })` ga prima, ali
sistem je projektovan tako da bez njega radi neograničeno.

---

## 9. Pravni okvir — pročitaj pre puštanja u rad

Nije pravni savet, ali su ovo stvari koje te realno mogu koštati:

1. **Uslovi korišćenja izvora.** Google i oglasnici u pravilu zabranjuju automatsko
   preuzimanje sadržaja. Podaci koje mašina uzima jesu javni (naziv firme, adresa,
   poslovni telefon), ali način prikupljanja krši ToS. Sistem zato poštuje `robots.txt`
   podrazumevano i radi sporo.
2. **Podaci o ličnosti (ZZPL / GDPR).** Poslovni kontakt firme je znatno manje
   rizičan od broja fizičkog lica. Zato je mašina **B2B-first**, a izvor `oglasi`
   je podrazumevano isključen i ima `OGLASI_ONLY_AGENCIES=true`.
3. **Neželjena komunikacija.** Za B2B kontakt postoji legitiman interes, ali:
   pošalji **jednu** poruku, predstavi se punim imenom i firmom, i na "ne, hvala"
   stani odmah i obeleži lead kao `rejected`. Dedupe postoji upravo zato da isti
   čovek nikad ne dobije dve poruke.
4. **Šta NE radi ova mašina:** ne zaobilazi captcha, ne pravi lažne naloge, ne
   skuplja email adrese za masovnu poštu, ne uzima podatke iza logina.

Praktično: puštaj `google_maps` + `registar_sz` (poslovni kontakti), a `oglasi`
uključi tek kad si proverio uslove konkretnog sajta i svesno prihvatio rizik.

---

## 10. Kad nešto pukne

| Simptom | Uzrok | Rešenje |
|---|---|---|
| `Svi AI provajderi pali` | nema ključeva ili je kvota gotova | `--ping`, pa `/api/health`; dodaj OpenRouter ključ |
| `0 sirovih leadova` | blokada ili promenjen DOM | pokreni sa `--headful` i gledaj; LLM fallback se pali sam |
| `nema upotrebljiv telefon` masovno | kartice se ne otvaraju | povećaj `--max`, proveri `maxDetails` |
| `van premium zona` masovno | Maps ignoriše anker | proveri koordinate zone u `zones.ts` |
| Sve odbačeno kao nizak skor | prag previsok | spusti `MIN_LEAD_SCORE` na 45 |
| Chromium ne startuje na serveru | fale sistemske biblioteke | koristi `Dockerfile.worker` (Playwright slika) |
| `Hobby accounts are limited to daily cron jobs` | cron češći od 1×/dan na Hobby planu | pređi na Pro, ili `vercel.json` → `0 9 * * *` |
| `maxDuration exceeds the limit for your plan` | 300s traži Pro plan | na Hobby planu spusti na 60 u `vercel.json` i rutama |
| Skreper radi lokalno, na Vercel-u vraća 501 | `SERVERLESS_CHROMIUM` nije uključen | `vercel env add SERVERLESS_CHROMIUM` → `true` |
| `browser.ok: false` u `/api/health?browser=1` | funkcija nema dovoljno memorije | `memory: 3009` u `vercel.json` (već podešeno), pa redeploy |
| Tura vrati manje leadova nego lokalno | `stoppedEarly: true` — istekao budžet | normalno u serverlessu; smanji `maxPerQuery` ili pusti worker |
| Google blokira odmah, a lokalno ne | Vercel/AWS IP opseg je "prljaviji" | prebaci skreper na worker (Railway/Render/kućni računar) |
| `duplicate key phone_e164` | dva workera paralelno | to je zaštita, ne greška — upsert to hvata |
| Poruke zvuče kao robot | AI pao na fallback | proveri `ai_provider` polje leada |

---

## Šta dalje

Redosled po odnosu uloženo/dobijeno:

1. **Praćenje odgovora** — kolona `replied_at` i konverzija po zoni. Kad znaš da Dorćol
   konvertuje 3x bolje od Zvezdare, prebacuješ tempo tamo.
2. **A/B poruke** — dve verzije `cold_pitch_message`, meri se koja dobija odgovor.
3. **Podsetnik za follow-up** — 80% poslova se dobije na drugu poruku, ne prvu.
4. **Sezonski signali** — moleraj skače pre Nove godine i pred useljenja u septembru.
5. **Više gradova** — `zones.ts` je jedini fajl koji treba proširiti za Novi Sad.
