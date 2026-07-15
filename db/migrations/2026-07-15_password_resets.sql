-- Migration: tabela de tokens pra recuperacao de senha ("esqueci minha senha").
-- Token expira em 1h, so pode ser usado uma vez (used_at). Seguro rodar mais de uma vez.

create table if not exists password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null default (now() + interval '1 hour'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_password_resets_user on password_resets(user_id, created_at desc);

alter table password_resets enable row level security;
