const express = require('express');
const { query } = require('../lib/db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         u.id, u.name, u.email,
         m.organization_id, m.role,
         o.name AS organization_name,
         o.plan_code, o.ia_quota_limit, o.ia_quota_used, o.ia_quota_reset_at
       FROM users u
       JOIN organization_members m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
       WHERE u.id = $1 AND m.organization_id = $2`,
      [req.session.userId, req.session.currentOrgId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const row = result.rows[0];
    res.json({
      ...row,
      black_extras: row.plan_code === 'black'
        ? {
            whatsapp_group_url: process.env.BLACK_WHATSAPP_GROUP_URL || null,
          }
        : null,
      white_label_enabled: ['pro', 'black'].includes(row.plan_code),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
