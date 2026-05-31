const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireMinPlan } = require('../middleware/plan');

const router = express.Router();

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const MAX_LOGO_BYTES = 500 * 1024;

const updateBrandingSchema = z.object({
  logo_data_url: z.string().nullable().optional(),
  brand_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve ser hex no formato #RRGGBB')
    .nullable()
    .optional(),
});

// Serve o logo binario da org (publico - usado em paineis de cliente, emails, etc)
router.get('/logo/:orgId', async (req, res, next) => {
  try {
    const r = await query(
      'SELECT logo_data, logo_mime_type, logo_updated_at FROM organizations WHERE id = $1',
      [req.params.orgId]
    );
    if (r.rowCount === 0 || !r.rows[0].logo_data) {
      return res.status(404).send('Sem logo');
    }
    const { logo_data, logo_mime_type, logo_updated_at } = r.rows[0];
    res.setHeader('Content-Type', logo_mime_type || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (logo_updated_at) {
      res.setHeader('Last-Modified', new Date(logo_updated_at).toUTCString());
    }
    res.end(Buffer.from(logo_data));
  } catch (err) { next(err); }
});

// Retorna metadata de branding (cor + flag de logo) - publico
router.get('/meta/:orgId', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT id, name, brand_color, (logo_data IS NOT NULL) AS has_logo, plan_code
       FROM organizations WHERE id = $1`,
      [req.params.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Nao encontrado' });
    const row = r.rows[0];
    // White-label so vale a partir do Pro
    const whiteLabelActive = ['pro', 'black'].includes(row.plan_code);
    res.json({
      id: row.id,
      name: row.name,
      brand_color: whiteLabelActive ? row.brand_color : null,
      has_logo: whiteLabelActive && row.has_logo,
      logo_url: whiteLabelActive && row.has_logo ? `/api/branding/logo/${row.id}` : null,
    });
  } catch (err) { next(err); }
});

// Atualiza branding (owner do plano Pro+ apenas)
router.put(
  '/',
  requireAuth,
  requireRole('owner'),
  requireMinPlan('pro'),
  async (req, res, next) => {
    try {
      const body = updateBrandingSchema.parse(req.body);
      const orgId = req.session.currentOrgId;

      // Processa logo
      let logoBuffer = null;
      let logoMime = null;
      let removeLogo = false;

      if (body.logo_data_url === null) {
        removeLogo = true;
      } else if (typeof body.logo_data_url === 'string' && body.logo_data_url.startsWith('data:')) {
        const match = body.logo_data_url.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'data URL invalido' });
        const mime = match[1].toLowerCase();
        if (!ALLOWED_MIME.has(mime)) {
          return res.status(415).json({ error: `Tipo nao suportado. Use: ${[...ALLOWED_MIME].join(', ')}` });
        }
        const buf = Buffer.from(match[2], 'base64');
        if (buf.length > MAX_LOGO_BYTES) {
          return res.status(413).json({ error: `Logo muito grande (max ${Math.round(MAX_LOGO_BYTES / 1024)}KB)` });
        }
        logoBuffer = buf;
        logoMime = mime;
      }

      const updates = [];
      const params = [];
      let p = 1;

      if (removeLogo) {
        updates.push(`logo_data = NULL`, `logo_mime_type = NULL`, `logo_updated_at = now()`);
      } else if (logoBuffer) {
        updates.push(`logo_data = $${p++}`);
        params.push(logoBuffer);
        updates.push(`logo_mime_type = $${p++}`);
        params.push(logoMime);
        updates.push(`logo_updated_at = now()`);
      }

      if (body.brand_color !== undefined) {
        updates.push(`brand_color = $${p++}`);
        params.push(body.brand_color);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'Nada para atualizar' });
      }

      updates.push(`updated_at = now()`);
      params.push(orgId);

      await query(
        `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${p}`,
        params
      );

      res.json({ ok: true });
    } catch (err) {
      if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
      next(err);
    }
  }
);

// Pega branding atual da propria org (para tela de configuracoes)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT brand_color, (logo_data IS NOT NULL) AS has_logo, logo_updated_at, plan_code
       FROM organizations WHERE id = $1`,
      [req.session.currentOrgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Org nao encontrada' });
    const row = r.rows[0];
    res.json({
      brand_color: row.brand_color || null,
      has_logo: row.has_logo,
      logo_url: row.has_logo
        ? `/api/branding/logo/${req.session.currentOrgId}?v=${new Date(row.logo_updated_at).getTime()}`
        : null,
      plan_code: row.plan_code,
      white_label_enabled: ['pro', 'black'].includes(row.plan_code),
    });
  } catch (err) { next(err); }
});

module.exports = router;
