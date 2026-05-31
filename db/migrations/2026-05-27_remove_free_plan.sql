-- Migration: remocao do plano free e renomeacao de planos
-- (starter -> solo / agency -> black, novos precos e limites)
-- Rodar uma unica vez no Supabase apos atualizar o codigo.
-- Seguro de rodar em banco vazio tambem.

-- 1. Altera defaults da tabela organizations
alter table organizations
  alter column plan_code set default 'none',
  alter column ia_quota_limit set default 0,
  alter column max_clients set default 0;

-- 2. Migra orgs que ainda estao em 'free' para 'none' (sem acesso ate escolher plano)
update organizations
  set plan_code = 'none',
      ia_quota_limit = 0,
      max_clients = 0,
      max_collaborators = 0,
      updated_at = now()
  where plan_code = 'free';

-- 3. Renomeia planos antigos em subscriptions ativas (se houver)
--    starter -> solo, agency -> black. Pro permanece.
update subscriptions set plan_code = 'solo'  where plan_code = 'starter';
update subscriptions set plan_code = 'black' where plan_code = 'agency';

update organizations set plan_code = 'solo'  where plan_code = 'starter';
update organizations set plan_code = 'black' where plan_code = 'agency';

-- 4. Atualiza limites de quem tinha starter/agency para os novos limites
--    (Solo R$47 / 40 IA, Pro R$97 / 200 IA, BLACK R$247 / 1500 IA)
update organizations set ia_quota_limit = 40,   max_clients = 1,  max_collaborators = 0  where plan_code = 'solo';
update organizations set ia_quota_limit = 200,  max_clients = 5,  max_collaborators = 3  where plan_code = 'pro';
update organizations set ia_quota_limit = 1500, max_clients = 15, max_collaborators = 10 where plan_code = 'black';
