const PDFDocument = require('pdfkit');
const { query } = require('./db');

const BRAND = {
  primary: '#8b6f47',
  primaryDark: '#3d2c1d',
  bg: '#faf6f0',
  accent: '#a0826d',
  text1: '#3d2c1d',
  text2: '#6b5848',
  text3: '#9a8970',
  line: '#d9c9b0',
  green: '#2d8659',
  red: '#b04545',
};

function monthLabel(month) {
  return ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][month - 1];
}

async function collectClientMetrics({ organizationId, clientId, year, month }) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const [client, scripts, carousels, personas, ia] = await Promise.all([
    query('SELECT id, name, niche, instagram_handle FROM clients WHERE id = $1 AND organization_id = $2', [clientId, organizationId]),
    query(
      `SELECT status, funnel_stage, format, generated_by_ai, created_at, approved_at
         FROM scripts WHERE client_id = $1 AND created_at >= $2 AND created_at < $3`,
      [clientId, start, end]
    ),
    query(
      `SELECT status, generated_by_ai, created_at
         FROM carousels WHERE client_id = $1 AND created_at >= $2 AND created_at < $3`,
      [clientId, start, end]
    ),
    query(
      `SELECT generated_by_ai, created_at
         FROM personas WHERE client_id = $1 AND created_at >= $2 AND created_at < $3`,
      [clientId, start, end]
    ),
    query(
      `SELECT count(*)::int AS total
         FROM ia_usage_log
         WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`,
      [organizationId, start, end]
    ),
  ]);

  if (client.rowCount === 0) {
    throw new Error('Cliente nao encontrado nessa organizacao');
  }

  const scriptRows = scripts.rows;
  const carouselRows = carousels.rows;

  const approved = scriptRows.filter(s => s.status === 'approved' || s.status === 'published').length;
  const submitted = scriptRows.filter(s => s.status !== 'draft').length;
  const approvalRate = submitted > 0 ? Math.round((approved / submitted) * 100) : 0;

  const byFunnel = { topo: 0, meio: 0, fundo: 0 };
  scriptRows.forEach(s => {
    if (s.funnel_stage && byFunnel[s.funnel_stage] !== undefined) byFunnel[s.funnel_stage]++;
  });

  const byFormat = {};
  scriptRows.forEach(s => {
    const k = s.format || 'outro';
    byFormat[k] = (byFormat[k] || 0) + 1;
  });

  const aiScripts = scriptRows.filter(s => s.generated_by_ai).length;
  const aiCarousels = carouselRows.filter(c => c.generated_by_ai).length;
  const aiPersonas = personas.rows.filter(p => p.generated_by_ai).length;

  const approvalTimes = scriptRows
    .filter(s => s.approved_at && s.created_at)
    .map(s => (new Date(s.approved_at) - new Date(s.created_at)) / (1000 * 60 * 60));
  const avgApprovalHours = approvalTimes.length > 0
    ? Math.round(approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length)
    : null;

  return {
    client: client.rows[0],
    period: { year, month, label: `${monthLabel(month)} de ${year}` },
    totals: {
      scripts: scriptRows.length,
      scripts_approved: approved,
      scripts_submitted: submitted,
      carousels: carouselRows.length,
      personas: personas.rows.length,
      ia_generations: ia.rows[0].total,
    },
    rates: {
      approval_rate: approvalRate,
      avg_approval_hours: avgApprovalHours,
    },
    breakdown: {
      by_funnel: byFunnel,
      by_format: byFormat,
      ai_generated: {
        scripts: aiScripts,
        carousels: aiCarousels,
        personas: aiPersonas,
      },
    },
  };
}

function drawHeader(doc, { metrics, branding }) {
  const color = branding?.brand_color || BRAND.primary;

  doc.save();
  doc.rect(0, 0, doc.page.width, 110).fill(color);

  if (branding?.logo_buffer) {
    try {
      doc.image(branding.logo_buffer, 40, 25, { fit: [60, 60] });
    } catch {}
  }

  doc.fillColor('#ffffff');
  doc.fontSize(11).font('Helvetica').text(branding?.org_name || 'SocialFlow', 120, 30, { width: 400 });
  doc.fontSize(22).font('Helvetica-Bold').text('Relatorio mensal', 120, 48, { width: 400 });
  doc.fontSize(11).font('Helvetica').text(metrics.period.label, 120, 80, { width: 400 });

  doc.restore();
  doc.y = 140;
}

function drawSectionTitle(doc, text) {
  doc.moveDown(0.5);
  doc.fillColor(BRAND.text1).font('Helvetica-Bold').fontSize(13).text(text);
  const y = doc.y + 2;
  doc.strokeColor(BRAND.line).lineWidth(1).moveTo(40, y).lineTo(doc.page.width - 40, y).stroke();
  doc.moveDown(0.8);
}

