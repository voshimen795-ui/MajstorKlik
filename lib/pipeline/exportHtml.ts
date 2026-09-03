/**
 * HTML IZVOZ — mašina bez baze i bez hostinga.
 *
 * Pokreneš turu na računaru, pošalješ sebi jedan fajl na telefon, otvoriš ga i
 * kucaš WhatsApp dugmad. Nema Supabase-a, nema Vercela, nema podešavanja.
 *
 * Fajl je NAMERNO samostalan: sav CSS i JS su unutra, nema nijednog spoljnog
 * zahteva. Otvara se sa `file://`, radi bez interneta (osim samih wa.me linkova),
 * i može da se pošalje kroz WhatsApp/Viber/mejl kao običan prilog.
 */

import type { LeadRecord } from '../types/lead';
import { CRAFTS, type Craft } from '../config/categories';

/** Escape za tekst unutar HTML-a. Naziv firme ume da sadrži navodnike i &. */
function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Srpska množina: 1 lead, 2-4 leada, 5+ leadova (sa izuzetkom 11-14).
 * Sitnica, ali "2 leadova" odmah odaje da je tekst mašinski.
 */
function pluralLeadova(n: number): string {
  const zadnja = n % 10;
  const zadnjeDve = n % 100;
  if (zadnja === 1 && zadnjeDve !== 11) return `${n} lead spreman`;
  if (zadnja >= 2 && zadnja <= 4 && (zadnjeDve < 12 || zadnjeDve > 14)) return `${n} leada spremna`;
  return `${n} leadova spremno`;
}

function tierLabel(tier: string): string {
  if (tier === 'HIGH') return 'Visoka kupovna moć';
  if (tier === 'MEDIUM') return 'Srednja kupovna moć';
  return 'Standard';
}

function urgencyLabel(urgency: string): string | null {
  if (urgency === 'HIGH') return 'Hitno';
  if (urgency === 'MEDIUM') return 'Uskoro';
  return null;
}

export interface HtmlExportMeta {
  craft: Craft;
  zoneLabel: string;
  generatedAt: Date;
  rawFound: number;
  rejected: number;
}

