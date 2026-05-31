// Camada de persistencia das integracoes externas por organizacao.
// Encripta/desencripta tokens (lib/crypto.js) e cuida do refresh do Google.
const { query } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const drive = require('./drive');

// Retorna a integracao desencriptada (tokens em texto plano em memoria) ou null.
async function getIntegration(orgId, provider) {
  const r = await query(
    `SELECT * FROM org_integrations WHERE organization_id = $1 AND provider = $2`,
    [orgId, provider]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...row,
    access_token: decrypt(row.access_token_enc),
    refresh_token: row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null,
  };
}

// Status seguro pra UI (sem tokens).
async function getIntegrationStatus(orgId, provider) {
  const r = await query(
    `SELECT provider, account_label, config, expires_at, updated_at
       FROM org_integrations WHERE organization_id = $1 AND provider = $2`,
    [orgId, provider]
  );
  const row = r.rows[0];
  if (!row) return { provider, connected: false };
  return {
    provider,
    connected: true,
    account_label: row.account_label,
    config: row.config || {},
    updated_at: row.updated_at,
  };
}

// Upsert da integracao. tokens = { access_token, refresh_token?, expires_at? }
async function saveIntegration(orgId, provider, { tokens, scope, label, config, userId }) {
  await query(
    `INSERT INTO org_integrations
       (organization_id, provider, access_token_enc, refresh_token_enc, expires_at, scope, account_label, config, connected_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (organization_id, provider) DO UPDATE SET
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, org_integrations.refresh_token_enc),
       expires_at = EXCLUDED.expires_at,
       scope = EXCLUDED.scope,
       account_label = COALESCE(EXCLUDED.account_label, org_integrations.account_label),
       config = COALESCE(EXCLUDED.config, org_integrations.config),
       connected_by_user_id = EXCLUDED.connected_by_user_id,
       updated_at = now()`,
    [
      orgId, provider,
      encrypt(tokens.access_token),
      tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokens.expires_at || null,
      scope || null,
      label || null,
      config ? JSON.stringify(config) : '{}',
      userId || null,
    ]
  );
}

// Atualiza so o config (destino escolhido: database Notion / pasta Drive).
async function updateConfig(orgId, provider, config) {
  const r = await query(
    `UPDATE org_integrations SET config = config || $3::jsonb, updated_at = now()
       WHERE organization_id = $1 AND provider = $2
     RETURNING config`,
    [orgId, provider, JSON.stringify(config)]
  );
  return r.rows[0]?.config || null;
}

async function deleteIntegration(orgId, provider) {
  await query(
    `DELETE FROM org_integrations WHERE organization_id = $1 AND provider = $2`,
    [orgId, provider]
  );
}

// Garante um access_token valido do Google: se faltar < 2min pra expirar,
// faz refresh e regrava. Notion nao expira, entao essa funcao e so pro Drive.
async function getFreshGoogleToken(orgId) {
  const integ = await getIntegration(orgId, 'google_drive');
  if (!integ) return null;

  const exp = integ.expires_at ? new Date(integ.expires_at).getTime() : 0;
  const needsRefresh = !exp || exp - Date.now() < 120 * 1000;

  if (needsRefresh && integ.refresh_token) {
    const refreshed = await drive.refreshToken(integ.refresh_token);
    const expires_at = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);
    await query(
      `UPDATE org_integrations SET access_token_enc = $2, expires_at = $3, updated_at = now()
         WHERE organization_id = $1 AND provider = 'google_drive'`,
      [orgId, encrypt(refreshed.access_token), expires_at]
    );
    return { ...integ, access_token: refreshed.access_token, expires_at };
  }
  return integ;
}

module.exports = {
  getIntegration,
  getIntegrationStatus,
  saveIntegration,
  updateConfig,
  deleteIntegration,
  getFreshGoogleToken,
};
