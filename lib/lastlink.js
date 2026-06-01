const crypto = require('crypto');
const { tx, query } = require('./db');
const { findPlanByLastlinkProduct, getPlan } = require('./plans');
const { sendEmail, templates, APP_URL } = require('./email');

function verifyWebhookToken(headerToken) {
  const expected = process.env.LASTLINK_WEBHOOK_SECRET;
  if (!expected) {
    console.warn('[lastlink] LASTLINK_WEBHOOK_SECRET nao configurado - aceitando qualquer webhook');
    return true;
  }
  if (!headerToken) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(String(headerToken)),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

function extractEventInfo(payload) {
  const event = payload?.Event || payload?.event || null;
  const data = payload?.Data || payload?.data || {};
  const customer = data?.Customer || data?.customer || {};
  const products = data?.Products || data?.products || [];
  const subscriptions = data?.Subscriptions || data?.subscriptions || [];

  const productIds = products
    .flatMap((p) => [p?.Id, p?.id, p?.ProductId, p?.product_id])
    .filter(Boolean);

  return {
    event,
    customerEmail: (customer.Email || customer.email || '').toLowerCase().trim() || null,
    customerName: customer.Name || customer.name || null,
    customerId: customer.Id || customer.id || customer.CustomerId || customer.customer_id || null,
    productIds,
    subscriptionId: subscriptions[0]?.Id || subscriptions[0]?.id || data?.SubscriptionId || data?.subscription_id || null,
    subscriptionStatus: subscriptions[0]?.Status || subscriptions[0]?.status || data?.Status || data?.status || null,
    eventId: payload?.Id || payload?.id || payload?.EventId || payload?.event_id || crypto.randomUUID(),
  };
}

function mapEventToStatus(eventName) {
  const e = String(eventName || '').toLowerCase();
  if (e.includes('confirm') || e.includes('approved') || e.includes('paid') || e.includes('active')) return 'active';
  if (e.includes('cancel')) return 'canceled';
  if (e.includes('refund') || e.includes('charged_back') || e.includes('chargeback')) return 'canceled';
  if (e.includes('past_due') || e.includes('overdue') || e.includes('expired')) return 'past_due';
  if (e.includes('trial')) return 'trialing';
  if (e.includes('paused')) return 'paused';
  return 'active';
}

async function processWebhook(rawPayload, headers) {
  const token = headers['x-lastlink-token'] || headers['X-Lastlink-Token'] || null;
  if (!verifyWebhookToken(token)) {
    const err = new Error('Token invalido');
    err.code = 'INVALID_TOKEN';
    throw err;
  }

  const info = extractEventInfo(rawPayload);

  // Idempotencia
  const existing = await query(
    `SELECT id, processed_at FROM webhook_events WHERE gateway = 'lastlink' AND event_id = $1`,
    [info.eventId]
  );
  if (existing.rowCount > 0 && existing.rows[0].processed_at) {
    return { ok: true, idempotent: true, info };
  }

  // Salva o evento bruto
  await query(
    `INSERT INTO webhook_events (gateway, event_id, event_type, payload)
     VALUES ('lastlink', $1, $2, $3)
     ON CONFLICT (gateway, event_id) DO NOTHING`,
    [info.eventId, info.event, rawPayload]
  );

  // Encontra plano pelo produto
  let plan = null;
  for (const pid of info.productIds) {
    const found = findPlanByLastlinkProduct(pid);
    if (found) { plan = found; break; }
  }

  if (!plan) {
    await query(
      `UPDATE webhook_events SET processed_at = now(), error = $2 WHERE gateway = 'lastlink' AND event_id = $1`,
      [info.eventId, 'Produto nao mapeado para plano']
    );
    return { ok: false, reason: 'unmapped_product', info };
  }

  // Encontra organizacao pelo email do cliente
  if (!info.customerEmail) {
    await query(
      `UPDATE webhook_events SET processed_at = now(), error = $2 WHERE gateway = 'lastlink' AND event_id = $1`,
      [info.eventId, 'Email do cliente ausente']
    );
    return { ok: false, reason: 'no_email', info };
  }

  const userRes = await query(
    `SELECT u.id as user_id, o.id as org_id
     FROM users u
     JOIN organization_members m ON m.user_id = u.id AND m.role = 'owner'
     JOIN organizations o ON o.id = m.organization_id
     WHERE u.email = $1
     ORDER BY m.created_at ASC
     LIMIT 1`,
    [info.customerEmail]
  );

  if (userRes.rowCount === 0) {
    // Comprou mas nao tem conta ainda - salva subscription pendente vinculada por email
    await query(
      `INSERT INTO subscriptions (organization_id, plan_code, status, gateway, gateway_subscription_id, gateway_customer_id, gateway_customer_email, amount_cents, raw_data)
       SELECT id, $1, $2, 'lastlink', $3, $4, $5, $6, $7 FROM organizations WHERE 1=0`,
      [plan.code, 'active', info.subscriptionId, info.customerId, info.customerEmail, plan.price_cents, rawPayload]
    );
    await query(
      `UPDATE webhook_events SET processed_at = now(), error = $2 WHERE gateway = 'lastlink' AND event_id = $1`,
      [info.eventId, 'Usuario sem conta - subscription pendente']
    );
    return { ok: true, pending: true, info, plan: plan.code };
  }

  const { org_id: orgId } = userRes.rows[0];
  const status = mapEventToStatus(info.event);

  // Detecta upgrade para BLACK pra disparar boas-vindas
  const previousPlanRes = await query(`SELECT plan_code FROM organizations WHERE id = $1`, [orgId]);
  const previousPlan = previousPlanRes.rows[0]?.plan_code || 'none';
  const becomingBlack = plan.code === 'black'
    && previousPlan !== 'black'
    && (status === 'active' || status === 'trialing');

  await tx(async (c) => {
    // Upsert subscription
    if (info.subscriptionId) {
      const existingSub = await c.query(
        `SELECT id FROM subscriptions WHERE gateway = 'lastlink' AND gateway_subscription_id = $1`,
        [info.subscriptionId]
      );
      if (existingSub.rowCount > 0) {
        await c.query(
          `UPDATE subscriptions
           SET plan_code = $1, status = $2, amount_cents = $3, raw_data = $4, updated_at = now(),
               canceled_at = case when $2 = 'canceled' then now() else canceled_at end
           WHERE id = $5`,
          [plan.code, status, plan.price_cents, rawPayload, existingSub.rows[0].id]
        );
      } else {
        await c.query(
          `INSERT INTO subscriptions (organization_id, plan_code, status, gateway, gateway_subscription_id, gateway_customer_id, gateway_customer_email, amount_cents, raw_data)
           VALUES ($1, $2, $3, 'lastlink', $4, $5, $6, $7, $8)`,
          [orgId, plan.code, status, info.subscriptionId, info.customerId, info.customerEmail, plan.price_cents, rawPayload]
        );
      }
    } else {
      await c.query(
        `INSERT INTO subscriptions (organization_id, plan_code, status, gateway, gateway_customer_id, gateway_customer_email, amount_cents, raw_data)
         VALUES ($1, $2, $3, 'lastlink', $4, $5, $6, $7)`,
        [orgId, plan.code, status, info.customerId, info.customerEmail, plan.price_cents, rawPayload]
      );
    }

    // Atualiza limites da org se assinatura ativa
    if (status === 'active' || status === 'trialing') {
      await c.query(
        `UPDATE organizations
         SET plan_code = $1, max_clients = $2, max_collaborators = $3, ia_quota_limit = $4, img_quota_limit = $5, updated_at = now()
         WHERE id = $6`,
        [plan.code, plan.max_clients, plan.max_collaborators, plan.ia_quota_limit, plan.img_quota_limit || 0, orgId]
      );
    } else if (status === 'canceled' || status === 'past_due') {
      const none = getPlan('none');
      await c.query(
        `UPDATE organizations
         SET plan_code = 'none', max_clients = $1, max_collaborators = $2, ia_quota_limit = $3, img_quota_limit = $4, updated_at = now()
         WHERE id = $5`,
        [none.max_clients, none.max_collaborators, none.ia_quota_limit, none.img_quota_limit || 0, orgId]
      );
    }
  });

  await query(
    `UPDATE webhook_events SET processed_at = now() WHERE gateway = 'lastlink' AND event_id = $1`,
    [info.eventId]
  );

  // Email de boas-vindas BLACK (best-effort, nao falha o webhook se der erro)
  if (becomingBlack) {
    try {
      const tmpl = templates.blackWelcome({
        name: info.customerName || 'parceiro',
        whatsappGroupUrl: process.env.BLACK_WHATSAPP_GROUP_URL || null,
        billingUrl: `${APP_URL}/dashboard`,
      });
      await sendEmail({ to: info.customerEmail, subject: tmpl.subject, html: tmpl.html, text: tmpl.text });
    } catch (e) {
      console.error('[lastlink] falha enviar email de boas-vindas BLACK:', e.message);
    }
  }

  return { ok: true, info, plan: plan.code, status, organization_id: orgId, became_black: becomingBlack };
}

module.exports = { processWebhook, verifyWebhookToken, extractEventInfo, mapEventToStatus };
