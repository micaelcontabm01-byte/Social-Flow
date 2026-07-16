const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { generate, MODEL } = require('../lib/ai');
const { carouselPrompt, parseJsonFromText } = require('../lib/prompts');
const { getTemplate, listTemplates, emptySlides } = require('../lib/templates');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { requireQuota, refundQuota, logUsage, peekImageQuota, debitImageQuotaN } = require('../middleware/quota');
const { buildSlidePrompt, generateImageFromPrompt } = require('../lib/images');
const drive = require('../lib/drive');
const { getFreshGoogleToken } = require('../lib/integrations');
const { carouselPdf, safeFilename } = require('../lib/export-pdf');

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
      const ai = await generate({ system, prompt: user, maxTokens: 2000 });

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
      `SELECT c.id, c.organization_id, c.client_id, c.persona_id, c.script_id,
              c.template_id, c.title, c.slides, c.status, c.raw_input,
              c.generated_by_ai, c.created_at, c.updated_at,
              cli.name as client_name
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
    // Indices de slides que ja tem imagem gerada (pro frontend montar os fundos).
    const imgs = await query(
      `SELECT slide_index FROM carousel_slide_images WHERE carousel_id = $1 ORDER BY slide_index`,
      [req.params.id]
    );
    const carousel = r.rows[0];
    carousel.image_slides = imgs.rows.map((x) => x.slide_index);
    res.json({ carousel });
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

// ===== Serve a imagem de um slide (membros da org; cliente so ve do proprio cliente) =====
router.get('/:id/slide-image/:index', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT si.image_data, si.image_mime, c.client_id, c.status
         FROM carousel_slide_images si
         JOIN carousels c ON c.id = si.carousel_id
        WHERE si.carousel_id = $1 AND si.slide_index = $2 AND c.organization_id = $3`,
      [req.params.id, parseInt(req.params.index, 10) || 0, req.orgId]
    );
    if (r.rowCount === 0 || !r.rows[0].image_data) return res.status(404).send('Sem imagem');
    const row = r.rows[0];
    // Mesma regra do GET /:id: cliente so ve conteudo do proprio cliente e nao-rascunho.
    if (req.role === 'client') {
      if (row.client_id !== req.memberClientId || row.status === 'draft') {
        return res.status(403).send('Sem acesso');
      }
    }
    res.setHeader('Content-Type', row.image_mime || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(Buffer.from(row.image_data));
  } catch (err) { next(err); }
});

// Helper: monta a lista de slides (numero + texto agregado) a partir do template.
function slideContexts(templateId, slides) {
  const template = getTemplate(templateId);
  const out = [];
  if (template) {
    const grouped = {};
    for (const f of template.fields) (grouped[f.slide] = grouped[f.slide] || []).push(f);
    Object.keys(grouped).sort((a, b) => +a - +b).forEach((n) => {
      const text = grouped[n].map((f) => slides?.[f.key]).filter(Boolean).join('. ');
      out.push({ index: Number(n), text });
    });
  } else {
    Object.values(slides || {}).forEach((v, i) => out.push({ index: i + 1, text: String(v || '') }));
  }
  return out;
}

