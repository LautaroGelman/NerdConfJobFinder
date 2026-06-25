-- ============================================================================
-- Job Agent — esquema inicial
-- Postgres (Supabase). Ejecutar con: supabase db push
-- ============================================================================

-- gen_random_uuid() viene de pgcrypto, ya disponible en Supabase.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- sources: cada fuente de ofertas (API/RSS). Guarda estado de polling.
-- ---------------------------------------------------------------------------
create table if not exists public.sources (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  type              text not null check (type in ('api', 'rss', 'ats')),
  base_url          text not null,
  config            jsonb not null default '{}'::jsonb,  -- ej. {"board_token":"acme"} para ATS
  etag              text,
  last_modified     text,
  last_polled_at    timestamptz,
  poll_interval_sec integer not null default 120,
  enabled           boolean not null default true,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- jobs: ofertas normalizadas. Dedup por (source_id, external_id) y content_hash.
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid references public.sources(id) on delete set null,
  source_name   text not null,
  external_id   text not null,
  title         text not null,
  company       text,
  location      text,
  remote        boolean,
  candidate_region text,                  -- ej. "LATAM", "Worldwide", "US only"
  url           text not null,
  description   text,
  tags          text[] not null default '{}',
  salary_min    integer,
  salary_max    integer,
  posted_at     timestamptz,
  fetched_at    timestamptz not null default now(),
  content_hash  text not null,
  raw           jsonb,
  unique (source_id, external_id)
);
create index if not exists jobs_content_hash_idx on public.jobs (content_hash);
create index if not exists jobs_posted_at_idx     on public.jobs (posted_at desc);

-- ---------------------------------------------------------------------------
-- profiles: el perfil que el usuario carga desde la web.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null default 'Mi perfil',
  keywords_include    text[] not null default '{}',
  keywords_exclude    text[] not null default '{}',
  locations           text[] not null default '{}',
  remote_pref         text not null default 'any' check (remote_pref in ('any', 'remote', 'onsite')),
  min_salary          integer,
  seniority           text,
  cv_text             text not null default '',
  score_threshold     integer not null default 6 check (score_threshold between 1 and 10),
  telegram_chat_id    bigint,
  telegram_link_token text unique default replace(gen_random_uuid()::text, '-', ''),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- matches: oferta que pasó el filtro y fue puntuada. REALTIME = ON.
-- ---------------------------------------------------------------------------
create table if not exists public.matches (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  score       integer not null check (score between 1 and 10),
  tier        text not null default 'llm' check (tier in ('filter', 'llm')),
  reasons     text,
  created_at  timestamptz not null default now(),
  unique (job_id, profile_id)
);
create index if not exists matches_profile_created_idx on public.matches (profile_id, created_at desc);

-- ---------------------------------------------------------------------------
-- applications: postulación asistida (draft de carta + tracking de estado).
-- ---------------------------------------------------------------------------
create table if not exists public.applications (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'draft' check (status in ('draft', 'sent', 'interview', 'rejected')),
  cover_letter text,
  notes        text,
  applied_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (job_id, profile_id)
);

-- ---------------------------------------------------------------------------
-- notifications: registro de envíos (Telegram / web), para auditar y no duplicar.
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid not null references public.matches(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  channel     text not null default 'telegram',
  status      text not null default 'sent' check (status in ('sent', 'error')),
  error       text,
  sent_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- seen: gate de dedup por perfil. Evita re-notificar la misma oferta.
-- ---------------------------------------------------------------------------
create table if not exists public.seen (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  content_hash  text not null,
  fuzzy_key     text,
  first_seen_at timestamptz not null default now(),
  unique (profile_id, content_hash)
);
create index if not exists seen_profile_hash_idx on public.seen (profile_id, content_hash);

-- ============================================================================
-- Realtime: el front se suscribe a INSERT en matches para el feed en vivo.
-- ============================================================================
alter publication supabase_realtime add table public.matches;

-- ============================================================================
-- RLS — Row Level Security
-- Las Edge Functions usan la SERVICE ROLE key y saltan RLS (escriben libre).
-- El front usa la ANON key: políticas permisivas para un demo de 1 usuario.
-- Para multiusuario real, reemplazar por políticas basadas en auth.uid().
-- ============================================================================
alter table public.sources       enable row level security;
alter table public.jobs          enable row level security;
alter table public.profiles      enable row level security;
alter table public.matches       enable row level security;
alter table public.applications  enable row level security;
alter table public.notifications enable row level security;
alter table public.seen          enable row level security;

-- Lectura pública (anon + authenticated) de lo que el feed necesita mostrar.
create policy "read jobs"          on public.jobs          for select using (true);
create policy "read matches"       on public.matches       for select using (true);
create policy "read applications"  on public.applications  for select using (true);
create policy "read sources"       on public.sources       for select using (true);

-- Perfiles: el demo deja crear/leer/editar desde el front.
create policy "read profiles"   on public.profiles for select using (true);
create policy "insert profiles" on public.profiles for insert with check (true);
create policy "update profiles" on public.profiles for update using (true) with check (true);

-- Applications: permitir actualizar estado/notas desde el front.
create policy "insert applications" on public.applications for insert with check (true);
create policy "update applications" on public.applications for update using (true) with check (true);

-- ============================================================================
-- Seed: fuentes sin auth, listas para poolear. Editar/agregar libremente.
-- Para ATS (Greenhouse/Lever/Ashby) cargá un board_token real en config.
-- ============================================================================
insert into public.sources (name, type, base_url, config, poll_interval_sec) values
  ('getonbrd',          'api', 'https://www.getonbrd.com/api/v0/jobs?per_page=30&expand=company', '{}'::jsonb, 120),
  ('weworkremotely',    'rss', 'https://weworkremotely.com/remote-jobs.rss',                       '{}'::jsonb, 180),
  ('hnhiring',          'rss', 'https://hnrss.org/whoishiring/jobs?q=remote',                      '{}'::jsonb, 300),
  ('remotive',          'api', 'https://remotive.com/api/remote-jobs?limit=30',                    '{}'::jsonb, 1800)
on conflict (name) do nothing;

-- Ejemplos de ATS (deshabilitados hasta que pongas board_tokens reales):
insert into public.sources (name, type, base_url, config, poll_interval_sec, enabled) values
  ('greenhouse-example', 'ats', 'https://boards-api.greenhouse.io', '{"provider":"greenhouse","board_token":"REEMPLAZAR"}'::jsonb, 180, false),
  ('lever-example',      'ats', 'https://api.lever.co',             '{"provider":"lever","company":"REEMPLAZAR"}'::jsonb,       180, false)
on conflict (name) do nothing;