export function renderLeadsHtml(leads: LeadRecord[], meta: HtmlExportMeta): string {
  const datum = meta.generatedAt.toLocaleString('sr-RS', { timeZone: 'Europe/Belgrade' });
  const craftLabel = CRAFTS[meta.craft].label;

  const high = leads.filter((l) => l.purchasing_power_tier === 'HIGH').length;
  const urgent = leads.filter((l) => l.urgency === 'HIGH' || l.urgency === 'MEDIUM').length;
  const avg = leads.length > 0 ? Math.round(leads.reduce((sum, l) => sum + l.lead_score, 0) / leads.length) : 0;

  const cards = leads.map((lead, index) => renderCard(lead, index)).join('\n');

  return `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MajstorKlik — ${esc(craftLabel)} / ${esc(meta.zoneLabel)}</title>
<style>
:root{
  --navy-900:#0a1826; --navy-800:#0e2033; --navy-700:#12283f; --navy-600:#1a3b5c;
  --navy-400:#3d6c99; --navy-200:#a8c0d6; --navy-50:#eef4f9;
  --accent-700:#c94f1c; --accent-600:#e4622a; --accent-500:#ff7a3d; --accent-400:#ff9663; --accent-50:#fff3ec;
  --slate-800:#1a2530; --slate-600:#44576b; --slate-500:#5b6b7a; --slate-400:#8496a6;
  --slate-300:#c3ced8; --slate-200:#e4e8ec; --slate-100:#f0f3f6; --slate-50:#f7f8fa; --white:#fff;
  --success:#17936a; --success-bg:#e8f6f1; --danger:#c1382a; --danger-bg:#fdeceb; --whatsapp:#25d366;
  --r-sm:8px; --r-md:12px; --r-full:999px;
  --e-1:0 1px 2px rgba(16,24,32,.06),0 1px 3px rgba(16,24,32,.04);
  --e-2:0 4px 10px rgba(16,24,32,.08),0 2px 4px rgba(16,24,32,.05);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:var(--slate-50); color:var(--slate-800); line-height:1.55;
  -webkit-font-smoothing:antialiased; padding-bottom:40px;
}
.wrap{max-width:820px;margin-inline:auto;padding:0 14px}

header{background:linear-gradient(150deg,var(--navy-800),var(--navy-900));color:#fff;padding:22px 0 20px;margin-bottom:16px}
header h1{font-size:1.25rem;font-weight:800;letter-spacing:-.02em}
header p{color:var(--navy-200);font-size:.82rem;margin-top:4px}
.badge{display:inline-block;font-size:.68rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
  background:rgba(255,122,61,.18);color:var(--accent-400);padding:5px 11px;border-radius:var(--r-full);margin-bottom:8px}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
.stat{background:var(--white);border:1px solid var(--slate-200);border-radius:var(--r-md);padding:11px 10px;text-align:center;box-shadow:var(--e-1)}
.stat b{display:block;font-size:1.4rem;font-weight:800;letter-spacing:-.03em;line-height:1.1}
.stat span{font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;color:var(--slate-400);font-weight:700}
.stat.hot b{color:var(--accent-600)}

.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.tools input,.tools select{
  font-family:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--slate-200);
  border-radius:var(--r-sm);background:var(--white);color:var(--slate-800);flex:1 1 160px;min-width:0;
}

.lead{background:var(--white);border:1px solid var(--slate-200);border-left:4px solid var(--slate-300);
  border-radius:var(--r-md);padding:15px 16px;box-shadow:var(--e-1);margin-bottom:11px}
.lead.tier-HIGH{border-left-color:var(--accent-500)}
.lead.tier-MEDIUM{border-left-color:var(--navy-400)}
.lead.hidden{display:none}
.head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.title{font-size:1.02rem;font-weight:700;letter-spacing:-.01em;line-height:1.3}
.meta{color:var(--slate-500);font-size:.82rem;margin-top:3px}
.score{font-size:1.5rem;font-weight:800;letter-spacing:-.03em;line-height:1;text-align:right;flex:none}
.score small{display:block;font-size:.58rem;letter-spacing:.07em;text-transform:uppercase;color:var(--slate-400);font-weight:700;margin-top:2px}
.s-high{color:var(--accent-600)} .s-mid{color:var(--navy-600)} .s-low{color:var(--slate-400)}

.tags{display:flex;gap:5px;flex-wrap:wrap;margin:10px 0}
.tag{font-size:.66rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;
  padding:3px 8px;border-radius:var(--r-full);background:var(--slate-100);color:var(--slate-600)}
.tag.high{background:var(--accent-50);color:var(--accent-700)}
.tag.urgent{background:var(--danger-bg);color:var(--danger)}
.tag.zone{background:var(--navy-50);color:var(--navy-600)}
.tag.b2b{background:var(--success-bg);color:var(--success)}

.why{font-size:.85rem;color:var(--slate-600);border-left:2px solid var(--slate-200);padding-left:11px;margin-bottom:11px}
.pitch{background:var(--slate-50);border:1px dashed var(--slate-300);border-radius:var(--r-sm);
  padding:11px 13px;font-size:.87rem;white-space:pre-wrap;margin-bottom:11px}
.pitch-label{font-size:.63rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--slate-400);margin-bottom:5px}

.actions{display:flex;gap:7px;flex-wrap:wrap}
.btn{font-family:inherit;font-size:.87rem;font-weight:700;cursor:pointer;text-decoration:none;
  border:1px solid var(--slate-200);background:var(--white);color:var(--slate-800);
  padding:11px 14px;border-radius:var(--r-sm);display:inline-flex;align-items:center;gap:6px;flex:1 1 auto;justify-content:center}
.btn:active{transform:translateY(1px)}
.wa{background:var(--whatsapp);border-color:var(--whatsapp);color:#05391b}
.call{background:var(--navy-700);border-color:var(--navy-700);color:#fff}
.done{background:var(--success-bg);border-color:#bfe5d7;color:var(--success)}
.lead.zvan{opacity:.55}
.lead.zvan .title::after{content:" ✓";color:var(--success)}

.empty{background:var(--white);border:1px dashed var(--slate-300);border-radius:var(--r-md);
  padding:30px 20px;text-align:center;color:var(--slate-500)}
footer{text-align:center;color:var(--slate-400);font-size:.75rem;margin-top:22px;line-height:1.7}

@media (max-width:520px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .btn{flex:1 1 100%}
}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <span class="badge">${esc(craftLabel)} · ${esc(meta.zoneLabel)}</span>
    <h1>${pluralLeadova(leads.length)} za poziv</h1>
    <p>Napravljeno ${esc(datum)} · pregledano ${meta.rawFound} objekata, odbačeno ${meta.rejected}</p>
  </div>
</header>

<div class="wrap">

  <div class="stats">
    <div class="stat hot"><b>${high}</b><span>Visoka moć</span></div>
    <div class="stat"><b>${urgent}</b><span>Hitni</span></div>
    <div class="stat"><b>${avg}</b><span>Prosek</span></div>
    <div class="stat"><b>${leads.length}</b><span>Ukupno</span></div>
  </div>

  <div class="tools">
    <input type="search" id="q" placeholder="Pretraga po nazivu ili adresi…">
    <select id="f">
      <option value="">Svi leadovi</option>
      <option value="HIGH">Samo visoka kupovna moć</option>
      <option value="URGENT">Samo hitni</option>
      <option value="80">Skor 80+</option>
      <option value="70">Skor 70+</option>
      <option value="NEZVAN">Još nisam zvao</option>
    </select>
  </div>

  <div id="lista">
${cards || '    <div class="empty">Nijedan lead nije prošao prag kvaliteta u ovoj turi.</div>'}
  </div>

  <footer>
    MajstorKlik · lead mašina<br>
    Oznaka „zvao sam" se pamti na ovom telefonu.<br>
    Pošalji jednu poruku po kontaktu. Na „ne, hvala" — stani.
  </footer>
</div>

<script>
(function () {
  var KEY = 'mk_zvani_' + location.pathname;
  var zvani = {};
  try { zvani = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { zvani = {}; }

  function sacuvaj() {
    try { localStorage.setItem(KEY, JSON.stringify(zvani)); } catch (e) {}
  }

  // Vrati oznake "zvao sam" posle osvežavanja
  Object.keys(zvani).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('zvan');
  });

  document.addEventListener('click', function (ev) {
    var target = ev.target.closest ? ev.target.closest('[data-akcija]') : null;
    if (!target) return;
    var akcija = target.getAttribute('data-akcija');
    var kartica = target.closest('.lead');
    if (!kartica) return;

    if (akcija === 'kopiraj') {
      var tekst = kartica.querySelector('.pitch-text').textContent;
      kopiraj(tekst, target);
    }

    if (akcija === 'zvao') {
      var id = kartica.id;
      if (zvani[id]) { delete zvani[id]; kartica.classList.remove('zvan'); target.textContent = 'Označi kao zvano'; }
      else { zvani[id] = 1; kartica.classList.add('zvan'); target.textContent = 'Vrati u nezvane'; }
      sacuvaj();
      filtriraj();
    }

    // Klik na WhatsApp/poziv automatski označava lead kao kontaktiran
    if (akcija === 'kontakt') {
      var kid = kartica.id;
      zvani[kid] = 1;
      kartica.classList.add('zvan');
      var dugme = kartica.querySelector('[data-akcija="zvao"]');
      if (dugme) dugme.textContent = 'Vrati u nezvane';
      sacuvaj();
    }
  });

  function kopiraj(tekst, dugme) {
    var original = dugme.textContent;
    function gotovo() { dugme.textContent = 'Kopirano'; setTimeout(function () { dugme.textContent = original; }, 1600); }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(tekst).then(gotovo).catch(function () { rezerva(tekst, gotovo); });
    } else {
      rezerva(tekst, gotovo);
    }
  }

  // file:// nije "secure context", pa clipboard API tamo ne radi — otud rezerva
  function rezerva(tekst, gotovo) {
    var ta = document.createElement('textarea');
    ta.value = tekst;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); gotovo(); } catch (e) {}
    document.body.removeChild(ta);
  }

  var q = document.getElementById('q');
  var f = document.getElementById('f');

  function filtriraj() {
    var tekst = (q.value || '').toLowerCase();
    var filter = f.value;

    Array.prototype.forEach.call(document.querySelectorAll('.lead'), function (el) {
      var trazi = (el.getAttribute('data-pretraga') || '').toLowerCase();
      var skor = parseInt(el.getAttribute('data-skor'), 10);
      var tier = el.getAttribute('data-tier');
      var hitno = el.getAttribute('data-hitno') === '1';

      var prolazi = !tekst || trazi.indexOf(tekst) !== -1;
      if (prolazi && filter === 'HIGH') prolazi = tier === 'HIGH';
      if (prolazi && filter === 'URGENT') prolazi = hitno;
      if (prolazi && filter === 'NEZVAN') prolazi = !zvani[el.id];
      if (prolazi && (filter === '80' || filter === '70')) prolazi = skor >= parseInt(filter, 10);

      el.classList.toggle('hidden', !prolazi);
    });
  }

  q.addEventListener('input', filtriraj);
  f.addEventListener('change', filtriraj);
})();
</script>

</body>
</html>`;
}

