const express = require('express');
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { generate, MODEL } = require('../lib/ai');
const { scriptPrompt, parseJsonFromText } = require('../lib/prompts');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { requireQuota, refundQuota, logUsage } = require('../middleware/quota');
const { templates } = require('../lib/email');
const { notifyClientUsers, notifyOwnersAndCollabs, fullLink } = require('../lib/notifications');
const notion = require('../lib/notion');
const drive = require('../lib/drive');
const { getIntegration, getFreshGoogleToken } = require('../lib/integrations');
const { scriptPdf, safeFilename } = require('../lib/export-pdf');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

const FUNNEL = ['topo', 'meio', 'fundo'];
const FORMATS = ['reel', 'carrossel', 'post', 'story'];

const generateSchema = z.object({
  client_id: z.string().uuid(),
  persona_id: z.string().uuid().optional().nullable(),
  funnel_stage: z.enum(FUNNEL),
  format: z.enum(FORMATS),
  theme: z.string().max(500).optional().nullable(),
  goal: z.string().max(500).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const scriptSchema = z.object({
  client_id: z.string().uuid(),
  persona_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(200),
  funnel_stage: z.enum(FUNNEL),
  format: z.enum(FORMATS),
  goal: z.string().max(500).optional().nullable(),
  theme: z.string().max(500).optional().nullable(),
  hook: z.string().max(1000).optional().nullable(),
  body: z.string().max(8000).optional().nullable(),
  cta: z.string().max(500).optional().nullable(),
  caption: z.string().max(4000).optional().nullable(),
  hashtags: z.array(z.string()).optional().default([]),
  status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'published']).optional(),
});

async function assertClientInOrg(clientId, orgId) {
  const r = await query(`SELECT id FROM clients WHERE id = $1 AND organization_id = $2`, [clientId, orgId]);
  if (r.rowCount === 0) {
    const e = new Error('Cliente nao encontrado');
    e.status = 404;
    throw e;
  }
}

async function getPersonaInOrg(personaId, orgId) {
  if (!personaId) return null;
  const r = await query(
    `SELECT * FROM personas WHERE id = $1 AND organization_id = $2`,
    [personaId, orgId]
  );
  return r.rows[0] || null;
}

