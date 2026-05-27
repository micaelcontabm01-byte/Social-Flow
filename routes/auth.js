const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query, tx } = require('../lib/db');

const router = express.Router();

const signupSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/signup', async (req, res, next) => {
  try {
    const { name, email, password } = signupSchema.parse(req.body);
    const emailNorm = email.toLowerCase().trim();

    const existing = await query('SELECT id FROM users WHERE email = $1', [emailNorm]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Esse email ja esta cadastrado' });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await tx(async (c) => {
      const userRes = await c.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, email`,
        [name, emailNorm, hash]
      );
      const user = userRes.rows[0];

      const orgRes = await c.query(
        `INSERT INTO organizations (name, owner_user_id)
         VALUES ($1, $2)
         RETURNING id, name`,
        [`Workspace de ${name}`, user.id]
      );
      const org = orgRes.rows[0];

      await c.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [org.id, user.id]
      );

      return { user, org };
    });

    req.session.userId = result.user.id;
    req.session.currentOrgId = result.org.id;
    req.session.role = 'owner';

    res.json({
      user: result.user,
      organization: result.org,
    });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const emailNorm = email.toLowerCase().trim();

    const userRes = await query(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1',
      [emailNorm]
    );
    if (userRes.rowCount === 0) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    const user = userRes.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais invalidas' });

    const memberRes = await query(
      `SELECT m.organization_id, m.role, o.name AS organization_name
       FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1
       ORDER BY m.created_at ASC
       LIMIT 1`,
      [user.id]
    );
    const member = memberRes.rows[0];

    req.session.userId = user.id;
    req.session.currentOrgId = member?.organization_id || null;
    req.session.role = member?.role || null;

    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      organization: member
        ? { id: member.organization_id, name: member.organization_name, role: member.role }
        : null,
    });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

module.exports = router;
