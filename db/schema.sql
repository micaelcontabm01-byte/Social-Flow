-- SocialFlow - Schema do banco de dados
-- Rodar no Supabase: SQL Editor > New Query > cole esse arquivo > Run
-- Tambem pode rodar local: psql $DATABASE_URL -f db/schema.sql

create extension if not exists pgcrypto;

-- ============================================================
-- USERS - quem faz login
-- ============================================================
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- ORGANIZATIONS - agencia, social media solo ou empresario
-- ============================================================
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references users(id) on delete cascade,
  plan_code text not null default 'none',
  ia_quota_limit int not null default 0,
  ia_quota_used int not null default 0,
  ia_quota_reset_at timestamptz not null default (now() + interval '30 days'),
  max_clients int not null default 0,
  max_collaborators int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  logo_data bytea,
  logo_mime_type text,
  logo_updated_at timestamptz,
  brand_color text,
  img_quota_limit int not null default 0,
  img_quota_used int not null default 0
);

-- ============================================================
-- ORGANIZATION_MEMBERS - vinculo user <-> org com role
-- Roles:
--   owner        = dono da conta (assinatura)
--   collaborator = pode criar/editar conteudo
--   client       = so visualiza e aprova
-- ============================================================
create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'collaborator', 'client')),
  client_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- ============================================================
-- CLIENTS - cliente da agencia (entidade gerenciada)
-- Nao confundir com organization_members.role='client'
-- (esse e o user que pode logar e ver o painel)
-- ============================================================
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  niche text,
  instagram_handle text,
  drive_folder_url text,
  drive_folder_id text,
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table organization_members
  drop constraint if exists organization_members_client_id_fkey;
alter table organization_members
  add constraint organization_members_client_id_fkey
  foreign key (client_id) references clients(id) on delete set null;

-- ============================================================
-- ORG_INTEGRATIONS - conexoes externas por workspace (Notion / Google Drive)
-- Tokens guardados encriptados pela aplicacao (lib/crypto.js)
-- ============================================================
create table if not exists org_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('notion', 'google_drive')),
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz,
  scope text,
  account_label text,
  config jsonb not null default '{}',
  connected_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

-- ============================================================
-- PERSONAS
-- ============================================================
create table if not exists personas (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  age_range text,
  gender text,
  location text,
  profession text,
  income_range text,
  pain_points jsonb not null default '[]',
  desires jsonb not null default '[]',
  objections jsonb not null default '[]',
  language_tone text,
  channels jsonb not null default '[]',
  raw_input jsonb,
  generated_by_ai boolean not null default false,
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- SCRIPTS - roteiro de reel/carrossel/post/story
-- ============================================================
create table if not exists scripts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  persona_id uuid references personas(id) on delete set null,
  title text not null,
  funnel_stage text not null check (funnel_stage in ('topo', 'meio', 'fundo')),
  format text not null check (format in ('reel', 'carrossel', 'post', 'story')),
  goal text,
  theme text,
  hook text,
  body text,
  cta text,
  caption text,
  hashtags jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'published')),
  raw_input jsonb,
  generated_by_ai boolean not null default false,
  created_by_user_id uuid references users(id) on delete set null,
  approved_at timestamptz,
  approved_by_user_id uuid references users(id) on delete set null,
  rejection_reason text,
  scheduled_for timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- CAROUSELS
-- ============================================================
create table if not exists carousels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  persona_id uuid references personas(id) on delete set null,
  script_id uuid references scripts(id) on delete set null,
  template_id text not null,
  title text not null,
  slides jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'rejected', 'published')),
  raw_input jsonb,
  generated_by_ai boolean not null default false,
  created_by_user_id uuid references users(id) on delete set null,
  approved_at timestamptz,
  approved_by_user_id uuid references users(id) on delete set null,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cover_image_data bytea,
  cover_image_mime text,
  cover_image_updated_at timestamptz
);

