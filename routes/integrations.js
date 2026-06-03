const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const notion = require('../lib/notion');
const drive = require('../lib/drive');
const {
  getIntegrationStatus,
  getIntegration,
  saveIntegration,
  updateConfig,
  deleteIntegration,
} = require('../lib/integrations');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

const PROVIDERS = ['notion', 'google_drive'];

function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// Redireciona de volta pra configuracoes com um status na query.
function backToConfig(res, status) {
  res.redirect(`${appUrl()}/configuracoes?integration=${encodeURIComponent(status)}`);
}

// ===== Status das integracoes (pra tela de config) =====
router.get('/', async (req, res, next) => {
  try {
    const [notionStatus, driveStatus] = await Promise.all([
      getIntegrationStatus(req.orgId, 'notion'),
      getIntegrationStatus(req.orgId, 'google_drive'),
    ]);
    res.json({ integrations: { notion: notionStatus, google_drive: driveStatus } });
  } catch (err) { next(err); }
});

// ===== Inicia OAuth (so owner) =====
router.get('/:provider/connect', requireOrgRole('owner'), (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Provider invalido' });

    // state = nonce + orgId pra validar no callback (defesa contra CSRF).
    const nonce = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = { nonce, provider, orgId: req.orgId };
    const state = `${nonce}.${req.orgId}`;

    const url = provider === 'notion' ? notion.authorizeUrl(state) : drive.authorizeUrl(state);
    res.redirect(url);
  } catch (err) { next(err); }
});

// ===== Callback OAuth =====
router.get('/:provider/callback', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Provider invalido' });

    const { code, state, error } = req.query;
    if (error) return backToConfig(res, 'erro');
    if (!code) return backToConfig(res, 'erro');

    const saved = req.session.oauthState;
    if (!saved || `${saved.nonce}.${saved.orgId}` !== state || saved.provider !== provider) {
      return backToConfig(res, 'erro_state');
    }
    delete req.session.oauthState;

    if (provider === 'notion') {
      const token = await notion.exchangeCode(code);
      await saveIntegration(req.orgId, 'notion', {
        tokens: { access_token: token.access_token },
        scope: null,
        label: token.workspace_name || 'Notion',
        config: {},
        userId: req.session.userId,
      });
    } else {
      const token = await drive.exchangeCode(code);
      const email = await drive.getUserEmail(token.access_token);
      // Garante a pasta SocialFlow e ja guarda como destino default.
      let folder = null;
      try { folder = await drive.ensureFolder(token.access_token, 'SocialFlow'); } catch {}
      await saveIntegration(req.orgId, 'google_drive', {
        tokens: {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: new Date(Date.now() + (token.expires_in || 3600) * 1000),
        },
        scope: token.scope,
        label: email || 'Google Drive',
        config: folder ? { folder_id: folder.id, folder_name: folder.name } : {},
        userId: req.session.userId,
      });
    }

    backToConfig(res, 'conectado');
  } catch (err) {
    console.error('[integrations] callback erro:', err.message);
    backToConfig(res, 'erro');
  }
});

// ===== Notion: lista databases pro select de destino =====
router.get('/notion/databases', async (req, res, next) => {
  try {
    const integ = await getIntegration(req.orgId, 'notion');
    if (!integ) return res.status(404).json({ error: 'Notion nao conectado' });
    const databases = await notion.listDatabases(integ.access_token);
    res.json({ databases });
  } catch (err) { next(err); }
});

// ===== Notion: lista paginas (pra escolher onde criar o database) =====
router.get('/notion/pages', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const integ = await getIntegration(req.orgId, 'notion');
    if (!integ) return res.status(404).json({ error: 'Notion nao conectado' });
    const pages = await notion.listPages(integ.access_token);
    res.json({ pages });
  } catch (err) { next(err); }
});

// ===== Notion: cria o database de conteudo automaticamente numa pagina =====
router.post('/notion/database', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const data = z.object({
      parent_page_id: z.string().min(1),
      title: z.string().max(200).optional(),
    }).parse(req.body);
    const integ = await getIntegration(req.orgId, 'notion');
    if (!integ) return res.status(404).json({ error: 'Notion nao conectado' });
    const db = await notion.createContentDatabase(
      integ.access_token, data.parent_page_id, data.title || 'Conteudo - SocialFlow'
    );
    // Ja seleciona o database recem-criado como destino.
    const config = await updateConfig(req.orgId, 'notion', {
      database_id: db.id, database_title: db.title,
    });
    res.status(201).json({ database: db, config });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// ===== Notion: calendario (itens do database escolhido) =====
// Restrito a owner/collaborator: o calendario editorial da agencia pode conter
// conteudo de varios clientes, entao nao expomos pro role 'client'.
router.get('/notion/calendar', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const integ = await getIntegration(req.orgId, 'notion');
    if (!integ) return res.status(409).json({ error: 'Notion nao conectado' });
    const databaseId = integ.config?.database_id;
    if (!databaseId) return res.status(409).json({ error: 'Nenhum database do Notion selecionado' });

    const items = await notion.queryDatabase(integ.access_token, databaseId);
    res.json({
      items,
      database_title: integ.config?.database_title || 'Notion',
    });
  } catch (err) { next(err); }
});

// ===== Grava destino escolhido (database Notion / pasta Drive) =====
const configSchema = z.object({
  database_id: z.string().optional(),
  database_title: z.string().optional(),
  folder_id: z.string().optional(),
  folder_name: z.string().optional(),
});

router.put('/:provider/config', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Provider invalido' });
    const data = configSchema.parse(req.body);
    const integ = await getIntegration(req.orgId, provider);
    if (!integ) return res.status(404).json({ error: 'Integracao nao conectada' });
    const config = await updateConfig(req.orgId, provider, data);
    res.json({ ok: true, config });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// ===== Desconecta =====
router.delete('/:provider', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: 'Provider invalido' });
    await deleteIntegration(req.orgId, provider);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
