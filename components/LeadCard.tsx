'use client';

/**
 * Kartica leada — ovde se posao stvarno dešava.
 *
 * Jedno pravilo dizajna: od otvaranja stranice do poslate poruke — JEDAN klik.
 * WhatsApp dugme već nosi generisanu poruku u linku, majstor samo pritisne "pošalji".
 */

import { useState } from 'react';
import type { LeadRecord, LeadStatus } from '@/lib/types/lead';

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'Nov',
  contacted: 'Kontaktiran',
  replied: 'Odgovorio',
  won: 'Posao dobijen',
  lost: 'Otpao',
  rejected: 'Odbačen',
};

export function LeadCard({ lead }: { lead: LeadRecord }) {
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const scoreClass = lead.lead_score >= 80 ? 's-high' : lead.lead_score >= 60 ? 's-mid' : 's-low';

  async function changeStatus(next: LeadStatus) {
    if (!lead.id) return;
    setSaving(true);
    setStatus(next);
    try {
      await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
    } catch {
      setStatus(lead.status);
    } finally {
      setSaving(false);
    }
  }

  async function copyPitch() {
    try {
      await navigator.clipboard.writeText(lead.cold_pitch_message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard nedostupan (http, stari browser) */
    }
  }

  return (
    <article className={`lead tier-${lead.purchasing_power_tier}`}>
      <div className="lead-head">
        <div>
          <div className="lead-title">{lead.client_name}</div>
          <div className="lead-meta">
            {lead.address || lead.municipality}
            {lead.phone_national ? ` · ${lead.phone_national}` : ''}
          </div>
        </div>
        <div className={`score ${scoreClass}`}>
          {lead.lead_score}
          <small>skor</small>
        </div>
      </div>

      <div className="tags">
        {lead.zone_label && <span className="tag zone">{lead.zone_label}</span>}
        <span className={`tag ${lead.purchasing_power_tier === 'HIGH' ? 'high' : ''}`}>
          {lead.purchasing_power_tier === 'HIGH' ? 'Visoka kupovna moć' : lead.purchasing_power_tier === 'MEDIUM' ? 'Srednja kupovna moć' : 'Standard'}
        </span>
        {(lead.urgency === 'HIGH' || lead.urgency === 'MEDIUM') && (
          <span className="tag urgent">{lead.urgency === 'HIGH' ? 'Hitno' : 'Uskoro'}</span>
        )}
        <span className="tag b2b">{lead.segment}</span>
        <span className="tag">{lead.craft}</span>
        {lead.ai_provider && <span className="tag">{lead.ai_provider}</span>}
      </div>

      {lead.reasoning && <p className="reasoning">{lead.reasoning}</p>}

      <div className="pitch">
        <div className="pitch-label">Poruka spremna za slanje</div>
        {lead.cold_pitch_message}
      </div>

      <div className="actions">
        {lead.whatsapp_link && (
          <a
            className="btn btn-wa"
            href={lead.whatsapp_link}
            target="_blank"
            rel="noreferrer"
            onClick={() => changeStatus('contacted')}
          >
            Pošalji WhatsApp
          </a>
        )}
        <a className="btn btn-call" href={`tel:${lead.phone_e164}`} onClick={() => changeStatus('contacted')}>
          Pozovi {lead.phone_national ?? lead.phone_e164}
        </a>
        {lead.viber_link && (
          <a className="btn btn-ghost" href={lead.viber_link} target="_blank" rel="noreferrer">
            Viber
          </a>
        )}
        <button className="btn btn-ghost" onClick={copyPitch} type="button">
          {copied ? 'Kopirano' : 'Kopiraj poruku'}
        </button>

        <select
          className="btn btn-ghost"
          value={status}
          disabled={saving || !lead.id}
          onChange={(event) => changeStatus(event.target.value as LeadStatus)}
        >
          {(Object.keys(STATUS_LABELS) as LeadStatus[]).map((key) => (
            <option key={key} value={key}>
              {STATUS_LABELS[key]}
            </option>
          ))}
        </select>

        {lead.source_url && (
          <a className="btn btn-ghost" href={lead.source_url} target="_blank" rel="noreferrer">
            Izvor
          </a>
        )}
      </div>
    </article>
  );
}
