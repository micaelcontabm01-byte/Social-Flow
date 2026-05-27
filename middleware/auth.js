function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Nao autenticado' });
  }
  next();
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Nao autenticado' });
    if (!allowed.includes(req.session.role)) {
      return res.status(403).json({ error: 'Sem permissao' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
