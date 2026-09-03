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
| **Vercel** | sajt, dashboard, API, cron okidač | besplatno, brzo, ali **nema Chromium** i seče funkcije na 10-60s |
| **Railway / Render** | worker koji skrejpuje | ima Docker sa Chromium-om, proces može da radi 20 minuta |
| **Supabase** | baza leadova | besplatnih 500 MB ≈ pola miliona leadova |

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

#### Ograničenja besplatnog (Hobby) plana — i kako ih zaobići

Vercel Hobby ima dva ograničenja koja **obaraju deploy** ako ih prekršiš:

| Ograničenje | Šta pada | Kako je rešeno ovde |
|---|---|---|
| cron sme **samo jednom dnevno** | `Hobby accounts are limited to daily cron jobs` | `vercel.json` ima `0 9 * * *` — tačno jednom |
| funkcija traje **najviše 60s** | `maxDuration exceeds the limit for your plan` | sve rute imaju `maxDuration = 60` |
| tajming nije precizan | — | posao je svejedno asinhron, minut-dva ne menja ništa |

**Ovo praktično ne smeta**, jer Vercel cron nije motor mašine nego samo okidač.
Pravi raspored živi u workeru (`scripts/worker.ts`): on sam vrti ture svakih
45-120 minuta ceo dan, i **potpuno je nezavisan od Vercel crona**. Vercel cron je tu
samo kao rezervni okidač.

Ako ipak hoćeš više okidanja dnevno bez plaćanja Pro plana, imaš dve besplatne opcije:

1. **Spoljni cron servis** (npr. cron-job.org, UptimeRobot) koji zove tvoj endpoint
   koliko god puta hoćeš — Hobby limit se odnosi samo na Vercel-ov ugrađeni cron:
   ```
   GET https://tvoj-sajt.vercel.app/api/cron/harvest?token=CRON_SECRET
   ```
2. **Pusti worker da radi svoje** i potpuno izbaci `crons` iz `vercel.json`.
   Ovo je i preporučena varijanta — jedan izvor istine za raspored.

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
- maskiranje: `navigator.webdriver`, `plugins`, `languages`, `window.chrome`,
  `permissions.query`, WebGL vendor/renderer
- keširanje kolačića pristanka (`.scraper-state/`) — pravi korisnik ne prihvata
  kolačiće 100 puta dnevno

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
| `Hobby accounts are limited to daily cron jobs` | cron češći od 1×/dan | `vercel.json` → `0 9 * * *`, ili izbaci `crons` i pusti worker |
| `maxDuration exceeds the limit for your plan` | funkcija duža od 60s | `maxDuration = 60` u rutama (već podešeno) |
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