// ===== Gera (com IA) imagem de fundo para TODOS os slides =====
// Pre-checa a cota (read-only), gera em paralelo tolerando falha individual,
// e SO debita a cota das imagens que REALMENTE geraram. Assim um timeout da
// Vercel (60s) nunca queima cota sem entregar imagem.
router.post('/:id/images/generate',
  requireOrgRole('owner', 'collaborator'),
  async (req, res, next) => {
    try {
      const cr = await query(
        `SELECT c.id, c.title, c.template_id, c.slides, c.raw_input, cli.niche
           FROM carousels c JOIN clients cli ON cli.id = c.client_id
          WHERE c.id = $1 AND c.organization_id = $2`,
        [req.params.id, req.orgId]
      );
      if (cr.rowCount === 0) return res.status(404).json({ error: 'Carrossel nao encontrado' });
      req.carousel = cr.rows[0];
      req.contexts = slideContexts(cr.rows[0].template_id, cr.rows[0].slides);
      if (req.contexts.length === 0) return res.status(400).json({ error: 'Carrossel sem slides' });
      next();
    } catch (err) { next(err); }
  },
  async (req, res, next) => {
    // Pre-check read-only: se nao cabe N, 429 antes de gastar OpenAI.
    try {
      const n = req.contexts.length;
      const q = await peekImageQuota(req.orgId);
      if (q.remaining < n) {
        return res.status(429).json({
          error: `Voce precisa de ${n} imagens mas so tem ${q.remaining} na cota deste mes. Faca upgrade do plano.`,
          quota: q,
        });
      }
      next();
    } catch (e) { next(e); }
  },
  async (req, res, next) => {
    const c = req.carousel;
    const theme = c.raw_input?.theme || null;
    try {
      // Gera todas em paralelo, tolerando falha individual.
      const results = await Promise.allSettled(
        req.contexts.map(({ text }) => {
          const prompt = buildSlidePrompt({ niche: c.niche, theme, slideText: text });
          return generateImageFromPrompt(prompt, 'high');
        })
      );

      let okCount = 0, failCount = 0, noKey = false;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const idx = req.contexts[i].index;
        if (r.status === 'fulfilled') {
          await query(
            `INSERT INTO carousel_slide_images (carousel_id, organization_id, slide_index, image_data, image_mime, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (carousel_id, slide_index) DO UPDATE SET
               image_data = EXCLUDED.image_data, image_mime = EXCLUDED.image_mime, updated_at = now()`,
            [c.id, req.orgId, idx, r.value.buffer, r.value.mime]
          );
          okCount++;
        } else {
          failCount++;
          if (r.reason?.code === 'NO_OPENAI_KEY') noKey = true;
        }
      }

      if (okCount === 0) {
        if (noKey) return res.status(503).json({ error: 'Geracao de imagem indisponivel (chave da OpenAI nao configurada).' });
        return res.status(502).json({ error: 'Nao foi possivel gerar as imagens. Tente novamente.' });
      }

      // Debita SO o que gerou (apos sucesso). Timeout antes daqui = cobranca zero.
      const quota = await debitImageQuotaN(req.orgId, okCount);

      await logUsage({
        organizationId: req.orgId, userId: req.session.userId,
        kind: 'carousel_slide_images', model: 'gpt-image-1',
      });

      const v = Date.now();
      const images = {};
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
          const idx = req.contexts[i].index;
          images[idx] = `/api/carousels/${c.id}/slide-image/${idx}?v=${v}`;
        }
      }
      res.json({ ok: true, generated: okCount, failed: failCount, images, quota });
    } catch (err) {
      next(err);
    }
  }
);

// ===== Remove todas as imagens do carrossel =====
router.delete('/:id/images', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const cr = await query('SELECT id FROM carousels WHERE id = $1 AND organization_id = $2', [req.params.id, req.orgId]);
    if (cr.rowCount === 0) return res.status(404).json({ error: 'Carrossel nao encontrado' });
    await query('DELETE FROM carousel_slide_images WHERE carousel_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ===== Export para Google Drive (PDF) =====
router.post('/:id/export/drive', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const cr = await query(
      `SELECT c.*, cli.name as client_name
         FROM carousels c JOIN clients cli ON cli.id = c.client_id
        WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (cr.rowCount === 0) return res.status(404).json({ error: 'Carrossel nao encontrado' });
    const carousel = cr.rows[0];

    const integ = await getFreshGoogleToken(req.orgId);
    if (!integ) return res.status(409).json({ error: 'Conecte sua conta do Google Drive em Configuracoes primeiro.' });

    // Imagens de fundo por slide (slide_index -> Buffer) pro PDF.
    const imgs = await query(
      `SELECT slide_index, image_data FROM carousel_slide_images WHERE carousel_id = $1`,
      [carousel.id]
    );
    carousel.slide_images = {};
    for (const row of imgs.rows) carousel.slide_images[row.slide_index] = Buffer.from(row.image_data);
    const pdf = await carouselPdf(carousel);
    // Prefere a pasta do proprio cliente; senao a pasta SocialFlow da org.
    const cf = await query('SELECT drive_folder_id FROM clients WHERE id = $1', [carousel.client_id]);
    const folderId = cf.rows[0]?.drive_folder_id || integ.config?.folder_id || null;
    const file = await drive.uploadPdf(integ.access_token, folderId, safeFilename('carrossel-' + carousel.title), pdf);
    res.json({ ok: true, url: file.webViewLink });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
