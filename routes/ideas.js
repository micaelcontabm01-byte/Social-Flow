const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { generate, MODEL } = require('../lib/ai');
const { ideasPrompt, parseJsonFromText } = require('../lib/prompts');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { requireAuth } = require('../middleware/auth');
const { requireQuota, refundQuota, logUsage } = require('../middleware/quota');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

const FORMATS = ['reel', 'carrossel', 'post', 'story'];
const FUNNEL = ['topo', 'meio', 'fundo'];

// A IA costuma devolver variacoes ('Reel', 'Stories', 'Post estatico', 'TOPO').
// Normaliza pra o valor canonico ou null (nunca derruba o lote por causa disso).
function normalizeFormat(v) {
  const m = String(v || '').toLowerCase().trim();
  const map = { reels: 'reel', reel: 'reel', carousel: 'carrossel', carrossel: 'carrossel', post: 'post', 'post estatico': 'post', 'post estático': 'post', story: 'story', stories: 'story' };
  return map[m] || (FORMATS.includes(m) ? m : null);
}
function normalizeFunnel(v) {
  const m = String(v || '').toLowerCase().trim();
  return FUNNEL.includes(m) ? m : null;
}

const generateSchema = z.object({
  client_id: z.string().uuid(),
  plan_id: z.string().uuid().optional().nullable(),
  persona_id: z.string().uuid().optional().nullable(),
  count: z.number().int().min(1).max(20).optional().default(10),
});

