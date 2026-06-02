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

// ===== Cota de IMAGEM (balde separado: img_quota_*) =====
// Imagem custa muito mais que texto, entao tem limite proprio por plano.
async function checkAndReserveImageQuota(orgId) {
  return await tx(async (c) => {
    const res = await c.query(
      `SELECT img_quota_limit, img_quota_used FROM organizations WHERE id = $1 FOR UPDATE`,
      [orgId]
    );
    if (res.rowCount === 0) {
      const e = new Error('Organizacao nao encontrada');
      e.code = 'ORG_NOT_FOUND';
      throw e;
    }
    const org = res.rows[0];
    if (org.img_quota_used >= org.img_quota_limit) {
      const e = new Error('Limite de geracao de imagem atingido neste ciclo');
      e.code = 'IMG_QUOTA_EXCEEDED';
      e.quota = { used: org.img_quota_used, limit: org.img_quota_limit };
      throw e;
    }
    await c.query(
      `UPDATE organizations SET img_quota_used = img_quota_used + 1 WHERE id = $1`,
      [orgId]
    );
    return {
      used: org.img_quota_used + 1,
      limit: org.img_quota_limit,
      remaining: org.img_quota_limit - org.img_quota_used - 1,
    };
  });
}

async function refundImageQuota(orgId) {
  await query(
    `UPDATE organizations SET img_quota_used = greatest(0, img_quota_used - 1) WHERE id = $1`,
    [orgId]
  );
}

// Le a cota de imagem sem reservar (pra pre-checar antes de gerar).
async function peekImageQuota(orgId) {
  const r = await query(
    `SELECT img_quota_limit, img_quota_used FROM organizations WHERE id = $1`,
    [orgId]
  );
  if (r.rowCount === 0) { const e = new Error('Org nao encontrada'); e.code = 'ORG_NOT_FOUND'; throw e; }
  const o = r.rows[0];
  return { used: o.img_quota_used, limit: o.img_quota_limit, remaining: Math.max(0, o.img_quota_limit - o.img_quota_used) };
}

// Debita N imagens APOS a geracao (so cobra o que realmente gerou).
// Usa greatest/least pra nunca passar do limite mesmo com concorrencia.
async function debitImageQuotaN(orgId, n) {
  if (!n || n <= 0) return null;
  const r = await query(
    `UPDATE organizations
        SET img_quota_used = least(img_quota_limit, img_quota_used + $2)
      WHERE id = $1
      RETURNING img_quota_used AS used, img_quota_limit AS limit`,
    [orgId, n]
  );
  const o = r.rows[0] || {};
  return { used: o.used, limit: o.limit, remaining: Math.max(0, (o.limit || 0) - (o.used || 0)) };
}

// Reserva N imagens de uma vez (tudo-ou-nada). Usado quando o carrossel gera
// uma imagem por slide. Lanca IMG_QUOTA_EXCEEDED se nao couber.
async function reserveImageQuotaN(orgId, n) {
  return await tx(async (c) => {
    const res = await c.query(
      `SELECT img_quota_limit, img_quota_used FROM organizations WHERE id = $1 FOR UPDATE`,
      [orgId]
    );
    if (res.rowCount === 0) {
      const e = new Error('Organizacao nao encontrada');
      e.code = 'ORG_NOT_FOUND';
      throw e;
    }
    const org = res.rows[0];
    const remaining = org.img_quota_limit - org.img_quota_used;
    if (remaining < n) {
      const e = new Error('Cota de imagem insuficiente');
      e.code = 'IMG_QUOTA_EXCEEDED';
      e.remaining = Math.max(0, remaining);
      e.quota = { used: org.img_quota_used, limit: org.img_quota_limit };
      throw e;
    }
    await c.query(
      `UPDATE organizations SET img_quota_used = img_quota_used + $2 WHERE id = $1`,
      [orgId, n]
    );
    return {
      used: org.img_quota_used + n,
      limit: org.img_quota_limit,
      remaining: org.img_quota_limit - org.img_quota_used - n,
    };
  });
}

async function refundImageQuotaN(orgId, n) {
  await query(
    `UPDATE organizations SET img_quota_used = greatest(0, img_quota_used - $2) WHERE id = $1`,
    [orgId, n]
  );
}

function requireImageQuota() {
  return async (req, res, next) => {
    try {
      const reservation = await checkAndReserveImageQuota(req.session.currentOrgId);
      req.imgQuota = reservation;
      next();
    } catch (e) {
      if (e.code === 'IMG_QUOTA_EXCEEDED') {
        return res.status(429).json({
          error: 'Limite de geracao de imagem atingido neste ciclo. Faca upgrade do plano para gerar mais.',
          quota: e.quota,
        });
      }
      next(e);
    }
  };
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

module.exports = {
  checkAndReserveQuota, refundQuota, logUsage, requireQuota,
  checkAndReserveImageQuota, refundImageQuota, requireImageQuota,
  reserveImageQuotaN, refundImageQuotaN, peekImageQuota, debitImageQuotaN,
};
