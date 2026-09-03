-- ============================================================
--  MajstorKlik — Lead Generation Machine
--  Supabase / PostgreSQL šema
--
--  Pokretanje: Supabase Dashboard -> SQL Editor -> nalepi ceo fajl -> Run
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
--  LEADS
-- ------------------------------------------------------------
create table if not exists public.leads (
  id                       uuid primary key default gen_random_uuid(),

  -- polja iz specifikacije
  client_name              text        not null,
  address                  text        not null default '',
  municipality             text        not null default '',
  is_high_income_location  boolean     not null default false,
  phone_e164               text        not null,
  whatsapp_link            text        not null default '',
  lead_score               smallint    not null check (lead_score between 1 and 100),
  purchasing_power_tier    text        not null check (purchasing_power_tier in ('HIGH','MEDIUM','STANDARD')),
  reasoning                text        not null default '',
  cold_pitch_message       text        not null default '',

  -- interna polja pipeline-a
  craft                    text        not null check (craft in ('vodoinstalater','gipsar','moler')),
  source                   text        not null,
  source_url               text        not null default '',
  zone_id                  text,
  zone_label               text,
  target_kind              text,
  segment                  text        not null default 'B2B' check (segment in ('B2B','B2C')),
  urgency                  text        not null default 'NONE' check (urgency in ('NONE','LOW','MEDIUM','HIGH')),
  phone_national           text,
  phone_type               text,
  viber_link               text,
  sms_link                 text,
  rule_score               smallint,
  ai_score                 smallint,
  dedupe_key               text        not null,
  raw_description          text,
  ai_provider              text,
  ai_model                 text,
  status                   text        not null default 'new'
                             check (status in ('new','contacted','replied','won','lost','rejected')),
  note                     text,

  scraped_at               timestamptz not null default now(),
  contacted_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ------------------------------------------------------------
--  DEDUPLIKACIJA — srce sistema.
--  Jedan broj = jedan lead. Zauvek. Bez ovoga majstor zove istog
--  čoveka po treći put i gori mu reputacija broja.
-- ------------------------------------------------------------
create unique index if not exists leads_phone_e164_key on public.leads (phone_e164);
create unique index if not exists leads_dedupe_key_idx  on public.leads (dedupe_key);

-- Indeksi za dashboard i filtriranje
create index if not exists leads_score_idx    on public.leads (lead_score desc, created_at desc);
create index if not exists leads_craft_idx    on public.leads (craft, lead_score desc);
create index if not exists leads_zone_idx     on public.leads (zone_id, lead_score desc);
create index if not exists leads_status_idx   on public.leads (status, created_at desc);
create index if not exists leads_tier_idx     on public.leads (purchasing_power_tier, lead_score desc);
create index if not exists leads_created_idx  on public.leads (created_at desc);

-- Pretraga po nazivu/adresi (trigram)
create extension if not exists pg_trgm;
create index if not exists leads_name_trgm_idx on public.leads using gin (client_name gin_trgm_ops);
create index if not exists leads_addr_trgm_idx on public.leads using gin (address gin_trgm_ops);

-- auto updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
--  HARVEST RUNS — bez ovoga ne znaš koji izvor ti stvarno donosi lovu
-- ------------------------------------------------------------
create table if not exists public.harvest_runs (
  id               uuid primary key default gen_random_uuid(),
  craft            text        not null,
  zone_id          text        not null,
  source           text        not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  raw_found        integer     not null default 0,
  qualified        integer     not null default 0,
  inserted         integer     not null default 0,
  duplicates       integer     not null default 0,
  rejected         integer     not null default 0,
  ai_fallback_used integer     not null default 0,
  error            text,
  created_at       timestamptz not null default now()
);

create index if not exists runs_started_idx on public.harvest_runs (started_at desc);
create index if not exists runs_source_idx  on public.harvest_runs (source, started_at desc);

-- ------------------------------------------------------------
--  RLS — leadovi su poslovna imovina, anon ključ ne sme da ih čita
-- ------------------------------------------------------------
alter table public.leads        enable row level security;
alter table public.harvest_runs enable row level security;

-- Podrazumevano: NIJEDNA politika za anon/authenticated =>
-- pristup ide isključivo preko service_role ključa sa servera.
-- Ako kasnije napraviš login za majstore, dodaj politiku ovde, npr:
--
--   create policy "majstor vidi svoje leadove" on public.leads
--     for select to authenticated
--     using (assigned_to = auth.uid());

-- ------------------------------------------------------------
--  KORISNI POGLEDI
-- ------------------------------------------------------------

-- Top leadovi koje treba zvati danas
create or replace view public.hot_leads as
select id, client_name, municipality, zone_label, craft, lead_score,
       purchasing_power_tier, urgency, phone_e164, phone_national,
       whatsapp_link, cold_pitch_message, created_at
from public.leads
where status = 'new'
  and lead_score >= 70
order by
  case urgency when 'HIGH' then 0 when 'MEDIUM' then 1 when 'LOW' then 2 else 3 end,
  lead_score desc,
  created_at desc;

-- Dnevni učinak mašine
create or replace view public.daily_stats as
select date_trunc('day', created_at)::date as dan,
       count(*)                                            as ukupno,
       count(*) filter (where purchasing_power_tier = 'HIGH') as high_tier,
       count(*) filter (where lead_score >= 80)            as vrhunski,
       round(avg(lead_score))                              as prosecan_skor
from public.leads
group by 1
order by 1 desc;
