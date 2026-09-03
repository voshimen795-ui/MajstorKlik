/**
 * Dashboard — lista kvalifikovanih leadova.
 *
 * Server komponenta: čita direktno iz Supabase preko service ključa,
 * tako da anon ključ nikad ne dodiruje leadove (vidi RLS u schema.sql).
 */

import { Suspense } from 'react';
import { LeadCard } from '@/components/LeadCard';
import { LeadFilters } from '@/components/LeadFilters';
import { RunPipeline } from '@/components/RunPipeline';
import { leadStats, listLeads } from '@/lib/db/leads';
import { isDbConfigured } from '@/lib/db/supabase';
import { configuredProviders } from '@/lib/ai/router';
import type { Craft } from '@/lib/config/categories';
import type { RichZoneId } from '@/lib/config/zones';
import type { LeadStatus } from '@/lib/types/lead';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const dbReady = isDbConfigured();
  const providers = configuredProviders();

  const query = {
    craft: first(searchParams.craft) as Craft | undefined,
    zoneId: first(searchParams.zone) as RichZoneId | undefined,
    tier: first(searchParams.tier) as 'HIGH' | 'MEDIUM' | 'STANDARD' | undefined,
    status: first(searchParams.status) as LeadStatus | undefined,
    minScore: first(searchParams.minScore) ? Number(first(searchParams.minScore)) : undefined,
    search: first(searchParams.q),
    limit: 60,
  };

  const emptyStats: Awaited<ReturnType<typeof leadStats>> = {
    total: 0,
    byTier: {},
    byCraft: {},
    byZone: {},
    newToday: 0,
    avgScore: 0,
  };
  const emptyList: Awaited<ReturnType<typeof listLeads>> = { leads: [], total: 0 };

  const [{ leads, total }, stats] = dbReady ? await Promise.all([listLeads(query), leadStats()]) : [emptyList, emptyStats];

  return (
    <>
      <header className="topbar">
        <div className="wrap row">
          <div>
            <span className="pill">Lead mašina</span>
            <h1>MajstorKlik — kvalifikovani leadovi</h1>
            <p>Beograd · premium zone · gips, vodoinstalacije, moleraj</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`pill ${dbReady ? 'ok' : 'off'}`}>{dbReady ? 'Baza povezana' : 'Baza nije podešena'}</span>
            <span className={`pill ${providers.length > 0 ? 'ok' : 'off'}`}>
              {providers.length > 0 ? `AI: ${providers.join(' · ')}` : 'AI ključevi nedostaju'}
            </span>
          </div>
        </div>
      </header>

      <main className="wrap">
        <section className="stats">
          <div className="stat">
            <span>Ukupno leadova</span>
            <b>{stats.total}</b>
          </div>
          <div className="stat hot">
            <span>Visoka kupovna moć</span>
            <b>{stats.byTier.HIGH ?? 0}</b>
          </div>
          <div className="stat">
            <span>Novih danas</span>
            <b>{stats.newToday}</b>
          </div>
          <div className="stat">
            <span>Prosečan skor</span>
            <b>{stats.avgScore}</b>
          </div>
          <div className="stat">
            <span>Prikazano</span>
            <b>{leads.length}</b>
          </div>
        </section>

        <RunPipeline />

        <Suspense fallback={<div className="muted">Učitavanje filtera…</div>}>
          <LeadFilters />
        </Suspense>

        {!dbReady && <SetupGuide />}

        {dbReady && leads.length === 0 && (
          <div className="empty">
            <h2>Još nema leadova za ove filtere</h2>
            <p className="muted">Pokreni prvu turu prikupljanja:</p>
            <pre>{`npm run harvest -- --craft gipsar --zone Vracar`}</pre>
          </div>
        )}

        {leads.length > 0 && (
          <>
            <div className="section-title">
              {total} leadova ukupno · sortirano po skoru
            </div>
            <div className="leads">
              {leads.map((lead) => (
                <LeadCard key={lead.id ?? lead.phone_e164} lead={lead} />
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}

/**
 * Ekran za podešavanje — namerno DIJAGNOSTIČKI, ne generički.
 *
 * Prikazuje tačno koja promenljiva fali i gde se dodaje u OVOM okruženju
 * (Vercel dashboard vs lokalni `.env.local`). Nikad ne prikazuje vrednosti,
 * samo da li postoje — ovo je server komponenta i ključevi ne smeju u HTML.
 */
function SetupGuide() {
  const onVercel = process.env.VERCEL === '1';

  const required = [
    { key: 'NEXT_PUBLIC_SUPABASE_URL', ok: !!process.env.NEXT_PUBLIC_SUPABASE_URL, opis: 'Supabase → Settings → API → Project URL' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY, opis: 'isto mesto → service_role (tajni ključ)' },
  ];

  const aiKeys = [
    { key: 'GROQ_API_KEY', ok: !!process.env.GROQ_API_KEY, opis: 'console.groq.com/keys' },
    { key: 'GEMINI_API_KEY', ok: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), opis: 'aistudio.google.com/apikey' },
    { key: 'OPENROUTER_API_KEY', ok: !!process.env.OPENROUTER_API_KEY, opis: 'openrouter.ai/keys' },
  ];

  const security = [
    { key: 'API_TOKEN', ok: !!process.env.API_TOKEN, opis: 'bilo koji dug nasumičan string' },
    { key: 'CRON_SECRET', ok: !!process.env.CRON_SECRET, opis: 'isto, ali drugi string' },
  ];

  const hasAnyAi = aiKeys.some((k) => k.ok);

  return (
    <div className="empty setup">
      <h2>Mašina još nije povezana sa bazom</h2>
      <p className="muted">
        {onVercel
          ? 'Sajt radi, ali nema podataka jer promenljive nisu podešene na Vercelu. Evo šta tačno fali:'
          : 'Popuni .env.local. Evo šta tačno fali:'}
      </p>

      <EnvGroup naslov="Baza (obavezno)" stavke={required} />
      <EnvGroup naslov={`AI ključevi (dovoljan je jedan)${hasAnyAi ? '' : ' — nijedan nije podešen'}`} stavke={aiKeys} />
      <EnvGroup naslov="Zaštita API ruta" stavke={security} />

      {onVercel ? (
        <ol className="setup-steps">
          <li>
            <b>supabase.com</b> → New project (besplatno, traje ~2 min)
          </li>
          <li>
            SQL Editor → nalepi ceo <code>supabase/schema.sql</code> iz repoa → Run
          </li>
          <li>
            Vercel → ovaj projekat → <b>Settings → Environment Variables</b> → dodaj promenljive označene sa ✗
          </li>
          <li>
            <b>Deployments → Redeploy.</b> Ovo je obavezno: promenljive se primenjuju tek na novi deploy, postojeći ih ne
            vidi.
          </li>
        </ol>
      ) : (
        <ol className="setup-steps">
          <li>
            <code>cp .env.example .env.local</code> i popuni vrednosti
          </li>
          <li>
            Supabase → SQL Editor → pusti <code>supabase/schema.sql</code>
          </li>
          <li>
            <code>npm run dev</code> ponovo (Next čita .env.local pri startu)
          </li>
        </ol>
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        Kad baza proradi, leadovi se pojave tek posle prve ture:{' '}
        <code>npm run harvest -- --craft gipsar --zone Vracar</code>
      </p>
    </div>
  );
}

function EnvGroup({ naslov, stavke }: { naslov: string; stavke: { key: string; ok: boolean; opis: string }[] }) {
  return (
    <div className="env-group">
      <div className="env-title">{naslov}</div>
      <ul className="env-list">
        {stavke.map((s) => (
          <li key={s.key} className={s.ok ? 'env-ok' : 'env-missing'}>
            <span className="env-mark">{s.ok ? '✓' : '✗'}</span>
            <code>{s.key}</code>
            <span className="env-hint">{s.opis}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
