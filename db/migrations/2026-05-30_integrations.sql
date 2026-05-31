-- Migration: integracoes externas por organizacao (Notion + Google Drive)
-- Cada workspace (organization) conecta a propria conta. Tokens guardados
-- encriptados (AES-256-GCM) pela aplicacao - ver lib/crypto.js.
-- Rodar uma unica vez no Supabase. Seguro de rodar em banco vazio.

create table if not exists org_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('notion', 'google_drive')),
  access_token_enc text not null,
  refresh_token_enc text,            -- Google usa refresh; Notion nao expira
  expires_at timestamptz,            -- so Google
  scope text,
  account_label text,                -- nome da workspace Notion / email Google (exibir na UI)
  config jsonb not null default '{}', -- Notion: { database_id, database_title }; Drive: { folder_id, folder_name }
  connected_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create index if not exists idx_org_integrations_org on org_integrations(organization_id);
