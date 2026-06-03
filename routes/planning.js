const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { generate, MODEL } = require('../lib/ai');
const { planningPrompt, parseJsonFromText } = require('../lib/prompts');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { requireAuth } = require('../middleware/auth');
const { requireQuota, refundQuota, logUsage } = require('../middleware/quota');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

const generateSchema = z.object({
  client_id: z.string().uuid(),
  persona_id: z.string().uuid().optional().nullable(),
  goal: z.string().max(500).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const planSchema = z.object({
  client_id: z.string().uuid(),
  persona_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).optional().nullable(),
  pillars: z.array(z.any()).optional().default([]),
  cadence: z.string().max(500).optional().nullable(),
  objectives: z.array(z.string()).optional().default([]),
  format_mix: z.record(z.any()).optional().default({}),
});

async function getClientInOrg(clientId, orgId) {
  const r = await query(
    `SELECT id, name, niche, instagram_handle FROM clients WHERE id = $1 AND organization_id = $2`,
    [clientId, orgId]
  );
  return r.rows[0] || null;
}

async function getPersonaInOrg(personaId, orgId) {
  if (!personaId) return null;
  const r = await query(`SELECT * FROM personas WHERE id = $1 AND organization_id = $2`, [personaId, orgId]);
  return r.rows[0] || null;
}

// Gera um planejamento com IA (nao salva; o front salva via POST /).
router.post('/generate',
  requireOrgRole('owner', 'collaborator'),
  async (req, res, next) => {
    try {
      const data = generateSchema.parse(req.body);
      const client = await getClientInOrg(data.client_id, req.orgId);
      if (!client) return res.status(404).json({ error: 'Cliente nao encontrado' });
      req.parsed = data;
      req.client = client;
      next();
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
      next(err);
    }
  },
  requireQuota('planning_generate'),
  async (req, res, next) => {
    try {
      const data = req.parsed;
      const persona = await getPersonaInOrg(data.persona_id, req.orgId);
      const { system, user } = planningPrompt({
        client: req.client, persona, goal: data.goal, notes: data.notes,
      });
      const ai = await generate({ system, prompt: user, maxTokens: 2500, temperature: 0.7 });
      let parsed;
      try {
        parsed = parseJsonFromText(ai.text);
      } catch (e) {
        await refundQuota(req.orgId);
        return res.status(502).json({ error: 'IA retornou JSON invalido', raw: ai.text });
      }
      await logUsage({ organizationId: req.orgId, userId: req.session.userId, kind: 'planning_generate', usage: ai.usage, model: MODEL });
      res.json({ plan: parsed, quota: req.quota, raw_input: { goal: data.goal, notes: data.notes } });
    } catch (err) {
      try { await refundQuota(req.orgId); } catch {}
      next(err);
    }
  }
);

router.post('/', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = planSchema.parse(req.body);
    const client = await getClientInOrg(data.client_id, req.orgId);
    if (!client) return res.status(404).json({ error: 'Cliente nao encontrado' });
    if (data.persona_id) {
      const persona = await getPersonaInOrg(data.persona_id, req.orgId);
      if (!persona) return res.status(400).json({ error: 'Persona invalida' });
    }
    const r = await query(
      `INSERT INTO content_plans (
         organization_id, client_id, persona_id, title, summary, pillars, cadence,
         objectives, format_mix, raw_input, generated_by_ai, created_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.orgId, data.client_id, data.persona_id || null, data.title, data.summary || null,
        JSON.stringify(data.pillars || []), data.cadence || null,
        JSON.stringify(data.objectives || []), JSON.stringify(data.format_mix || {}),
        req.body.raw_input ? JSON.stringify(req.body.raw_input) : null,
        Boolean(req.body.generated_by_ai), req.session.userId,
      ]
    );
    res.status(201).json({ plan: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const filters = ['p.organization_id = $1'];
    const values = [req.orgId];
    let i = 2;
    if (req.role === 'client') return res.json({ plans: [] }); // interno da agencia
    if (req.query.client_id) { filters.push(`p.client_id = $${i++}`); values.push(req.query.client_id); }
    const r = await query(
      `SELECT p.*, c.name AS client_name
         FROM content_plans p
         JOIN clients c ON c.id = p.client_id
        WHERE ${filters.join(' AND ')}
        ORDER BY p.created_at DESC LIMIT 100`,
      values
    );
    res.json({ plans: r.rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (req.role === 'client') return res.status(403).json({ error: 'Sem acesso' });
    const r = await query(
      `SELECT p.*, c.name AS client_name FROM content_plans p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Planejamento nao encontrado' });
    res.json({ plan: r.rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = planSchema.partial().parse(req.body);
    const allowed = ['title', 'summary', 'pillars', 'cadence', 'objectives', 'format_mix', 'persona_id'];
    const jsonFields = new Set(['pillars', 'objectives', 'format_mix']);
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of allowed) {
      if (data[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        values.push(jsonFields.has(k) ? JSON.stringify(data[k]) : (data[k] || null));
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.orgId);
    const r = await query(
      `UPDATE content_plans SET ${fields.join(', ')}
        WHERE id = $${i++} AND organization_id = $${i} RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Planejamento nao encontrado' });
    res.json({ plan: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM content_plans WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Planejamento nao encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
