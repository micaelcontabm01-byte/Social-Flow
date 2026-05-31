// Cliente minimo do Google Drive via fetch (sem SDK googleapis).
// Escopo: drive.file (so arquivos criados pelo app -> dispensa auditoria pesada).
// Docs: https://developers.google.com/drive/api/guides/about-sdk
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri() {
  return `${appUrl()}/api/integrations/google_drive/callback`;
}

function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',     // pra receber refresh_token
    prompt: 'consent',          // garante refresh_token mesmo em re-conexao
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH}?${params.toString()}`;
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Google OAuth falhou: ' + (data.error_description || data.error || res.status));
  }
  return data; // { access_token, refresh_token, expires_in, scope, ... }
}

async function refreshToken(refresh) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Google refresh falhou: ' + (data.error_description || data.error || res.status));
  }
  return data; // { access_token, expires_in, ... } (refresh_token nao volta)
}

// Email da conta conectada (pra exibir na UI).
async function getUserEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return res.ok ? data.email || null : null;
  } catch {
    return null;
  }
}

// Acha (ou cria) uma pasta pelo nome. Se parentId for passado, busca/cria
// dentro dessa pasta-pai (subpasta). Retorna { id, name, webViewLink }.
async function ensureFolder(accessToken, name, parentId) {
  let q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const findRes = await fetch(
    `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&spaces=drive`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const found = await findRes.json();
  if (findRes.ok && found.files && found.files.length > 0) {
    const f = found.files[0];
    return { id: f.id, name: f.name, webViewLink: f.webViewLink };
  }

  const metadata = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const createRes = await fetch(`${API}/files?fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    throw new Error('Google criar pasta falhou: ' + (created.error?.message || createRes.status));
  }
  return { id: created.id, name: created.name, webViewLink: created.webViewLink };
}

// Upload de um PDF (multipart). Retorna { id, webViewLink }.
async function uploadPdf(accessToken, folderId, filename, buffer) {
  const boundary = 'sf' + Math.random().toString(36).slice(2);
  const metadata = { name: filename, mimeType: 'application/pdf' };
  if (folderId) metadata.parents = [folderId];

  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/pdf\r\n\r\n';
  const tail = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(head, 'utf8'),
    buffer,
    Buffer.from(tail, 'utf8'),
  ]);

  const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Google upload falhou: ' + (data.error?.message || res.status));
  }
  return { id: data.id, webViewLink: data.webViewLink };
}

module.exports = {
  SCOPE,
  authorizeUrl,
  exchangeCode,
  refreshToken,
  getUserEmail,
  ensureFolder,
  uploadPdf,
};