function renderCard(lead: LeadRecord, index: number): string {
  const id = `lead-${index}`;
  const scoreClass = lead.lead_score >= 80 ? 's-high' : lead.lead_score >= 60 ? 's-mid' : 's-low';
  const hitno = urgencyLabel(lead.urgency);
  const pretraga = [lead.client_name, lead.address, lead.municipality, lead.zone_label].filter(Boolean).join(' ');

  const waBtn = lead.whatsapp_link
    ? `<a class="btn wa" href="${esc(lead.whatsapp_link)}" target="_blank" rel="noreferrer" data-akcija="kontakt">Pošalji WhatsApp</a>`
    : '';

  const viberBtn = lead.viber_link
    ? `<a class="btn" href="${esc(lead.viber_link)}" data-akcija="kontakt">Viber</a>`
    : '';

  const izvor = lead.source_url
    ? `<a class="btn" href="${esc(lead.source_url)}" target="_blank" rel="noreferrer">Izvor</a>`
    : '';

  return `    <article class="lead tier-${esc(lead.purchasing_power_tier)}" id="${id}"
      data-skor="${lead.lead_score}" data-tier="${esc(lead.purchasing_power_tier)}"
      data-hitno="${hitno ? '1' : '0'}" data-pretraga="${esc(pretraga)}">
      <div class="head">
        <div>
          <div class="title">${esc(lead.client_name)}</div>
          <div class="meta">${esc(lead.address || lead.municipality)}${lead.phone_national ? ` · ${esc(lead.phone_national)}` : ''}</div>
        </div>
        <div class="score ${scoreClass}">${lead.lead_score}<small>skor</small></div>
      </div>

      <div class="tags">
        ${lead.zone_label ? `<span class="tag zone">${esc(lead.zone_label)}</span>` : ''}
        <span class="tag${lead.purchasing_power_tier === 'HIGH' ? ' high' : ''}">${esc(tierLabel(lead.purchasing_power_tier))}</span>
        ${hitno ? `<span class="tag urgent">${esc(hitno)}</span>` : ''}
        <span class="tag b2b">${esc(lead.segment)}</span>
      </div>

      ${lead.reasoning ? `<p class="why">${esc(lead.reasoning)}</p>` : ''}

      <div class="pitch">
        <div class="pitch-label">Poruka spremna za slanje</div>
        <div class="pitch-text">${esc(lead.cold_pitch_message)}</div>
      </div>

      <div class="actions">
        ${waBtn}
        <a class="btn call" href="tel:${esc(lead.phone_e164)}" data-akcija="kontakt">Pozovi ${esc(lead.phone_national ?? lead.phone_e164)}</a>
        ${viberBtn}
        <button class="btn" type="button" data-akcija="kopiraj">Kopiraj poruku</button>
        <button class="btn done" type="button" data-akcija="zvao">Označi kao zvano</button>
        ${izvor}
      </div>
    </article>`;
}
