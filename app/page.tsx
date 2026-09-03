/**
 * Dashboard — lista kvalifikovanih leadova.
 *
 * Server komponenta: čita direktno iz Supabase preko service ključa,
 * tako da anon ključ nikad ne dodiruje leadove (vidi RLS u schema.sql).
 */

import { Suspense } from 'react';
import { LeadCard } from '@/components/LeadCard';
import { LeadFilters } from '@/components/LeadFilters';
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

function SetupGuide() {
  return (
    <div className="empty">
      <h2>Mašina još nije povezana sa bazom</h2>
      <p className="muted">
        Napravi besplatan Supabase projekat, pusti <code>supabase/schema.sql</code> u SQL editoru i popuni{' '}
        <code>.env.local</code>:
      </p>
      <pre>{`NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# bar jedan AI ključ (svi imaju besplatan tier)
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...
OPENROUTER_API_KEY=sk-or-...`}</pre>
      <p className="muted" style={{ marginTop: 14 }}>
        Bez baze mašina i dalje radi — rezultat ide u <code>./export/*.json</code>.
      </p>
    </div>
  );
}