const ideaSchema = z.object({
  client_id: z.string().uuid(),
  plan_id: z.string().uuid().optional().nullable(),
  persona_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional().nullable(),
  format: z.enum(FORMATS).optional().nullable(),
  funnel_stage: z.enum(FUNNEL).optional().nullable(),
  pillar: z.string().max(200).optional().nullable(),
  status: z.enum(['idea', 'in_production', 'done']).optional(),
  scheduled_for: z.string().datetime().optional().nullable(),
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

async function getPlanInOrg(planId, orgId) {
  if (!planId) return null;
  const r = await query(`SELECT * FROM content_plans WHERE id = $1 AND organization_id = $2`, [planId, orgId]);
  return r.rows[0] || null;
}

// Gera um lote de ideias com IA (nao salva; o front salva via POST /).
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
  requireQuota('ideas_generate'),
  async (req, res, next) => {
    try {
      const data = req.parsed;
      const persona = await getPersonaInOrg(data.persona_id, req.orgId);
      let plan = await getPlanInOrg(data.plan_id, req.orgId);
      if (plan) {
        plan = { ...plan, pillars: plan.pillars || [], format_mix: plan.format_mix || {} };
        if (!persona && plan.persona_id) {
          // herda persona do planejamento, se houver
          const p = await getPersonaInOrg(plan.persona_id, req.orgId);
          if (p) req.inheritedPersona = p;
        }
      }
      const { system, user } = ideasPrompt({
        client: req.client,
        persona: persona || req.inheritedPersona || null,
        plan,
        count: data.count,
      });
      const ai = await generate({ system, prompt: user, maxTokens: 3000, temperature: 0.8 });
      let parsed;
      try {
        parsed = parseJsonFromText(ai.text);
      } catch (e) {
        await refundQuota(req.orgId);
        return res.status(502).json({ error: 'IA retornou JSON invalido', raw: ai.text });
      }
      const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
      await logUsage({ organizationId: req.orgId, userId: req.session.userId, kind: 'ideas_generate', usage: ai.usage, model: MODEL });
      res.json({ ideas, quota: req.quota });
    } catch (err) {
      try { await refundQuota(req.orgId); } catch {}
      next(err);
    }
  }
);

// Salva um lote de ideias (geradas ou manuais).
router.post('/', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    // Schema leniente: os itens vem da IA (format/funnel_stage podem vir "sujos");
    // normalizamos no loop em vez de derrubar o lote inteiro com um enum estrito.
    const batchItem = z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(6000).optional().nullable(),
      format: z.string().optional().nullable(),
      funnel_stage: z.string().optional().nullable(),
      pillar: z.string().max(300).optional().nullable(),
    });
    const body = z.object({
      client_id: z.string().uuid(),
      plan_id: z.string().uuid().optional().nullable(),
      persona_id: z.string().uuid().optional().nullable(),
      generated_by_ai: z.boolean().optional(),
      ideas: z.array(batchItem).min(1).max(30),
    }).parse(req.body);

    const client = await getClientInOrg(body.client_id, req.orgId);
    if (!client) return res.status(404).json({ error: 'Cliente nao encontrado' });

    const saved = [];
    for (const idea of body.ideas) {
      const fmt = normalizeFormat(idea.format);
      const fun = normalizeFunnel(idea.funnel_stage);
      const r = await query(
        `INSERT INTO content_ideas (
           organization_id, client_id, plan_id, persona_id, title, description,
           format, funnel_stage, pillar, generated_by_ai, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          req.orgId, body.client_id, body.plan_id || null, body.persona_id || null,
          idea.title, idea.description || null, fmt, fun, idea.pillar || null,
          Boolean(body.generated_by_ai), req.session.userId,
        ]
      );
      saved.push(r.rows[0]);
    }
    res.status(201).json({ ideas: saved });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    if (req.role === 'client') return res.json({ ideas: [] }); // interno da agencia
    const filters = ['i.organization_id = $1'];
    const values = [req.orgId];
    let i = 2;
    if (req.query.client_id) { filters.push(`i.client_id = $${i++}`); values.push(req.query.client_id); }
    if (req.query.scheduled === 'true') filters.push('i.scheduled_for IS NOT NULL');
    if (req.query.status) { filters.push(`i.status = $${i++}`); values.push(req.query.status); }
    const r = await query(
      `SELECT i.*, c.name AS client_name
         FROM content_ideas i
         JOIN clients c ON c.id = i.client_id
        WHERE ${filters.join(' AND ')}
        ORDER BY i.scheduled_for ASC NULLS LAST, i.created_at DESC LIMIT 300`,
      values
    );
    res.json({ ideas: r.rows });
  } catch (err) { next(err); }
});

router.put('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = ideaSchema.partial().parse(req.body);
    const allowed = ['title', 'description', 'format', 'funnel_stage', 'pillar', 'status', 'scheduled_for', 'plan_id', 'persona_id'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of allowed) {
      if (data[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        values.push(data[k] === '' ? null : (data[k] ?? null));
      }
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.orgId);
    const r = await query(
      `UPDATE content_ideas SET ${fields.join(', ')}
        WHERE id = $${i++} AND organization_id = $${i} RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Ideia nao encontrada' });
    res.json({ idea: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM content_ideas WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Ideia nao encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// "Criar calendario de conteudo": distribui as ideias sem data ao longo dos
// proximos dias uteis (1 por dia), pra preencher o calendario rapidamente.
router.post('/distribute', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const body = z.object({
      client_id: z.string().uuid(),
      start_date: z.string().optional(),
      per_week: z.number().int().min(1).max(14).optional().default(5),
    }).parse(req.body);

    const client = await getClientInOrg(body.client_id, req.orgId);
    if (!client) return res.status(404).json({ error: 'Cliente nao encontrado' });

    const unscheduled = await query(
      `SELECT id FROM content_ideas
        WHERE organization_id = $1 AND client_id = $2 AND scheduled_for IS NULL
        ORDER BY created_at ASC`,
      [req.orgId, body.client_id]
    );
    if (unscheduled.rowCount === 0) return res.json({ scheduled: 0 });

    // Gera datas: per_week dias por semana (seg-sex priorizado), a partir de start_date.
    const start = body.start_date ? new Date(body.start_date) : new Date();
    start.setHours(9, 0, 0, 0);
    const dates = [];
    const cursor = new Date(start);
    const gapDays = Math.max(1, Math.round(7 / body.per_week));
    while (dates.length < unscheduled.rowCount) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) dates.push(new Date(cursor)); // pula fim de semana
      cursor.setDate(cursor.getDate() + gapDays);
    }

    let n = 0;
    for (let k = 0; k < unscheduled.rowCount; k++) {
      await query(
        `UPDATE content_ideas SET scheduled_for = $1, updated_at = now()
          WHERE id = $2 AND organization_id = $3`,
        [dates[k].toISOString(), unscheduled.rows[k].id, req.orgId]
      );
      n++;
    }
    res.json({ scheduled: n });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

module.exports = router;
