-- Migration: pasta dedicada do Google Drive por cliente.
-- O app cria uma subpasta "SocialFlow/<nome do cliente>" e guarda o id aqui
-- (ver routes/clients.js POST /:id/drive/folder). Seguro rodar mais de uma vez.

alter table clients add column if not exists drive_folder_id text;
