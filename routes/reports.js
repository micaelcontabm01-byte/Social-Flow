const express = require('express');
const { query } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess } = require('../middleware/tenant');
const { requireMinPlan } = require('../middleware/plan');
const {
  generateClientReport,
  generateAndSaveMonthlyReportsForBlack,
  previousMonth,
  monthLabel,
} = require('../lib/reports');

const router = express.Router();

// === CRON handler exportado para uso direto no server.js (path /api/cron/monthly-reports) ===
// Aceita GET (Vercel cron) e POST (testes manuais com curl)
async function runMonthlyCron(req, res, next) {
  try {
    const expected = process.env.CRON_SECRET;
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!expected) {
      return res.status(500).json({ error: 'CRON_SECRET nao configurado no servidor' });
    }
    if (token !== expected) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
    const { year, month } = previousMonth();
    const summary = await generateAndSaveMonthlyReportsForBlack({ year, month, source: 'cron' });
    res.json({ ok: true, period: { year, month, label: monthLabel(month) }, summary });
  } catch (err) { next(err); }
}

router.get('/cron/run', runMonthlyCron);
router.post('/cron/run', runMonthlyCron);

// Lista relatorios da org (apenas BLACK consegue, mas Pro ja viu botao desabilitado)
router.get(
  '/',
  requireAuth,
  requireOrgAccess,
  async (req, res, next) => {
    try {
      const r = await query(
        `SELECT r.id, r.period_year, r.period_month, r.generated_at, r.generated_by,
                r.client_id, c.name AS client_name, c.instagram_handle
           FROM monthly_reports r
           JOIN clients c ON c.id = r.client_id
          WHERE r.organization_id = $1
          ORDER BY r.period_year DESC, r.period_month DESC, c.name ASC`,
        [req.orgId]
      );
      res.json({ reports: r.rows });
    } catch (err) { next(err); }
  }
);

// Download PDF
router.get(
  '/:id/download',
  requireAuth,
  requireOrgAccess,
  async (req, res, next) => {
    try {
      const r = await query(
        `SELECT r.pdf_data, r.period_year, r.period_month, c.name AS client_name
           FROM monthly_reports r
           JOIN clients c ON c.id = r.client_id
          WHERE r.id = $1 AND r.organization_id = $2`,
        [req.params.id, req.orgId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Relatorio nao encontrado' });
      const { pdf_data, period_year, period_month, client_name } = r.rows[0];
      if (!pdf_data) return res.status(404).json({ error: 'PDF nao disponivel' });

      const fileName = `relatorio-${client_name.replace(/[^a-zA-Z0-9-_]+/g, '-')}-${period_year}-${String(period_month).padStart(2, '0')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.end(Buffer.from(pdf_data));
    } catch (err) { next(err); }
  }
);

// Geracao manual (BLACK only) - para um cliente especifico
router.post(
  '/generate',
  requireAuth,
  requireOrgAccess,
  requireMinPlan('black'),
  async (req, res, next) => {
    try {
      const { client_id, year, month } = req.body || {};
      if (!client_id) return res.status(400).json({ error: 'client_id obrigatorio' });

      const period = year && month
        ? { year: Number(year), month: Number(month) }
        : previousMonth();

      // Verifica cliente pertence a org
      const cli = await query('SELECT id FROM clients WHERE id = $1 AND organization_id = $2', [client_id, req.orgId]);
      if (cli.rowCount === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });

      // Se ja existe, regenera (UPSERT)
      const { pdf, metrics } = await generateClientReport({
        organizationId: req.orgId,
        clientId: client_id,
        year: period.year,
        month: period.month,
      });

      const existing = await query(
        `SELECT id FROM monthly_reports WHERE client_id = $1 AND period_year = $2 AND period_month = $3`,
        [client_id, period.year, period.month]
      );

      let reportId;
      if (existing.rowCount > 0) {
        reportId = existing.rows[0].id;
        await query(
          `UPDATE monthly_reports SET pdf_data = $1, metrics = $2, generated_at = now(), generated_by = 'manual' WHERE id = $3`,
          [pdf, metrics, reportId]
        );
      } else {
        const ins = await query(
          `INSERT INTO monthly_reports (organization_id, client_id, period_year, period_month, pdf_data, metrics, generated_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'manual')
           RETURNING id`,
          [req.orgId, client_id, period.year, period.month, pdf, metrics]
        );
        reportId = ins.rows[0].id;
      }
      res.json({ ok: true, report_id: reportId, period });
    } catch (err) { next(err); }
  }
);

module.exports = router;
module.exports.runMonthlyCron = runMonthlyCron;
