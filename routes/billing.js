const express = require('express');
const { query } = require('../lib/db');
const { listPlans, getPlan, formatPrice } = require('../lib/plans');
const { processWebhook } = require('../lib/lastlink');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/plans', (req, res) => {
  const plans = listPlans().map((p) => ({
    code: p.code,
    name: p.name,
    price_cents: p.price_cents,
    price_formatted: formatPrice(p.price_cents),
    max_clients: p.max_clients,
    max_collaborators: p.max_collaborators,
    ia_quota_limit: p.ia_quota_limit,
    features: p.features,
  }));
  res.json({ plans });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const orgRes = await query(
      `SELECT id, plan_code, max_clients, max_collaborators, ia_quota_limit, ia_quota_used, ia_quota_reset_at
       FROM organizations WHERE id = $1`,
      [req.session.currentOrgId]
    );
    if (orgRes.rowCount === 0) return res.status(404).json({ error: 'Organizacao nao encontrada' });
    const org = orgRes.rows[0];

    const subRes = await query(
      `SELECT id, plan_code, status, gateway, current_period_end, amount_cents, created_at
       FROM subscriptions
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.session.currentOrgId]
    );

    const plan = getPlan(org.plan_code);

    res.json({
      organization: {
        id: org.id,
        plan_code: org.plan_code,
        plan_name: plan.name,
        max_clients: org.max_clients,
        max_collaborators: org.max_collaborators,
        ia_quota_limit: org.ia_quota_limit,
        ia_quota_used: org.ia_quota_used,
        ia_quota_reset_at: org.ia_quota_reset_at,
      },
      subscription: subRes.rows[0] || null,
    });
  } catch (err) { next(err); }
});

router.get('/checkout/:plan', requireAuth, async (req, res, next) => {
  try {
    const plan = getPlan(req.params.plan);
    if (!plan || plan.code === 'none') {
      return res.status(400).send('Plano invalido');
    }
    const url = process.env[`LASTLINK_CHECKOUT_${plan.code.toUpperCase()}`];
    if (!url) {
      return res.status(503).send(
        `Checkout do plano ${plan.name} ainda nao configurado. ` +
        `Configure LASTLINK_CHECKOUT_${plan.code.toUpperCase()} no .env`
      );
    }
    const userRes = await query('SELECT email, name FROM users WHERE id = $1', [req.session.userId]);
    const user = userRes.rows[0];
    const sep = url.includes('?') ? '&' : '?';
    const finalUrl = `${url}${sep}email=${encodeURIComponent(user.email)}&name=${encodeURIComponent(user.name)}`;
    res.redirect(finalUrl);
  } catch (err) { next(err); }
});

router.post('/webhook/lastlink', async (req, res) => {
  try {
    const result = await processWebhook(req.body, req.headers);
    return res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_TOKEN') {
      console.warn('[lastlink-webhook] token invalido');
      return res.status(401).json({ error: 'Token invalido' });
    }
    console.error('[lastlink-webhook] erro:', err);
    return res.status(500).json({ error: 'Erro processando webhook' });
  }
});

module.exports = router;
