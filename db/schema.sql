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
  owner_user_id uuid not null references users(id) on delete restrict,
  plan_code text not null default 'free',
  ia_quota_limit int not null default 10,
  ia_quota_used int not null default 0,
  ia_quota_reset_at timestamptz not null default (now() + interval '30 days'),
  max_clients int not null default 1,
  max_collaborators int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
-- Indices
-- ============================================================
create index if not exists idx_clients_org on clients(organization_id) where archived = false;
create index if not exists idx_members_user on organization_members(user_id);
create index if not exists idx_members_org on organization_members(organization_id);
create index if not exists idx_members_client on organization_members(client_id) where client_id is not null;