function drawMetricCard(doc, { x, y, w, h, label, value, sub }) {
  doc.save();
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(BRAND.bg, BRAND.line);
  doc.fillColor(BRAND.text3).fontSize(9).font('Helvetica').text(String(label).toUpperCase(), x + 14, y + 12, { width: w - 28 });
  doc.fillColor(BRAND.text1).fontSize(22).font('Helvetica-Bold').text(String(value), x + 14, y + 26, { width: w - 28 });
  if (sub) {
    doc.fillColor(BRAND.text2).fontSize(9).font('Helvetica').text(sub, x + 14, y + h - 22, { width: w - 28 });
  }
  doc.restore();
}

function drawBar(doc, { x, y, w, h, value, max, color, label, valueLabel }) {
  doc.fillColor(BRAND.text2).fontSize(10).font('Helvetica').text(label, x, y, { width: 90 });
  const barX = x + 100;
  const barW = w - 100 - 60;
  doc.save();
  doc.roundedRect(barX, y + 1, barW, h, 5).fill(BRAND.bg);
  const fillW = max > 0 ? Math.max(2, Math.round((value / max) * barW)) : 0;
  if (fillW > 0) doc.roundedRect(barX, y + 1, fillW, h, 5).fill(color || BRAND.primary);
  doc.restore();
  doc.fillColor(BRAND.text1).fontSize(10).font('Helvetica-Bold').text(valueLabel || String(value), barX + barW + 8, y, { width: 50 });
}

function renderPdf({ metrics, branding }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: {
        Title: `Relatorio ${metrics.client.name} - ${metrics.period.label}`,
        Author: branding?.org_name || 'SocialFlow',
        Subject: 'Relatorio mensal de conteudo',
      }});
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawHeader(doc, { metrics, branding });

      // Bloco cliente
      doc.fillColor(BRAND.text1).font('Helvetica-Bold').fontSize(18).text(metrics.client.name);
      const subInfo = [
        metrics.client.niche,
        metrics.client.instagram_handle ? '@' + metrics.client.instagram_handle : null,
      ].filter(Boolean).join(' · ');
      if (subInfo) {
        doc.fillColor(BRAND.text2).font('Helvetica').fontSize(11).text(subInfo);
      }
      doc.moveDown(1);

      // Cards de metricas principais
      drawSectionTitle(doc, 'Producao no periodo');
      const cardY = doc.y;
      const cardW = (doc.page.width - 80 - 30) / 4;
      const cardH = 70;
      drawMetricCard(doc, { x: 40, y: cardY, w: cardW, h: cardH, label: 'Roteiros', value: metrics.totals.scripts, sub: `${metrics.breakdown.ai_generated.scripts} via IA` });
      drawMetricCard(doc, { x: 40 + cardW + 10, y: cardY, w: cardW, h: cardH, label: 'Carrosseis', value: metrics.totals.carousels, sub: `${metrics.breakdown.ai_generated.carousels} via IA` });
      drawMetricCard(doc, { x: 40 + (cardW + 10) * 2, y: cardY, w: cardW, h: cardH, label: 'Personas', value: metrics.totals.personas, sub: `${metrics.breakdown.ai_generated.personas} via IA` });
      drawMetricCard(doc, { x: 40 + (cardW + 10) * 3, y: cardY, w: cardW, h: cardH, label: 'Geracoes IA', value: metrics.totals.ia_generations, sub: 'total do mes' });
      doc.y = cardY + cardH + 16;

      // Aprovacao
      drawSectionTitle(doc, 'Aprovacao');
      const apvY = doc.y;
      const apvW = (doc.page.width - 80 - 10) / 2;
      drawMetricCard(doc, {
        x: 40, y: apvY, w: apvW, h: 70,
        label: 'Taxa de aprovacao',
        value: `${metrics.rates.approval_rate}%`,
        sub: `${metrics.totals.scripts_approved} aprovados de ${metrics.totals.scripts_submitted} enviados`,
      });
      drawMetricCard(doc, {
        x: 40 + apvW + 10, y: apvY, w: apvW, h: 70,
        label: 'Tempo medio ate aprovacao',
        value: metrics.rates.avg_approval_hours !== null ? `${metrics.rates.avg_approval_hours}h` : '—',
        sub: metrics.rates.avg_approval_hours !== null ? 'media das aprovacoes do mes' : 'nenhuma aprovacao registrada',
      });
      doc.y = apvY + 70 + 16;

      // Funil
      drawSectionTitle(doc, 'Funil de conteudo');
      const funnelMax = Math.max(metrics.breakdown.by_funnel.topo, metrics.breakdown.by_funnel.meio, metrics.breakdown.by_funnel.fundo, 1);
      drawBar(doc, { x: 40, y: doc.y, w: doc.page.width - 80, h: 14, value: metrics.breakdown.by_funnel.topo, max: funnelMax, color: BRAND.accent, label: 'Topo' });
      doc.y += 22;
      drawBar(doc, { x: 40, y: doc.y, w: doc.page.width - 80, h: 14, value: metrics.breakdown.by_funnel.meio, max: funnelMax, color: BRAND.primary, label: 'Meio' });
      doc.y += 22;
      drawBar(doc, { x: 40, y: doc.y, w: doc.page.width - 80, h: 14, value: metrics.breakdown.by_funnel.fundo, max: funnelMax, color: BRAND.primaryDark, label: 'Fundo' });
      doc.y += 28;

      // Formato (se houver dados)
      const formatEntries = Object.entries(metrics.breakdown.by_format).sort((a, b) => b[1] - a[1]);
      if (formatEntries.length > 0) {
        drawSectionTitle(doc, 'Distribuicao por formato');
        const formatMax = Math.max(...formatEntries.map(e => e[1]), 1);
        formatEntries.forEach(([fmt, count]) => {
          drawBar(doc, { x: 40, y: doc.y, w: doc.page.width - 80, h: 12, value: count, max: formatMax, color: BRAND.accent, label: fmt.toUpperCase() });
          doc.y += 20;
        });
        doc.moveDown(0.5);
      }

      // Resumo final
      drawSectionTitle(doc, 'Resumo executivo');
      doc.fillColor(BRAND.text1).font('Helvetica').fontSize(11);
      const lines = [
        `${metrics.client.name} teve ${metrics.totals.scripts} roteiro(s) e ${metrics.totals.carousels} carrossel(eis) produzido(s) em ${metrics.period.label}.`,
        `A taxa de aprovacao ficou em ${metrics.rates.approval_rate}% (${metrics.totals.scripts_approved} de ${metrics.totals.scripts_submitted} enviados).`,
        metrics.rates.avg_approval_hours !== null
          ? `O tempo medio entre envio e aprovacao foi de ${metrics.rates.avg_approval_hours} hora(s).`
          : `Nenhuma aprovacao registrada nesse periodo.`,
        `Foram usadas ${metrics.totals.ia_generations} geracao(oes) de IA da agencia para este cliente.`,
      ];
      lines.forEach(l => { doc.text('• ' + l, { paragraphGap: 4 }); });

      // Rodape
      doc.fontSize(9).fillColor(BRAND.text3).font('Helvetica');
      doc.text(
        `Gerado em ${new Date().toLocaleString('pt-BR')} · ${branding?.org_name || 'SocialFlow'}`,
        40, doc.page.height - 40, { align: 'center', width: doc.page.width - 80 }
      );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function generateClientReport({ organizationId, clientId, year, month }) {
  const metrics = await collectClientMetrics({ organizationId, clientId, year, month });

  const brandingRes = await query(
    `SELECT name, brand_color, logo_data, logo_mime_type FROM organizations WHERE id = $1`,
    [organizationId]
  );
  const orgRow = brandingRes.rows[0] || {};
  const branding = {
    org_name: orgRow.name,
    brand_color: orgRow.brand_color,
    logo_buffer: orgRow.logo_data ? Buffer.from(orgRow.logo_data) : null,
  };

  const pdf = await renderPdf({ metrics, branding });
  return { pdf, metrics };
}

