const { query } = require('../lib/db');

async function requireOrgAccess(req, res, next) {
  try {
    if (!req.session?.currentOrgId) {
      return res.status(401).json({ error: 'Sem organizacao no contexto' });
    }
    const res2 = await query(
      `SELECT role, client_id FROM organization_members
       WHERE organization_id = $1 AND user_id = $2`,
      [req.session.currentOrgId, req.session.userId]
    );
    if (res2.rowCount === 0) {
      return res.status(403).json({ error: 'Sem acesso a essa organizacao' });
    }
    req.orgId = req.session.currentOrgId;
    req.role = res2.rows[0].role;
    req.memberClientId = res2.rows[0].client_id;
    next();
  } catch (err) { next(err); }
}

function enforceClientScope(req, res, next) {
  if (req.role === 'client' && !req.memberClientId) {
    return res.status(403).json({ error: 'Usuario cliente sem vinculo' });
  }
  next();
}

function requireOrgRole(...allowed) {
  return (req, res, next) => {
    if (!req.role || !allowed.includes(req.role)) {
      return res.status(403).json({ error: 'Acao restrita a ' + allowed.join('/') });
    }
    next();
  };
}

async function checkClientLimit(orgId) {
  const r = await query(
    `SELECT
       (SELECT count(*) FROM clients WHERE organization_id = $1 AND archived = false) AS used,
       (SELECT max_clients FROM organizations WHERE id = $1) AS limite`,
    [orgId]
  );
  const { used, limite } = r.rows[0];
  if (Number(used) >= Number(limite)) {
    const e = new Error(`Limite de ${limite} cliente(s) atingido no plano atual`);
    e.code = 'CLIENT_LIMIT_REACHED';
    e.used = Number(used);
    e.limit = Number(limite);
    throw e;
  }
  return { used: Number(used), limit: Number(limite) };
}

module.exports = { requireOrgAccess, requireOrgRole, enforceClientScope, checkClientLimit };
