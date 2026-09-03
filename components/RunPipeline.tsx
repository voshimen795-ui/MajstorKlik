'use client';

/**
 * Pokretanje ture sa telefona — jedan tap umesto curl-a sa Authorization headerom.
 *
 * Token se traži jednom i čuva u localStorage tog uređaja (nikad ne ide u HTML
 * stranice niti u bazu). Ruta ostaje zaštićena kao i pre.
 */

import { useState } from 'react';
import { RICH_ZONES } from '@/lib/config/zones';

const CRAFTS = [
  { value: 'gipsar', label: 'Gipsar' },
  { value: 'moler', label: 'Moler' },
  { value: 'vodoinstalater', label: 'Vodoinstalater' },
];

const TOKEN_KEY = 'majstorklik_api_token';

export function RunPipeline() {
  const [craft, setCraft] = useState('gipsar');
  const [zone, setZone] = useState('vracar');
  const [busy, setBusy] = useState(false);
  const [poruka, setPoruka] = useState<{ tip: 'ok' | 'greska' | 'info'; tekst: string } | null>(null);

  function readToken(): string | null {
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* privatni režim */
    }
    if (!token) {
      token = window.prompt('Nalepi API_TOKEN (isti onaj iz Vercel promenljivih):');
      if (token) {
        try {
          localStorage.setItem(TOKEN_KEY, token.trim());
        } catch {
          /* ignoriši */
        }
      }
    }
    return token?.trim() || null;
  }

  async function pokreni() {
    const token = readToken();
    if (!token) return;

    setBusy(true);
    setPoruka({ tip: 'info', tekst: 'Tura je pokrenuta — traje 1-5 minuta, ne zatvaraj stranicu…' });

    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ category: craft, rich_zone: zone }),
      });
      const data = await res.json();

      if (res.status === 401) {
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {
          /* ignoriši */
        }
        setPoruka({ tip: 'greska', tekst: 'Pogrešan token — probaj ponovo i nalepi tačan API_TOKEN.' });
        return;
      }
      if (!res.ok) {
        setPoruka({
          tip: 'greska',
          tekst: data?.error ?? `Greška ${res.status}`,
        });
        return;
      }

      const r = data.report;
      setPoruka({
        tip: 'ok',
        tekst: `Gotovo: skrejpovano ${r?.rawFound ?? 0}, kvalifikovano ${r?.qualified ?? 0}, upisano ${r?.inserted ?? 0} (duplikata ${r?.duplicates ?? 0}). Osveži stranicu.`,
      });
    } catch (error) {
      setPoruka({ tip: 'greska', tekst: `Veza prekinuta: ${String(error).slice(0, 120)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="runbar">
      <select value={craft} onChange={(e) => setCraft(e.target.value)} disabled={busy}>
        {CRAFTS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <select value={zone} onChange={(e) => setZone(e.target.value)} disabled={busy}>
        {Object.values(RICH_ZONES).map((z) => (
          <option key={z.id} value={z.id}>
            {z.label}
          </option>
        ))}
      </select>

      <button className="btn btn-run" onClick={pokreni} disabled={busy} type="button">
        {busy ? 'Radi…' : 'Pokreni turu'}
      </button>

      {poruka && <div className={`runmsg runmsg-${poruka.tip}`}>{poruka.tekst}</div>}
    </div>
  );
}
