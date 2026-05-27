const express = require('express');
const { query } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess } = require('../middleware/tenant');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

router.get('/stats', async (req, res, next) => {
  try {
    const clientFilter = req.role === 'client' ? 'AND s.client_id = $2' : '';
    const params = req.role === 'client' ? [req.orgId, req.memberClientId] : [req.orgId];

    const r = await query(
      `SELECT
        (SELECT count(*)::int FROM clients WHERE organization_id = $1 AND archived = false ${req.role === 'client' ? 'AND id = $2' : ''}) AS clients,
        (SELECT count(*)::int FROM scripts s WHERE s.organization_id = $1 AND s.status = 'pending_approval' ${clientFilter}) AS pending,
        (SELECT count(*)::int FROM scripts s WHERE s.organization_id = $1 AND s.status = 'approved' AND s.approved_at >= date_trunc('month', now()) ${clientFilter}) AS approved_month,
        (SELECT count(*)::int FROM scripts s WHERE s.organization_id = $1 AND s.status = 'draft' ${clientFilter}) AS drafts,
        (SELECT count(*)::int FROM carousels c WHERE c.organization_id = $1 AND c.status = 'pending_approval' ${req.role === 'client' ? 'AND c.client_id = $2' : ''}) AS carousels_pending,
        (SELECT count(*)::int FROM personas p WHERE p.organization_id = $1 ${req.role === 'client' ? 'AND p.client_id = $2' : ''}) AS personas`,
      params
    );

    const recent = await query(
      `SELECT 'script' AS type, s.id, s.title, s.status, s.created_at, c.name AS client_name
       FROM scripts s
       JOIN clients c ON c.id = s.client_id
       WHERE s.organization_id = $1 ${req.role === 'client' ? "AND s.client_id = $2 AND s.status != 'draft'" : ''}
       ORDER BY s.created_at DESC LIMIT 10`,
      params
    );

    const weeklyParams = req.role === 'client' ? [req.orgId, req.memberClientId] : [req.orgId];
    const weeklyClient = req.role === 'client' ? "AND s.client_id = $2" : '';

    const weekly = await query(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', now()) - interval '6 days',
           date_trunc('day', now()),
           interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS day,
              COALESCE(count(s.id)::int, 0) AS scripts_created,
              COALESCE(SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END)::int, 0) AS approved
       FROM days d
       LEFT JOIN scripts s ON date_trunc('day', s.created_at)::date = d.day
                          AND s.organization_id = $1 ${weeklyClient}
       GROUP BY d.day
       ORDER BY d.day`,
      weeklyParams
    );

    res.json({ stats: r.rows[0], recent: recent.rows, weekly: weekly.rows });
  } catch (err) { next(err); }
});

module.exports = router;
