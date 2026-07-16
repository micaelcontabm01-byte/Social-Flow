const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { generate, MODEL } = require('../lib/ai');
const { personaPrompt, parseJsonFromText } = require('../lib/prompts');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { requireQuota, refundQuota, logUsage } = require('../middleware/quota');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

const generateSchema = z.object({
  client_id: z.string().uuid(),
  niche: z.string().max(300).optional().nullable(),
  target: z.string().max(500).optional().nullable(),
  goal: z.string().max(500).optional().nullable(),
  tone: z.string().max(200).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const personaSchema = z.object({
  client_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  age_range: z.string().max(50).optional().nullable(),
  gender: z.string().max(50).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  profession: z.string().max(200).optional().nullable(),
  income_range: z.string().max(100).optional().nullable(),
  pain_points: z.array(z.string()).optional().default([]),
  desires: z.array(z.string()).optional().default([]),
  objections: z.array(z.string()).optional().default([]),
  language_tone: z.string().max(300).optional().nullable(),
  channels: z.array(z.string()).optional().default([]),
});

async function assertClientInOrg(clientId, orgId) {
  const r = await query(
    `SELECT id, name FROM clients WHERE id = $1 AND organization_id = $2`,
    [clientId, orgId]
  );
  if (r.rowCount === 0) {
    const e = new Error('Cliente nao encontrado');
    e.status = 404;
    throw e;
  }
  return r.rows[0];
}

router.post('/generate',
  requireOrgRole('owner', 'collaborator'),
  async (req, res, next) => {
    try {
      const data = generateSchema.parse(req.body);
      await assertClientInOrg(data.client_id, req.orgId);
      return next();
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
  requireQuota('persona_generate'),
  async (req, res, next) => {
    try {
      const data = generateSchema.parse(req.body);
      const client = await assertClientInOrg(data.client_id, req.orgId);

      const { system, user } = personaPrompt({
        clientName: client.name,
        niche: data.niche,
        target: data.target,
        goal: data.goal,
        tone: data.tone,
        notes: data.notes,
      });

      const ai = await generate({ system, prompt: user, maxTokens: 1500 });
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
        kind: 'persona_generate',
        usage: ai.usage,
        model: MODEL,
      });

      res.json({
        persona: parsed,
        quota: req.quota,
        raw_input: {
          niche: data.niche, target: data.target, goal: data.goal, tone: data.tone, notes: data.notes,
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
    const data = personaSchema.parse(req.body);
    await assertClientInOrg(data.client_id, req.orgId);
    const r = await query(
      `INSERT INTO personas (
         client_id, organization_id, name, age_range, gender, location, profession, income_range,
         pain_points, desires, objections, language_tone, channels, raw_input, generated_by_ai, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        data.client_id, req.orgId, data.name,
        data.age_range || null, data.gender || null, data.location || null,
        data.profession || null, data.income_range || null,
        JSON.stringify(data.pain_points || []),
        JSON.stringify(data.desires || []),
        JSON.stringify(data.objections || []),
        data.language_tone || null,
        JSON.stringify(data.channels || []),
        req.body.raw_input ? JSON.stringify(req.body.raw_input) : null,
        Boolean(req.body.generated_by_ai),
        req.session.userId,
      ]
    );
    res.status(201).json({ persona: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const filters = ['p.organization_id = $1'];
    const values = [req.orgId];
    if (req.role === 'client') {
      if (!req.memberClientId) return res.json({ personas: [] });
      filters.push(`p.client_id = $${values.length + 1}`);
      values.push(req.memberClientId);
    }
    const r = await query(
      `SELECT p.*, c.name as client_name
       FROM personas p
       JOIN clients c ON c.id = p.client_id
       WHERE ${filters.join(' AND ')}
       ORDER BY p.created_at DESC`,
      values
    );
    res.json({ personas: r.rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT p.*, c.name as client_name
       FROM personas p
       JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1 AND p.organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Persona nao encontrada' });
    if (req.role === 'client' && r.rows[0].client_id !== req.memberClientId) {
      return res.status(403).json({ error: 'Sem acesso' });
    }
    res.json({ persona: r.rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = personaSchema.partial().parse(req.body);
    const allowed = ['name', 'age_range', 'gender', 'location', 'profession', 'income_range',
                     'pain_points', 'desires', 'objections', 'language_tone', 'channels'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of allowed) {
      if (data[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        if (Array.isArray(data[k])) values.push(JSON.stringify(data[k]));
        else values.push(data[k] || null);
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.orgId);
    const r = await query(
      `UPDATE personas SET ${fields.join(', ')}
       WHERE id = $${i++} AND organization_id = $${i}
       RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Persona nao encontrada' });
    res.json({ persona: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM personas WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Persona nao encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
