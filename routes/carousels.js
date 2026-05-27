const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { generate, MODEL } = require('../lib/ai');
const { carouselPrompt, parseJsonFromText } = require('../lib/prompts');
const { getTemplate, listTemplates, emptySlides } = require('../lib/templates');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { requireQuota, refundQuota, logUsage } = require('../middleware/quota');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

router.get('/templates', (req, res) => {
  res.json({ templates: listTemplates() });
});

router.get('/templates/:id', (req, res) => {
  const t = getTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template nao encontrado' });
  res.json({ template: t });
});

const generateSchema = z.object({
  client_id: z.string().uuid(),
  persona_id: z.string().uuid().optional().nullable(),
  script_id: z.string().uuid().optional().nullable(),
  template_id: z.string().min(1),
  theme: z.string().max(500).optional().nullable(),
  goal: z.string().max(500).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const carouselSchema = z.object({
  client_id: z.string().uuid(),
  persona_id: z.string().uuid().optional().nullable(),
  script_id: z.string().uuid().optional().nullable(),
  template_id: z.string().min(1),
  title: z.string().min(1).max(200),
  slides: z.record(z.string()),
  status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'published']).optional(),
});

async function assertClientInOrg(clientId, orgId) {
  const r = await query(`SELECT id, name FROM clients WHERE id = $1 AND organization_id = $2`, [clientId, orgId]);
  if (r.rowCount === 0) { const e = new Error('Cliente nao encontrado'); e.status = 404; throw e; }
  return r.rows[0];
}

router.post('/generate',
  requireOrgRole('owner', 'collaborator'),
  async (req, res, next) => {
    try {
      const data = generateSchema.parse(req.body);
      const template = getTemplate(data.template_id);
      if (!template) return res.status(400).json({ error: 'Template invalido' });
      await assertClientInOrg(data.client_id, req.orgId);
      req.parsed = { data, template };
      next();
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
  requireQuota('carousel_generate'),
  async (req, res, next) => {
    try {
      const { data, template } = req.parsed;

      let persona = null;
      if (data.persona_id) {
        const r = await query(`SELECT * FROM personas WHERE id = $1 AND organization_id = $2`, [data.persona_id, req.orgId]);
        persona = r.rows[0] || null;
      }
      let scriptContent = null;
      if (data.script_id) {
        const r = await query(
          `SELECT hook, body, cta, caption FROM scripts WHERE id = $1 AND organization_id = $2`,
          [data.script_id, req.orgId]
        );
        if (r.rows[0]) {
          scriptContent = ['Hook: ' + r.rows[0].hook, 'Corpo: ' + r.rows[0].body, 'CTA: ' + r.rows[0].cta].filter(Boolean).join('\n');
        }
      }

      const { system, user } = carouselPrompt({
        persona, template, theme: data.theme, scriptContent,
        goal: data.goal, notes: data.notes,
      });
      const ai = await generate({ system, prompt: user, maxTokens: 2000, temperature: 0.75 });

      let parsed;
      try { parsed = parseJsonFromText(ai.text); }
      catch (e) {
        await refundQuota(req.orgId);
        return res.status(502).json({ error: 'IA retornou JSON invalido', raw: ai.text });
      }

      const slides = emptySlides(template);
      for (const f of template.fields) {
        if (parsed[f.key]) slides[f.key] = String(parsed[f.key]).slice(0, f.max);
      }

      await logUsage({
        organizationId: req.orgId, userId: req.session.userId,
        kind: 'carousel_generate', usage: ai.usage, model: MODEL,
      });

      res.json({
        carousel: { template_id: template.id, slides },
        quota: req.quota,
        raw_input: {
          theme: data.theme, goal: data.goal, notes: data.notes,
          persona_id: data.persona_id, script_id: data.script_id,
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
    const data = carouselSchema.parse(req.body);
    const template = getTemplate(data.template_id);
    if (!template) return res.status(400).json({ error: 'Template invalido' });
    await assertClientInOrg(data.client_id, req.orgId);

    const r = await query(
      `INSERT INTO carousels (
         organization_id, client_id, persona_id, script_id, template_id, title, slides,
         status, raw_input, generated_by_ai, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        req.orgId, data.client_id, data.persona_id || null, data.script_id || null,
        data.template_id, data.title,
        JSON.stringify(data.slides),
        data.status || 'draft',
        req.body.raw_input ? JSON.stringify(req.body.raw_input) : null,
        Boolean(req.body.generated_by_ai),
        req.session.userId,
      ]
    );
    res.status(201).json({ carousel: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const filters = ['c.organization_id = $1'];
    const values = [req.orgId];
    let i = 2;
    if (req.role === 'client') {
      if (!req.memberClientId) return res.json({ carousels: [] });
      filters.push(`c.client_id = $${i++}`); values.push(req.memberClientId);
      filters.push(`c.status != 'draft'`);
    } else if (req.query.client_id) {
      filters.push(`c.client_id = $${i++}`); values.push(req.query.client_id);
    }
    if (req.query.status) { filters.push(`c.status = $${i++}`); values.push(req.query.status); }
    const r = await query(
      `SELECT c.id, c.title, c.template_id, c.status, c.created_at, c.generated_by_ai,
              c.client_id, cli.name as client_name
       FROM carousels c
       JOIN clients cli ON cli.id = c.client_id
       WHERE ${filters.join(' AND ')}
       ORDER BY c.created_at DESC
       LIMIT 200`,
      values
    );
    res.json({ carousels: r.rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT c.*, cli.name as client_name
       FROM carousels c
       JOIN clients cli ON cli.id = c.client_id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Carrossel nao encontrado' });
    if (req.role === 'client') {
      if (r.rows[0].client_id !== req.memberClientId) return res.status(403).json({ error: 'Sem acesso' });
      if (r.rows[0].status === 'draft') return res.status(403).json({ error: 'Sem acesso a rascunhos' });
    }
    res.json({ carousel: r.rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = carouselSchema.partial().parse(req.body);
    const allowed = ['title', 'slides', 'status', 'persona_id', 'script_id'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of allowed) {
      if (data[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        if (k === 'slides') values.push(JSON.stringify(data[k]));
        else values.push(data[k] || null);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.orgId);
    const r = await query(
      `UPDATE carousels SET ${fields.join(', ')}
       WHERE id = $${i++} AND organization_id = $${i}
       RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Carrossel nao encontrado' });
    res.json({ carousel: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM carousels WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Carrossel nao encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
