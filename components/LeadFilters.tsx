'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { RICH_ZONES } from '@/lib/config/zones';

const CRAFTS = [
  { value: '', label: 'Svi zanati' },
  { value: 'vodoinstalater', label: 'Vodoinstalater' },
  { value: 'gipsar', label: 'Gipsar' },
  { value: 'moler', label: 'Moler' },
];

const TIERS = [
  { value: '', label: 'Sve kupovne moći' },
  { value: 'HIGH', label: 'Visoka' },
  { value: 'MEDIUM', label: 'Srednja' },
  { value: 'STANDARD', label: 'Standard' },
];

const STATUSES = [
  { value: '', label: 'Svi statusi' },
  { value: 'new', label: 'Novi' },
  { value: 'contacted', label: 'Kontaktirani' },
  { value: 'replied', label: 'Odgovorili' },
  { value: 'won', label: 'Dobijeni' },
];

export function LeadFilters() {
  const router = useRouter();
  const params = useSearchParams();

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params?.toString() ?? '');
      if (value) next.set(key, value);
      else next.delete(key);
      router.push(`/?${next.toString()}`);
    },
    [params, router],
  );

  return (
    <div className="filters">
      <select value={params?.get('craft') ?? ''} onChange={(e) => setParam('craft', e.target.value)}>
        {CRAFTS.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <select value={params?.get('zone') ?? ''} onChange={(e) => setParam('zone', e.target.value)}>
        <option value="">Sve zone</option>
        {Object.values(RICH_ZONES).map((z) => (
          <option key={z.id} value={z.id}>
            {z.label}
          </option>
        ))}
      </select>

      <select value={params?.get('tier') ?? ''} onChange={(e) => setParam('tier', e.target.value)}>
        {TIERS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      <select value={params?.get('status') ?? ''} onChange={(e) => setParam('status', e.target.value)}>
        {STATUSES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      <select value={params?.get('minScore') ?? ''} onChange={(e) => setParam('minScore', e.target.value)}>
        <option value="">Svaki skor</option>
        <option value="80">Skor 80+</option>
        <option value="70">Skor 70+</option>
        <option value="60">Skor 60+</option>
      </select>

      <input
        type="search"
        placeholder="Pretraga po nazivu ili adresi…"
        defaultValue={params?.get('q') ?? ''}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setParam('q', (e.target as HTMLInputElement).value);
        }}
      />
    </div>
  );
}
