// Cliente minimo da API do Notion via fetch (sem SDK).
// Docs: https://developers.notion.com/reference
const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri() {
  return `${appUrl()}/api/integrations/notion/callback`;
}

// URL pra onde mandamos o owner autorizar.
function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.NOTION_CLIENT_ID || '',
    response_type: 'code',
    owner: 'user',
    redirect_uri: redirectUri(),
    state,
  });
  return `${API}/oauth/authorize?${params.toString()}`;
}

// Troca o code por token. Notion retorna access_token (nao expira),
// workspace_name e bot_id.
async function exchangeCode(code) {
  const basic = Buffer.from(
    `${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Notion OAuth falhou: ' + (data.error_description || data.error || res.status));
  }
  return data; // { access_token, workspace_name, workspace_id, bot_id, ... }
}

function headers(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// Lista databases que a integracao pode acessar (pro owner escolher destino).
async function listDatabases(accessToken) {
  const res = await fetch(`${API}/search`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({
      filter: { property: 'object', value: 'database' },
      page_size: 100,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Notion search falhou: ' + (data.message || res.status));
  }
  return (data.results || []).map((db) => ({
    id: db.id,
    title: (db.title || []).map((t) => t.plain_text).join('') || 'Sem titulo',
  }));
}

// Extrai o titulo de uma pagina do Notion (propriedade do tipo title).
function pageTitle(page) {
  const props = page.properties || {};
  for (const v of Object.values(props)) {
    if (v.type === 'title') {
      const t = (v.title || []).map((x) => x.plain_text).join('');
      if (t) return t;
    }
  }
  return 'Pagina sem titulo';
}

// Lista paginas que a integracao pode acessar (pra usar como "pai" de um database novo).
async function listPages(accessToken) {
  const res = await fetch(`${API}/search`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Notion search falhou: ' + (data.message || res.status));
  }
  return (data.results || []).map((p) => ({ id: p.id, title: pageTitle(p), url: p.url }));
}

// Cria um database de conteudo dentro de uma pagina, com as colunas que o
// SocialFlow usa (Nome, Data, Status, Cliente, Formato, Link). O Notion exige
// um "parent" (pagina) ja compartilhado com a integracao. Status nao pode ser
// criado por API, entao usamos um "select" chamado Status.
async function createContentDatabase(accessToken, parentPageId, title = 'Conteudo - SocialFlow') {
  const res = await fetch(`${API}/databases`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: parentPageId },
      title: richText(title),
      properties: {
        'Nome': { title: {} },
        'Data': { date: {} },
        'Status': { select: { options: [
          { name: 'Rascunho', color: 'gray' },
          { name: 'Aguardando', color: 'yellow' },
          { name: 'Aprovado', color: 'green' },
          { name: 'Publicado', color: 'blue' },
        ] } },
        'Cliente': { rich_text: {} },
        'Formato': { select: { options: [
          { name: 'Reel', color: 'purple' },
          { name: 'Carrossel', color: 'orange' },
          { name: 'Post', color: 'pink' },
          { name: 'Story', color: 'blue' },
        ] } },
        'Link': { url: {} },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Notion criar database falhou: ' + (data.message || res.status));
  }
  const t = (data.title || []).map((x) => x.plain_text).join('') || title;
  return { id: data.id, title: t, url: data.url };
}

// Descobre o nome da property do tipo "title" do database (varia por DB).
async function getTitleProp(accessToken, databaseId) {
  const res = await fetch(`${API}/databases/${databaseId}`, { headers: headers(accessToken) });
  const data = await res.json();
  if (!res.ok) throw new Error('Notion database falhou: ' + (data.message || res.status));
  const entry = Object.entries(data.properties || {}).find(([, v]) => v.type === 'title');
  return entry ? entry[0] : 'Name';
}

function richText(content) {
  return [{ type: 'text', text: { content: String(content || '').slice(0, 2000) } }];
}

function heading(content) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(content) } };
}

function paragraph(content) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(content) } };
}

// Cria uma pagina no database a partir de um roteiro (script).
// Retorna { id, url } da pagina criada.
async function createPageFromScript(accessToken, databaseId, script) {
  const titleProp = await getTitleProp(accessToken, databaseId);

  const children = [];
  if (script.hook) { children.push(heading('Hook'), paragraph(script.hook)); }
  if (script.body) { children.push(heading('Corpo'), paragraph(script.body)); }
  if (script.cta) { children.push(heading('CTA'), paragraph(script.cta)); }
  if (script.caption) { children.push(heading('Legenda'), paragraph(script.caption)); }
  const hashtags = Array.isArray(script.hashtags) ? script.hashtags : [];
  if (hashtags.length) { children.push(heading('Hashtags'), paragraph(hashtags.join(' '))); }

  const res = await fetch(`${API}/pages`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        [titleProp]: { title: richText(script.title || 'Roteiro') },
      },
      children: children.slice(0, 100),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Notion criar pagina falhou: ' + (data.message || res.status));
  }
  return { id: data.id, url: data.url };
}

// Extrai os campos uteis de uma pagina do Notion pra montar o calendario.
function parsePage(page) {
  const props = page.properties || {};
  let title = '';
  let date = null;
  let status = null;

  for (const value of Object.values(props)) {
    if (value.type === 'title' && !title) {
      title = (value.title || []).map((t) => t.plain_text).join('');
    } else if (value.type === 'date' && !date && value.date) {
      date = value.date.start;
    } else if ((value.type === 'status' || value.type === 'select') && !status) {
      const v = value.status || value.select;
      if (v) status = v.name;
    }
  }

  return {
    id: page.id,
    title: title || 'Sem titulo',
    date: date || null,
    status: status || null,
    url: page.url,
    created_time: page.created_time,
  };
}

// Consulta um database e retorna as paginas ja parseadas (titulo, data, status, url).
async function queryDatabase(accessToken, databaseId) {
  const res = await fetch(`${API}/databases/${databaseId}/query`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify({ page_size: 100 }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Notion query falhou: ' + (data.message || res.status));
  }
  return (data.results || []).map(parsePage);
}

module.exports = {
  authorizeUrl,
  exchangeCode,
  listDatabases,
  listPages,
  createContentDatabase,
  createPageFromScript,
  queryDatabase,
};