function previousMonth(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

async function generateAndSaveMonthlyReportsForBlack({ year, month, source = 'cron' }) {
  const orgs = await query(
    `SELECT id FROM organizations WHERE plan_code = 'black'`
  );
  const summary = { orgs_processed: 0, clients_processed: 0, errors: [], skipped_existing: 0 };

  for (const org of orgs.rows) {
    summary.orgs_processed++;
    const clientsRes = await query(
      `SELECT id, name FROM clients WHERE organization_id = $1 AND archived = false`,
      [org.id]
    );
    for (const client of clientsRes.rows) {
      const exists = await query(
        `SELECT id FROM monthly_reports WHERE client_id = $1 AND period_year = $2 AND period_month = $3`,
        [client.id, year, month]
      );
      if (exists.rowCount > 0) {
        summary.skipped_existing++;
        continue;
      }
      try {
        const { pdf, metrics } = await generateClientReport({
          organizationId: org.id,
          clientId: client.id,
          year, month,
        });
        await query(
          `INSERT INTO monthly_reports (organization_id, client_id, period_year, period_month, pdf_data, metrics, generated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [org.id, client.id, year, month, pdf, metrics, source]
        );
        summary.clients_processed++;
      } catch (e) {
        console.error('[reports] falha gerar relatorio cliente', client.id, e.message);
        summary.errors.push({ client_id: client.id, error: e.message });
      }
    }
  }
  return summary;
}

module.exports = {
  collectClientMetrics,
  generateClientReport,
  generateAndSaveMonthlyReportsForBlack,
  previousMonth,
  monthLabel,
};
