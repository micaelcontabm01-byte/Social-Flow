const express = require('express');
const { query } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess } = require('../middleware/tenant');
const { dashboardPdf, safeFilename } = require('../lib/export-pdf');

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

    // ===== Visao geral: quebra por formato e por status (scripts + carousels) =====
    // Cliente nao ve rascunhos.
    const hideDrafts = req.role === 'client' ? "AND s.status <> 'draft'" : '';
    const cHideDrafts = req.role === 'client' ? "AND c.status <> 'draft'" : '';

    const byFormat = await query(
      `SELECT s.format, count(*)::int AS n
         FROM scripts s
        WHERE s.organization_id = $1 ${clientFilter} ${hideDrafts}
        GROUP BY s.format`,
      params
    );
    const carouselCount = await query(
      `SELECT count(*)::int AS n
         FROM carousels c
        WHERE c.organization_id = $1 ${req.role === 'client' ? 'AND c.client_id = $2' : ''} ${cHideDrafts}`,
      params
    );
    const format = { reel: 0, carrossel: 0, post: 0, story: 0 };
    for (const row of byFormat.rows) if (row.format in format) format[row.format] = row.n;
    // Carrosseis gerados no builder contam como "carrossel" tambem.
    format.carrossel += carouselCount.rows[0].n;

    const scriptStatus = await query(
      `SELECT s.status, count(*)::int AS n
         FROM scripts s
        WHERE s.organization_id = $1 ${clientFilter}
        GROUP BY s.status`,
      params
    );
    const carouselStatus = await query(
      `SELECT c.status, count(*)::int AS n
         FROM carousels c
        WHERE c.organization_id = $1 ${req.role === 'client' ? 'AND c.client_id = $2' : ''}
        GROUP BY c.status`,
      params
    );
    const byStatus = { draft: 0, pending_approval: 0, approved: 0, rejected: 0, published: 0 };
    for (const row of [...scriptStatus.rows, ...carouselStatus.rows]) {
      if (row.status in byStatus) byStatus[row.status] += row.n;
    }

    // Material bruto = clientes com pasta do Drive vinculada (sem upload na base).
    const rawMaterial = await query(
      `SELECT count(*)::int AS total,
              count(drive_folder_url)::int AS with_drive
         FROM clients
        WHERE organization_id = $1 AND archived = false
              ${req.role === 'client' ? 'AND id = $2' : ''}`,
      params
    );

    res.json({
      stats: r.rows[0],
      recent: recent.rows,
      weekly: weekly.rows,
      overview: {
        by_format: format,
        by_status: byStatus,
        raw_material: rawMaterial.rows[0],
      },
    });
  } catch (err) { next(err); }
});

// Fila de edicao: conteudo que ainda falta editar (rascunhos), por cliente.
// Inclui scripts e carousels em 'draft' e ideias 'in_production'.
router.get('/editing-queue', async (req, res, next) => {
  try {
    let clientScope = '';
    let params = [req.orgId];
    if (req.role === 'client') {
      if (!req.memberClientId) return res.json({ clients: [], total: 0 });
      clientScope = 'AND t.client_id = $2';
      params = [req.orgId, req.memberClientId];
    }

    const rows = await query(
      `SELECT t.kind, t.id, t.title, t.format, t.scheduled_for, t.created_at,
              cl.id AS client_id, cl.name AS client_name
         FROM (
           SELECT 'script' AS kind, s.id, s.title, s.format, s.scheduled_for, s.created_at, s.client_id
             FROM scripts s
            WHERE s.organization_id = $1 AND s.status = 'draft'
           UNION ALL
           SELECT 'carousel' AS kind, c.id, c.title, 'carrossel' AS format, NULL::timestamptz, c.created_at, c.client_id
             FROM carousels c
            WHERE c.organization_id = $1 AND c.status = 'draft'
           UNION ALL
           SELECT 'idea' AS kind, i.id, i.title, i.format, i.scheduled_for, i.created_at, i.client_id
             FROM content_ideas i
            WHERE i.organization_id = $1 AND i.status = 'in_production'
         ) t
         JOIN clients cl ON cl.id = t.client_id
        WHERE cl.archived = false ${clientScope}
        ORDER BY cl.name ASC, t.scheduled_for ASC NULLS LAST, t.created_at DESC`,
      params
    );

    // Agrupa por cliente.
    const byClient = [];
    const index = {};
    for (const row of rows.rows) {
      if (!index[row.client_id]) {
        index[row.client_id] = { client_id: row.client_id, client_name: row.client_name, items: [] };
        byClient.push(index[row.client_id]);
      }
      index[row.client_id].items.push({
        kind: row.kind, id: row.id, title: row.title, format: row.format,
        scheduled_for: row.scheduled_for,
      });
    }

    res.json({ clients: byClient, total: rows.rowCount });
  } catch (err) { next(err); }
});

// Exporta o dashboard/visao geral em PDF (recurso do plano BLACK).
router.get('/pdf', async (req, res, next) => {
  try {
    if (req.role === 'client') return res.status(403).json({ error: 'Sem acesso' });

    const org = await query(
      `SELECT name, plan_code FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    if (org.rowCount === 0) return res.status(404).json({ error: 'Organizacao nao encontrada' });
    if (org.rows[0].plan_code !== 'black') {
      return res.status(403).json({ error: 'Exportacao em PDF disponivel no plano BLACK' });
    }

    const summary = await query(
      `SELECT
         (SELECT count(*)::int FROM clients WHERE organization_id = $1 AND archived = false) AS clients,
         (SELECT count(*)::int FROM personas WHERE organization_id = $1) AS personas,
         (SELECT count(*)::int FROM scripts WHERE organization_id = $1 AND status = 'pending_approval') AS pending,
         (SELECT count(*)::int FROM scripts WHERE organization_id = $1 AND status = 'approved' AND approved_at >= date_trunc('month', now())) AS approved_month,
         (SELECT count(*)::int FROM scripts WHERE organization_id = $1 AND status = 'draft') AS drafts`,
      [req.orgId]
    );

    const fmt = await query(
      `SELECT format, count(*)::int AS n FROM scripts WHERE organization_id = $1 GROUP BY format`,
      [req.orgId]
    );
    const carouselN = await query(
      `SELECT count(*)::int AS n FROM carousels WHERE organization_id = $1`,
      [req.orgId]
    );
    const byFormat = { reel: 0, carrossel: 0, post: 0, story: 0 };
    for (const row of fmt.rows) if (row.format in byFormat) byFormat[row.format] = row.n;
    byFormat.carrossel += carouselN.rows[0].n;

    const st = await query(
      `SELECT status, count(*)::int AS n FROM (
         SELECT status FROM scripts WHERE organization_id = $1
         UNION ALL
         SELECT status FROM carousels WHERE organization_id = $1
       ) t GROUP BY status`,
      [req.orgId]
    );
    const byStatus = { draft: 0, pending_approval: 0, approved: 0, rejected: 0, published: 0 };
    for (const row of st.rows) if (row.status in byStatus) byStatus[row.status] = row.n;

    const raw = await query(
      `SELECT count(*)::int AS total, count(drive_folder_url)::int AS with_drive
         FROM clients WHERE organization_id = $1 AND archived = false`,
      [req.orgId]
    );

    const buffer = await dashboardPdf({
      orgName: org.rows[0].name,
      stats: summary.rows[0],
      overview: { by_format: byFormat, by_status: byStatus, raw_material: raw.rows[0] },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename('dashboard-' + org.rows[0].name)}"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
