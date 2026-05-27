const { query, tx } = require('../lib/db');

async function checkAndReserveQuota(orgId) {
  return await tx(async (c) => {
    const res = await c.query(
      `SELECT ia_quota_limit, ia_quota_used, ia_quota_reset_at
       FROM organizations WHERE id = $1 FOR UPDATE`,
      [orgId]
    );
    if (res.rowCount === 0) {
      const e = new Error('Organizacao nao encontrada');
      e.code = 'ORG_NOT_FOUND';
      throw e;
    }
    const org = res.rows[0];

    if (new Date(org.ia_quota_reset_at) < new Date()) {
      await c.query(
        `UPDATE organizations
         SET ia_quota_used = 0, ia_quota_reset_at = now() + interval '30 days'
         WHERE id = $1`,
        [orgId]
      );
      org.ia_quota_used = 0;
    }

    if (org.ia_quota_used >= org.ia_quota_limit) {
      const e = new Error('Limite de IA atingido neste ciclo');
      e.code = 'IA_QUOTA_EXCEEDED';
      e.quota = { used: org.ia_quota_used, limit: org.ia_quota_limit };
      throw e;
    }

    await c.query(
      `UPDATE organizations SET ia_quota_used = ia_quota_used + 1 WHERE id = $1`,
      [orgId]
    );

    return {
      used: org.ia_quota_used + 1,
      limit: org.ia_quota_limit,
      remaining: org.ia_quota_limit - org.ia_quota_used - 1,
    };
  });
}

async function refundQuota(orgId) {
  await query(
    `UPDATE organizations
     SET ia_quota_used = greatest(0, ia_quota_used - 1)
     WHERE id = $1`,
    [orgId]
  );
}

async function logUsage({ organizationId, userId, kind, usage, model, costUsd }) {
  try {
    await query(
      `INSERT INTO ia_usage_log
       (organization_id, user_id, kind, tokens_input, tokens_output, model, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        organizationId,
        userId || null,
        kind,
        usage?.input_tokens ?? null,
        usage?.output_tokens ?? null,
        model || null,
        costUsd ?? null,
      ]
    );
  } catch (e) {
    console.error('[ia_usage_log] insert falhou:', e.message);
  }
}

function requireQuota(kind) {
  return async (req, res, next) => {
    try {
      const reservation = await checkAndReserveQuota(req.session.currentOrgId);
      req.quota = reservation;
      req.quotaKind = kind;
      next();
    } catch (e) {
      if (e.code === 'IA_QUOTA_EXCEEDED') {
        return res.status(429).json({
          error: 'Limite de IA atingido neste ciclo',
          quota: e.quota,
        });
      }
      next(e);
    }
  };
}

module.exports = { checkAndReserveQuota, refundQuota, logUsage, requireQuota };
