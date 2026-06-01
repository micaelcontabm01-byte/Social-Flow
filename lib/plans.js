const PLANS = {
  none: {
    code: 'none',
    name: 'Sem plano',
    price_cents: 0,
    max_clients: 0,
    max_collaborators: 0,
    ia_quota_limit: 0,
    img_quota_limit: 0,
    lastlink_product_id: null,
    features: [],
  },
  solo: {
    code: 'solo',
    name: 'Solo',
    price_cents: 4700,
    max_clients: 1,
    max_collaborators: 0,
    ia_quota_limit: 40,
    img_quota_limit: 20,
    lastlink_product_id: process.env.LASTLINK_PRODUCT_SOLO || null,
    features: [
      '1 cliente',
      '40 gerações de IA por mês',
      'Persona + Roteiro completos',
      'Calendário de conteúdo',
    ],
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    price_cents: 9700,
    max_clients: 5,
    max_collaborators: 3,
    ia_quota_limit: 200,
    img_quota_limit: 100,
    lastlink_product_id: process.env.LASTLINK_PRODUCT_PRO || null,
    features: [
      '5 clientes',
      '3 colaboradores',
      '200 gerações de IA por mês',
      '100 imagens de capa com IA por mês',
      'Tudo do Solo',
      'Gerador de Carrossel',
      'Aprovação do cliente',
      'Logo da sua agência no painel dos clientes',
    ],
  },
  black: {
    code: 'black',
    name: 'BLACK',
    price_cents: 24700,
    max_clients: 15,
    max_collaborators: 10,
    ia_quota_limit: 1500,
    img_quota_limit: 400,
    lastlink_product_id: process.env.LASTLINK_PRODUCT_BLACK || null,
    features: [
      '15 clientes',
      '10 colaboradores',
      '1500 gerações de IA por mês',
      'Tudo do Pro',
      'Relatório mensal automatizado em PDF (por cliente)',
      'Suporte VIP com a Mary (grupo no WhatsApp)',
      'Dashboard exportável PDF',
    ],
  },
};

function getPlan(code) {
  return PLANS[code] || PLANS.none;
}

function listPlans() {
  return Object.values(PLANS).filter((p) => p.code !== 'none');
}

function findPlanByLastlinkProduct(productId) {
  if (!productId) return null;
  return Object.values(PLANS).find((p) => p.lastlink_product_id === productId) || null;
}

function formatPrice(cents) {
  const reais = cents / 100;
  return reais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

module.exports = { PLANS, getPlan, listPlans, findPlanByLastlinkProduct, formatPrice };