-- ============================================================
-- CAROUSEL_SLIDE_IMAGES - imagem de IA por slide (bytea, fora do jsonb slides)
-- ============================================================
create table if not exists carousel_slide_images (
  id uuid primary key default gen_random_uuid(),
  carousel_id uuid not null references carousels(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  slide_index int not null,
  image_data bytea not null,
  image_mime text not null default 'image/png',
  updated_at timestamptz not null default now(),
  unique (carousel_id, slide_index)
);

-- ============================================================
-- SCRIPT_COMMENTS - historico de comentarios/aprovacao/rejeicao de roteiro
-- ============================================================
create table if not exists script_comments (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references scripts(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  user_role text,
  content text not null,
  kind text not null default 'comment' check (kind in ('comment', 'rejection', 'submission', 'approval')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- CONTENT_PLANS - planejamento de conteudo (pilares, cadencia, objetivos)
-- ============================================================
create table if not exists content_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  persona_id uuid references personas(id) on delete set null,
  title text not null,
  summary text,
  pillars jsonb not null default '[]',
  cadence text,
  objectives jsonb not null default '[]',
  format_mix jsonb not null default '{}',
  raw_input jsonb,
  generated_by_ai boolean not null default false,
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- CONTENT_IDEAS - itens do calendario de edicao, ligados (opcional) a um plano
-- ============================================================
create table if not exists content_ideas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  plan_id uuid references content_plans(id) on delete set null,
  persona_id uuid references personas(id) on delete set null,
  title text not null,
  description text,
  format text check (format in ('reel', 'carrossel', 'post', 'story')),
  funnel_stage text check (funnel_stage in ('topo', 'meio', 'fundo')),
  pillar text,
  status text not null default 'idea' check (status in ('idea', 'in_production', 'done')),
  scheduled_for timestamptz,
  script_id uuid references scripts(id) on delete set null,
  carousel_id uuid references carousels(id) on delete set null,
  raw_input jsonb,
  generated_by_ai boolean not null default false,
  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- INVITATIONS - convite de colaborador/cliente por email (token)
-- ============================================================
create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role text not null check (role in ('collaborator', 'client')),
  client_id uuid references clients(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  invited_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_invitations_active_email
  on invitations(organization_id, email) where accepted_at is null;

-- ============================================================
-- PASSWORD_RESETS - token de recuperacao de senha ("esqueci minha senha")
-- ============================================================
create table if not exists password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null default (now() + interval '1 hour'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  email_sent_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- SUBSCRIPTIONS - assinatura ativa por organizacao (gateway de pagamento)
-- ============================================================
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  plan_code text not null,
  status text not null check (status in ('active', 'past_due', 'canceled', 'paused', 'trialing')),
  gateway text not null check (gateway in ('lastlink', 'stripe', 'manual')),
  gateway_subscription_id text,
  gateway_customer_id text,
  gateway_customer_email text,
  current_period_end timestamptz,
  canceled_at timestamptz,
  amount_cents int not null default 0,
  currency text not null default 'BRL',
  raw_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- IA_USAGE_LOG - log de consumo de IA (cota mensal)
-- ============================================================
create table if not exists ia_usage_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null,
  tokens_input int,
  tokens_output int,
  model text,
  cost_usd numeric,
  created_at timestamptz not null default now()
);

-- ============================================================
-- WEBHOOK_EVENTS - log bruto de webhooks recebidos (Lastlink etc.), idempotencia
-- ============================================================
create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  gateway text not null,
  event_id text not null,
  event_type text,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (gateway, event_id)
);

-- ============================================================
-- MONTHLY_REPORTS - dashboard PDF mensal por cliente (plano BLACK)
-- ============================================================
create table if not exists monthly_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  period_year int not null,
  period_month int not null,
  pdf_data bytea,
  metrics jsonb not null default '{}',
  generated_at timestamptz not null default now(),
  generated_by text not null default 'cron',
  unique (client_id, period_year, period_month)
);

-- ============================================================
-- SESSIONS - NAO criar aqui: e a tabela do connect-pg-simple
-- (server.js usa `createTableIfMissing: true`, o proprio pacote cria
-- `sessions(sid, sess, expire)` + indice em `expire` na primeira request)
-- ============================================================

-- ============================================================
-- FUNCTIONS
-- ============================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
alter function set_updated_at() set search_path = '';

-- ============================================================
-- Indices
-- ============================================================
create index if not exists idx_clients_org on clients(organization_id) where archived = false;
create index if not exists idx_org_integrations_org on org_integrations(organization_id);
create index if not exists idx_members_user on organization_members(user_id);
create index if not exists idx_members_org on organization_members(organization_id);
create index if not exists idx_members_client on organization_members(client_id) where client_id is not null;

create index if not exists idx_personas_client on personas(client_id);
create index if not exists idx_personas_org on personas(organization_id);

create index if not exists idx_scripts_client on scripts(client_id, created_at desc);
create index if not exists idx_scripts_org_status on scripts(organization_id, status, created_at desc);
create index if not exists idx_scripts_persona on scripts(persona_id) where persona_id is not null;

create index if not exists idx_carousels_client on carousels(client_id, created_at desc);
create index if not exists idx_carousels_org on carousels(organization_id, status, created_at desc);

create index if not exists idx_carousel_slide_images_carousel on carousel_slide_images(carousel_id);

create index if not exists idx_comments_org on script_comments(organization_id);
create index if not exists idx_comments_script on script_comments(script_id, created_at);

create index if not exists idx_content_plans_org_client on content_plans(organization_id, client_id);

create index if not exists idx_content_ideas_org_client on content_ideas(organization_id, client_id);
create index if not exists idx_content_ideas_org_scheduled on content_ideas(organization_id, scheduled_for);

create index if not exists idx_invitations_org on invitations(organization_id, created_at desc);
create index if not exists idx_invitations_email on invitations(email) where accepted_at is null;

create index if not exists idx_password_resets_user on password_resets(user_id, created_at desc);

create index if not exists idx_notifications_user on notifications(user_id, created_at desc);
create index if not exists idx_notifications_user_unread on notifications(user_id, created_at desc) where read_at is null;

create index if not exists idx_subscriptions_org on subscriptions(organization_id);
create index if not exists idx_subscriptions_active on subscriptions(organization_id) where status = 'active';
create index if not exists idx_subscriptions_gateway on subscriptions(gateway, gateway_subscription_id) where gateway_subscription_id is not null;
create index if not exists idx_subscriptions_email on subscriptions(gateway_customer_email) where gateway_customer_email is not null;

create index if not exists idx_ia_log_org on ia_usage_log(organization_id, created_at desc);

create index if not exists idx_webhook_unprocessed on webhook_events(gateway, created_at) where processed_at is null;

create index if not exists idx_monthly_reports_org on monthly_reports(organization_id, period_year desc, period_month desc);
create index if not exists idx_monthly_reports_client on monthly_reports(client_id, period_year desc, period_month desc);

-- ============================================================
-- ROW LEVEL SECURITY - todas as tabelas, sem policies (deny-all
-- para anon/authenticated). O backend acessa via role `postgres`
-- (BYPASSRLS), entao isso nao afeta o app - ver memoria do projeto.
-- ============================================================
alter table users enable row level security;
alter table organizations enable row level security;
alter table clients enable row level security;
alter table organization_members enable row level security;
alter table subscriptions enable row level security;
alter table ia_usage_log enable row level security;
alter table webhook_events enable row level security;
alter table personas enable row level security;
alter table scripts enable row level security;
alter table script_comments enable row level security;
alter table notifications enable row level security;
alter table carousels enable row level security;
alter table invitations enable row level security;
alter table password_resets enable row level security;
alter table monthly_reports enable row level security;
alter table org_integrations enable row level security;
alter table carousel_slide_images enable row level security;
alter table content_plans enable row level security;
alter table content_ideas enable row level security;
-- sessions: RLS habilitado tambem, mas fora daqui (tabela criada em runtime
-- pelo connect-pg-simple, nao existe no momento em que este script roda).
