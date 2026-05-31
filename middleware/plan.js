const { query } = require('../lib/db');

// Hierarquia: none < solo < pro < black
const PLAN_RANK = { none: 0, solo: 1, pro: 2, black: 3 };

async function getOrgPlanCode(orgId) {
  const r = await query('SELECT plan_code FROM organizations WHERE id = $1', [orgId]);
  return r.rows[0]?.plan_code || 'none';
}

function requireMinPlan(minPlan) {
  const minRank = PLAN_RANK[minPlan];
  if (minRank === undefined) throw new Error(`Plano desconhecido: ${minPlan}`);
  return async (req, res, next) => {
    try {
      if (!req.session?.currentOrgId) {
        return res.status(401).json({ error: 'Nao autenticado' });
      }
      const code = await getOrgPlanCode(req.session.currentOrgId);
      const rank = PLAN_RANK[code] ?? 0;
      if (rank < minRank) {
        return res.status(402).json({
          error: 'Plano insuficiente',
          required_plan: minPlan,
          current_plan: code,
        });
      }
      req.currentPlan = code;
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { requireMinPlan, getOrgPlanCode, PLAN_RANK };