router.post('/generate',
  requireOrgRole('owner', 'collaborator'),
  async (req, res, next) => {
    try {
      const data = generateSchema.parse(req.body);
      await assertClientInOrg(data.client_id, req.orgId);
      req.parsed = data;
      next();
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
  requireQuota('script_generate'),
  async (req, res, next) => {
    try {
      const data = req.parsed;
      const persona = await getPersonaInOrg(data.persona_id, req.orgId);
      const { system, user } = scriptPrompt({
        persona,
        funnelStage: data.funnel_stage,
        format: data.format,
        theme: data.theme,
        goal: data.goal,
        notes: data.notes,
      });

      // Reel gera roteiro cena por cena (body bem mais longo), entao precisa de mais espaco
      const maxTokens = data.format === 'reel' ? 4000 : 2500;
      const ai = await generate({ system, prompt: user, maxTokens, temperature: 0.75 });
      let parsed;
      try {
        parsed = parseJsonFromText(ai.text);
      } catch (e) {
        await refundQuota(req.orgId);
        return res.status(502).json({ error: 'IA retornou JSON invalido', raw: ai.text });
      }

      await logUsage({
        organizationId: req.orgId,
        userId: req.session.userId,
        kind: 'script_generate',
        usage: ai.usage,
        model: MODEL,
      });

      res.json({
        script: parsed,
        quota: req.quota,
        raw_input: {
          funnel_stage: data.funnel_stage,
          format: data.format,
          theme: data.theme,
          goal: data.goal,
          notes: data.notes,
        },
      });
    } catch (err) {
      try { await refundQuota(req.orgId); } catch {}
      next(err);
    }
  }
);

router.post('/', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = scriptSchema.parse(req.body);
    await assertClientInOrg(data.client_id, req.orgId);
    if (data.persona_id) {
      const persona = await getPersonaInOrg(data.persona_id, req.orgId);
      if (!persona) return res.status(400).json({ error: 'Persona invalida' });
    }
    const r = await query(
      `INSERT INTO scripts (
         organization_id, client_id, persona_id, title, funnel_stage, format, goal, theme,
         hook, body, cta, caption, hashtags, status, raw_input, generated_by_ai, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        req.orgId, data.client_id, data.persona_id || null, data.title,
        data.funnel_stage, data.format,
        data.goal || null, data.theme || null,
        data.hook || null, data.body || null, data.cta || null, data.caption || null,
        JSON.stringify(data.hashtags || []),
        data.status || 'draft',
        req.body.raw_input ? JSON.stringify(req.body.raw_input) : null,
        Boolean(req.body.generated_by_ai),
        req.session.userId,
      ]
    );
    res.status(201).json({ script: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const filters = ['s.organization_id = $1'];
    const values = [req.orgId];
    let i = 2;
    if (req.role === 'client') {
      if (!req.memberClientId) return res.json({ scripts: [] });
      filters.push(`s.client_id = $${i++}`);
      values.push(req.memberClientId);
      filters.push(`s.status != 'draft'`);
    } else if (req.query.client_id) {
      filters.push(`s.client_id = $${i++}`); values.push(req.query.client_id);
    }
    if (req.query.status) { filters.push(`s.status = $${i++}`); values.push(req.query.status); }
    if (req.query.funnel_stage) { filters.push(`s.funnel_stage = $${i++}`); values.push(req.query.funnel_stage); }
    const r = await query(
      `SELECT s.id, s.title, s.funnel_stage, s.format, s.status, s.created_at, s.scheduled_for,
              s.generated_by_ai, s.client_id, s.persona_id,
              c.name as client_name, p.name as persona_name
       FROM scripts s
       JOIN clients c ON c.id = s.client_id
       LEFT JOIN personas p ON p.id = s.persona_id
       WHERE ${filters.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT 200`,
      values
    );
    res.json({ scripts: r.rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT s.*, c.name as client_name, p.name as persona_name
       FROM scripts s
       JOIN clients c ON c.id = s.client_id
       LEFT JOIN personas p ON p.id = s.persona_id
       WHERE s.id = $1 AND s.organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Roteiro nao encontrado' });
    if (req.role === 'client') {
      if (r.rows[0].client_id !== req.memberClientId) return res.status(403).json({ error: 'Sem acesso' });
      if (r.rows[0].status === 'draft') return res.status(403).json({ error: 'Sem acesso a rascunhos' });
    }
    res.json({ script: r.rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = scriptSchema.partial().parse(req.body);
    const allowed = ['title','funnel_stage','format','goal','theme','hook','body','cta','caption','hashtags','status','persona_id'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of allowed) {
      if (data[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        if (k === 'hashtags') values.push(JSON.stringify(data[k]));
        else values.push(data[k] || null);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.orgId);
    const r = await query(
      `UPDATE scripts SET ${fields.join(', ')}
       WHERE id = $${i++} AND organization_id = $${i}
       RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Roteiro nao encontrado' });
    res.json({ script: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

async function getScriptOr404(id, orgId) {
  const r = await query(
    `SELECT s.*, c.name as client_name
     FROM scripts s
     JOIN clients c ON c.id = s.client_id
     WHERE s.id = $1 AND s.organization_id = $2`,
    [id, orgId]
  );
  if (r.rowCount === 0) {
    const e = new Error('Roteiro nao encontrado');
    e.status = 404;
    throw e;
  }
  return r.rows[0];
}

async function recordEvent(scriptId, orgId, userId, role, kind, content) {
  await query(
    `INSERT INTO script_comments (script_id, organization_id, user_id, user_role, kind, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [scriptId, orgId, userId, role, kind, content || '']
  );
}

router.post('/:id/submit', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const script = await getScriptOr404(req.params.id, req.orgId);
    if (!['draft', 'rejected'].includes(script.status)) {
      return res.status(400).json({ error: `Nao pode enviar pra aprovacao no status atual (${script.status})` });
    }
    await tx(async (c) => {
      await c.query(
        `UPDATE scripts SET status = 'pending_approval', updated_at = now() WHERE id = $1`,
        [script.id]
      );
    });
    await recordEvent(script.id, req.orgId, req.session.userId, req.role, 'submission', 'Enviado para aprovacao');

    const link = fullLink(`/roteiro?id=${script.id}`);
    const sent = await notifyClientUsers(req.orgId, script.client_id, {
      kind: 'script_pending_approval',
      title: `${script.client_name}: novo conteudo aguardando aprovacao`,
      body: script.title,
      link: `/roteiro?id=${script.id}`,
      metadata: { script_id: script.id, client_id: script.client_id },
    }, templates.scriptSubmittedForApproval({
      scriptTitle: script.title, clientName: script.client_name, link,
    }));

    res.json({ ok: true, notified_clients: sent });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/approve', requireOrgRole('owner', 'client'), async (req, res, next) => {
  try {
    const script = await getScriptOr404(req.params.id, req.orgId);
    if (script.status !== 'pending_approval') {
      return res.status(400).json({ error: `Nao pode aprovar no status atual (${script.status})` });
    }
    await query(
      `UPDATE scripts SET status = 'approved', approved_at = now(), approved_by_user_id = $1, updated_at = now()
       WHERE id = $2`,
      [req.session.userId, script.id]
    );
    await recordEvent(script.id, req.orgId, req.session.userId, req.role, 'approval', req.body.comment || 'Aprovado');

    const userR = await query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    const approverName = userR.rows[0]?.name || 'Cliente';
    const link = fullLink(`/roteiro?id=${script.id}`);
    await notifyOwnersAndCollabs(req.orgId, {
      kind: 'script_approved',
      title: `${approverName} aprovou: ${script.title}`,
      link: `/roteiro?id=${script.id}`,
      metadata: { script_id: script.id },
    }, templates.scriptApproved({ scriptTitle: script.title, approverName, link }));
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/reject', requireOrgRole('owner', 'client'), async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason || reason.length < 3) {
      return res.status(400).json({ error: 'Informe o motivo da rejeicao (minimo 3 caracteres)' });
    }
    const script = await getScriptOr404(req.params.id, req.orgId);
    if (script.status !== 'pending_approval') {
      return res.status(400).json({ error: `Nao pode rejeitar no status atual (${script.status})` });
    }
    await query(
      `UPDATE scripts SET status = 'rejected', rejection_reason = $1, updated_at = now()
       WHERE id = $2`,
      [reason, script.id]
    );
    await recordEvent(script.id, req.orgId, req.session.userId, req.role, 'rejection', reason);

    const userR = await query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    const reviewerName = userR.rows[0]?.name || 'Cliente';
    const link = fullLink(`/roteiro?id=${script.id}`);
    await notifyOwnersAndCollabs(req.orgId, {
      kind: 'script_rejected',
      title: `${reviewerName} pediu alteracoes: ${script.title}`,
      body: reason,
      link: `/roteiro?id=${script.id}`,
      metadata: { script_id: script.id, reason },
    }, templates.scriptRejected({ scriptTitle: script.title, reviewerName, reason, link }));
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/:id/comments', async (req, res, next) => {
  try {
    await getScriptOr404(req.params.id, req.orgId);
    const r = await query(
      `SELECT sc.id, sc.content, sc.kind, sc.user_role, sc.created_at, u.name as user_name
       FROM script_comments sc
       LEFT JOIN users u ON u.id = sc.user_id
       WHERE sc.script_id = $1
       ORDER BY sc.created_at ASC`,
      [req.params.id]
    );
    res.json({ comments: r.rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/comments', async (req, res, next) => {
  try {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Comentario vazio' });
    const script = await getScriptOr404(req.params.id, req.orgId);
    await recordEvent(script.id, req.orgId, req.session.userId, req.role, 'comment', content);

    const userR = await query('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    const commenterName = userR.rows[0]?.name || 'Membro';
    const link = fullLink(`/roteiro?id=${script.id}`);
    if (req.role === 'client') {
      await notifyOwnersAndCollabs(req.orgId, {
        kind: 'script_commented',
        title: `${commenterName} comentou em: ${script.title}`,
        body: content,
        link: `/roteiro?id=${script.id}`,
        metadata: { script_id: script.id },
      }, templates.scriptCommented({ scriptTitle: script.title, commenterName, comment: content, link }));
    } else {
      await notifyClientUsers(req.orgId, script.client_id, {
        kind: 'script_commented',
        title: `${commenterName} comentou em: ${script.title}`,
        body: content,
        link: `/roteiro?id=${script.id}`,
        metadata: { script_id: script.id },
      }, templates.scriptCommented({ scriptTitle: script.title, commenterName, comment: content, link }));
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM scripts WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Roteiro nao encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ===== Export para Notion =====
router.post('/:id/export/notion', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const script = await getScriptOr404(req.params.id, req.orgId);
    const integ = await getIntegration(req.orgId, 'notion');
    if (!integ) return res.status(409).json({ error: 'Conecte sua conta do Notion em Configuracoes primeiro.' });
    const databaseId = integ.config?.database_id;
    if (!databaseId) return res.status(409).json({ error: 'Escolha um database do Notion em Configuracoes.' });

    const page = await notion.createPageFromScript(integ.access_token, databaseId, script);
    res.json({ ok: true, url: page.url });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ===== Export para Google Drive (PDF) =====
router.post('/:id/export/drive', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const script = await getScriptOr404(req.params.id, req.orgId);
    const integ = await getFreshGoogleToken(req.orgId);
    if (!integ) return res.status(409).json({ error: 'Conecte sua conta do Google Drive em Configuracoes primeiro.' });

    const pdf = await scriptPdf(script);
    // Prefere a pasta do proprio cliente; senao a pasta SocialFlow da org.
    const cf = await query('SELECT drive_folder_id FROM clients WHERE id = $1', [script.client_id]);
    const folderId = cf.rows[0]?.drive_folder_id || integ.config?.folder_id || null;
    const file = await drive.uploadPdf(integ.access_token, folderId, safeFilename('roteiro-' + script.title), pdf);
    res.json({ ok: true, url: file.webViewLink });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
