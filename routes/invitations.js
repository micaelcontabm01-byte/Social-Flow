const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query, tx } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole } = require('../middleware/tenant');
const { sendEmail, layout, button, APP_URL } = require('../lib/email');

const router = express.Router();

// PUBLIC: visualizar convite por token (sem auth)
router.get('/by-token/:token', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.client_id,
              o.name as organization_name,
              c.name as client_name
       FROM invitations i
       JOIN organizations o ON o.id = i.organization_id
       LEFT JOIN clients c ON c.id = i.client_id
       WHERE i.token = $1`,
      [req.params.token]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Convite nao encontrado' });
    const inv = r.rows[0];
    if (inv.accepted_at) return res.status(410).json({ error: 'Convite ja foi usado' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Convite expirado' });
    res.json({ invitation: inv });
  } catch (err) { next(err); }
});

// PUBLIC: aceitar convite (cria user, adiciona como membro)
const acceptSchema = z.object({
  name: z.string().min(2).max(120),
  password: z.string().min(8).max(200),
});

router.post('/accept/:token', async (req, res, next) => {
  try {
    const data = acceptSchema.parse(req.body);
    const r = await query(
      `SELECT * FROM invitations WHERE token = $1`,
      [req.params.token]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Convite nao encontrado' });
    const inv = r.rows[0];
    if (inv.accepted_at) return res.status(410).json({ error: 'Convite ja foi usado' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Convite expirado' });

    const result = await tx(async (c) => {
      const existing = await c.query('SELECT id FROM users WHERE email = $1', [inv.email]);
      let userId;
      if (existing.rowCount > 0) {
        userId = existing.rows[0].id;
      } else {
        const hash = await bcrypt.hash(data.password, 12);
        const userRes = await c.query(
          `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
          [data.name, inv.email, hash]
        );
        userId = userRes.rows[0].id;
      }

      const memberExists = await c.query(
        `SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
        [inv.organization_id, userId]
      );
      if (memberExists.rowCount === 0) {
        await c.query(
          `INSERT INTO organization_members (organization_id, user_id, role, client_id)
           VALUES ($1, $2, $3, $4)`,
          [inv.organization_id, userId, inv.role, inv.client_id || null]
        );
      }

      await c.query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [inv.id]);

      return { userId, role: inv.role, organizationId: inv.organization_id };
    });

    req.session.userId = result.userId;
    req.session.currentOrgId = result.organizationId;
    req.session.role = result.role;

    res.json({ ok: true, role: result.role });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// AUTH: listar e criar convites
router.use(requireAuth, requireOrgAccess);

router.get('/', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT i.id, i.email, i.role, i.client_id, i.expires_at, i.accepted_at, i.created_at,
              c.name as client_name, u.name as invited_by_name
       FROM invitations i
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN users u ON u.id = i.invited_by_user_id
       WHERE i.organization_id = $1
       ORDER BY i.created_at DESC
       LIMIT 100`,
      [req.orgId]
    );
    res.json({ invitations: r.rows });
  } catch (err) { next(err); }
});

const createSchema = z.object({
  email: z.string().email(),
  role: z.enum(['collaborator', 'client']),
  client_id: z.string().uuid().optional().nullable(),
});

router.post('/', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const emailNorm = data.email.toLowerCase().trim();
    if (data.role === 'client' && !data.client_id) {
      return res.status(400).json({ error: 'Convite para cliente requer client_id' });
    }
    if (data.role === 'client') {
      const cli = await query(`SELECT id FROM clients WHERE id = $1 AND organization_id = $2`, [data.client_id, req.orgId]);
      if (cli.rowCount === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });
    }

    const existing = await query(
      `SELECT id FROM invitations WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL`,
      [req.orgId, emailNorm]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Ja existe convite pendente para esse email' });
    }

    const token = crypto.randomBytes(32).toString('hex');

    const r = await query(
      `INSERT INTO invitations (organization_id, email, role, client_id, token, invited_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.orgId, emailNorm, data.role, data.client_id || null, token, req.session.userId]
    );

    const inv = r.rows[0];
    const orgRes = await query('SELECT name FROM organizations WHERE id = $1', [req.orgId]);
    const orgName = orgRes.rows[0]?.name;
    const link = `${APP_URL}/aceitar-convite?token=${token}`;

    try {
      await sendEmail({
        to: emailNorm,
        subject: `Voce foi convidado para o SocialFlow (${orgName})`,
        html: layout(`
          <h2 style="font-size:18px; margin: 0 0 12px;">Voce foi convidado</h2>
          <p style="margin: 0 0 8px; color: #6b5848;">${orgName} te convidou para participar do SocialFlow como <strong>${data.role === 'client' ? 'cliente' : 'colaborador'}</strong>.</p>
          <p style="margin: 0 0 20px; color: #6b5848;">Clique no botao abaixo para criar sua senha e entrar.</p>
          ${button(link, 'Aceitar convite')}
          <p class="muted small" style="margin-top:14px; color:#9a8970; font-size:12px;">Esse convite expira em 7 dias.</p>
        `),
        text: `Voce foi convidado para ${orgName} no SocialFlow.\nAceite em: ${link}`,
      });
    } catch (e) {
      console.error('[invite-email] falhou:', e.message);
    }

    res.status(201).json({ invitation: inv, accept_link: link });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const r = await query(
      `DELETE FROM invitations WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Convite nao encontrado ou ja foi aceito' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/members', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT m.id, m.role, m.client_id, m.created_at,
              u.id as user_id, u.name, u.email,
              c.name as client_name
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE m.organization_id = $1
       ORDER BY m.created_at ASC`,
      [req.orgId]
    );
    res.json({ members: r.rows });
  } catch (err) { next(err); }
});

router.delete('/members/:id', requireOrgRole('owner'), async (req, res, next) => {
  try {
    const memberRes = await query(
      `SELECT user_id, role FROM organization_members WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (memberRes.rowCount === 0) return res.status(404).json({ error: 'Membro nao encontrado' });
    if (memberRes.rows[0].role === 'owner') return res.status(400).json({ error: 'Nao pode remover o owner' });
    await query(`DELETE FROM organization_members WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
