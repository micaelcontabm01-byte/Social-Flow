const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;

// Nomes de env var que lib/plans.js le UMA VEZ, no require (ver findPlanByLastlinkProduct).
// Fixar aqui trava o contrato solo/pro/black - se alguem renomear a env var no codigo
// sem atualizar aqui (ou vice-versa), o teste de "unmapped_product" abaixo quebra.
process.env.LASTLINK_PRODUCT_SOLO = 'prod_solo_123';
process.env.LASTLINK_PRODUCT_PRO = 'prod_pro_123';
process.env.LASTLINK_PRODUCT_BLACK = 'prod_black_123';

// Mock de banco por "cenario" mutavel: cada teste ajusta `scenario` antes de chamar
// processWebhook(), evitando acoplar os testes a ordem exata das queries internas.
let scenario = {};
async function query(rawText) {
  const t = rawText.replace(/\s+/g, ' ').trim();
  if (t.startsWith('SELECT id, processed_at FROM webhook_events')) {
    return scenario.idempotent
      ? { rowCount: 1, rows: [{ id: 'we1', processed_at: new Date() }] }
      : { rowCount: 0, rows: [] };
  }
  if (t.startsWith('INSERT INTO webhook_events')) return { rowCount: 1 };
  if (t.includes('FROM users u') && t.includes('organization_members m')) {
    return scenario.userFound
      ? { rowCount: 1, rows: [{ user_id: 'u1', org_id: 'o1' }] }
      : { rowCount: 0, rows: [] };
  }
  if (t.startsWith('SELECT plan_code FROM organizations')) {
    return { rows: [{ plan_code: scenario.previousPlan || 'none' }] };
  }
  if (t.startsWith('UPDATE webhook_events SET processed_at')) return { rowCount: 1 };
  throw new Error(`query inesperada no mock: ${t}`);
}
async function tx(fn) {
  const client = {
    query: async (rawText) => {
      const t = rawText.replace(/\s+/g, ' ').trim();
      if (t.startsWith('SELECT id FROM subscriptions WHERE gateway')) return { rowCount: 0, rows: [] };
      if (t.startsWith('INSERT INTO subscriptions') || t.startsWith('UPDATE subscriptions')) return { rowCount: 1 };
      if (t.startsWith('UPDATE organizations SET plan_code')) return { rowCount: 1 };
      throw new Error(`tx query inesperada no mock: ${t}`);
    },
  };
  return fn(client);
}
// Ver comentario equivalente em test/auth.test.js sobre o formato do especificador.
mock.module('../lib/db.js', { exports: { query, tx, pool: {} } });

const {
  processWebhook,
  verifyWebhookToken,
  extractEventInfo,
  mapEventToStatus,
} = require('../lib/lastlink');

test.beforeEach(() => {
  scenario = { idempotent: false, userFound: true, previousPlan: 'none' };
  delete process.env.LASTLINK_WEBHOOK_SECRET;
});

// ---- verifyWebhookToken ----

test('verifyWebhookToken aceita qualquer coisa se o secret nao estiver configurado', () => {
  assert.equal(verifyWebhookToken(undefined), true);
  assert.equal(verifyWebhookToken('lixo'), true);
});

test('verifyWebhookToken valida o token exato quando o secret esta configurado', () => {
  process.env.LASTLINK_WEBHOOK_SECRET = 'meu-segredo';
  assert.equal(verifyWebhookToken('meu-segredo'), true);
  assert.equal(verifyWebhookToken('token-errado'), false);
  assert.equal(verifyWebhookToken(undefined), false);
});

// ---- extractEventInfo ----

test('extractEventInfo le o formato real da Lastlink (chaves capitalizadas)', () => {
  const info = extractEventInfo({
    Id: 'evt_123',
    Event: 'Purchase_Order_Confirmed',
    Data: {
      Customer: { Email: ' Cliente@Teste.COM ', Name: 'Cliente Teste', Id: 'cust_1' },
      Products: [{ Id: 'prod_pro_123' }],
      Subscriptions: [{ Id: 'sub_1', Status: 'Active' }],
    },
  });
  assert.equal(info.event, 'Purchase_Order_Confirmed');
  assert.equal(info.customerEmail, 'cliente@teste.com');
  assert.equal(info.customerName, 'Cliente Teste');
  assert.equal(info.customerId, 'cust_1');
  assert.deepEqual(info.productIds, ['prod_pro_123']);
  assert.equal(info.subscriptionId, 'sub_1');
  assert.equal(info.subscriptionStatus, 'Active');
  assert.equal(info.eventId, 'evt_123');
});

test('extractEventInfo aceita fallback em chaves minusculas e gera eventId se faltar', () => {
  const info = extractEventInfo({
    event: 'subscription_canceled',
    data: { customer: { email: 'foo@bar.com' }, products: [{ id: 'prod_solo_123' }] },
  });
  assert.equal(info.event, 'subscription_canceled');
  assert.equal(info.customerEmail, 'foo@bar.com');
  assert.deepEqual(info.productIds, ['prod_solo_123']);
  assert.equal(typeof info.eventId, 'string');
  assert.ok(info.eventId.length > 0);
});

// ---- mapEventToStatus ----

test('mapEventToStatus mapeia eventos da Lastlink pro status interno', () => {
  assert.equal(mapEventToStatus('Purchase_Order_Confirmed'), 'active');
  assert.equal(mapEventToStatus('subscription_canceled'), 'canceled');
  assert.equal(mapEventToStatus('payment_chargeback'), 'canceled');
  assert.equal(mapEventToStatus('payment_refunded'), 'canceled');
  assert.equal(mapEventToStatus('payment_expired'), 'past_due');
  assert.equal(mapEventToStatus('trial_started'), 'trialing');
  assert.equal(mapEventToStatus('subscription_paused'), 'paused');
  assert.equal(mapEventToStatus('evento_desconhecido_qualquer'), 'active');
  assert.equal(mapEventToStatus(undefined), 'active');
});

// ---- processWebhook (caminho do dinheiro) ----

function payload({ productId = 'prod_pro_123', email = 'ana@teste.com', event = 'Purchase_Order_Confirmed' } = {}) {
  return {
    Id: `evt_${Math.random().toString(36).slice(2)}`,
    Event: event,
    Data: {
      Customer: { Email: email, Name: 'Ana' },
      Products: [{ Id: productId }],
      Subscriptions: [{ Id: 'sub_1' }],
    },
  };
}

test('processWebhook rejeita token invalido sem tocar no banco', async () => {
  process.env.LASTLINK_WEBHOOK_SECRET = 'segredo-certo';
  await assert.rejects(
    () => processWebhook(payload(), { 'x-lastlink-token': 'segredo-errado' }),
    (err) => err.code === 'INVALID_TOKEN'
  );
});

test('processWebhook ativa o plano quando o produto e conhecido e o usuario existe', async () => {
  const result = await processWebhook(payload({ productId: 'prod_pro_123' }), {});
  assert.equal(result.ok, true);
  assert.equal(result.plan, 'pro');
  assert.equal(result.status, 'active');
  assert.equal(result.organization_id, 'o1');
});

test('processWebhook retorna unmapped_product quando o produto nao bate com nenhum plano', async () => {
  const result = await processWebhook(payload({ productId: 'prod_inexistente' }), {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unmapped_product');
});
