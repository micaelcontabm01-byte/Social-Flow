const test = require('node:test');
const assert = require('node:assert/strict');

// lib/plans.js le essas env vars UMA VEZ, no momento do require - por isso ficam
// fixadas aqui antes do require abaixo. Isso trava o contrato de nomes que o
// webhook da Lastlink depende (ver test/lastlink.test.js e memoria do projeto:
// os planos foram renomeados starter/agency -> solo/black em 2026-05-27).
process.env.LASTLINK_PRODUCT_SOLO = 'prod_solo_123';
process.env.LASTLINK_PRODUCT_PRO = 'prod_pro_123';
process.env.LASTLINK_PRODUCT_BLACK = 'prod_black_123';

const { getPlan, listPlans, findPlanByLastlinkProduct, formatPrice } = require('../lib/plans');

test('getPlan retorna os limites certos por codigo de plano', () => {
  assert.equal(getPlan('solo').max_clients, 1);
  assert.equal(getPlan('pro').max_clients, 5);
  assert.equal(getPlan('black').max_clients, 15);
});

test('getPlan cai para o plano "none" em codigo desconhecido ou ausente', () => {
  assert.equal(getPlan('plano-que-nao-existe').code, 'none');
  assert.equal(getPlan(undefined).code, 'none');
});

test('findPlanByLastlinkProduct casa o product id configurado por env var com o plano certo', () => {
  assert.equal(findPlanByLastlinkProduct('prod_solo_123').code, 'solo');
  assert.equal(findPlanByLastlinkProduct('prod_pro_123').code, 'pro');
  assert.equal(findPlanByLastlinkProduct('prod_black_123').code, 'black');
});

test('findPlanByLastlinkProduct retorna null pra produto desconhecido ou ausente', () => {
  assert.equal(findPlanByLastlinkProduct('prod_inexistente'), null);
  assert.equal(findPlanByLastlinkProduct(null), null);
  assert.equal(findPlanByLastlinkProduct(undefined), null);
});

test('listPlans exclui o plano "none"', () => {
  const codes = listPlans().map((p) => p.code);
  assert.ok(!codes.includes('none'));
  assert.deepEqual(codes.sort(), ['black', 'pro', 'solo']);
});

test('formatPrice formata centavos como BRL', () => {
  assert.match(formatPrice(4700), /R\$\s*47,00/);
});
