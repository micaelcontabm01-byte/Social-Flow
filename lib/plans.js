const PLANS = {
  free: {
    code: 'free',
    name: 'Free',
    price_cents: 0,
    max_clients: 1,
    max_collaborators: 0,
    ia_quota_limit: 10,
    lastlink_product_id: null,
    features: [
      '1 cliente',
      '10 gerações de IA por mês',
      'Persona + Roteiro básicos',
    ],
  },
  starter: {
    code: 'starter',
    name: 'Starter',
    price_cents: 4990,
    max_clients: 2,
    max_collaborators: 1,
    ia_quota_limit: 50,
    lastlink_product_id: process.env.LASTLINK_PRODUCT_STARTER || null,
    features: [
      '2 clientes',
      '1 colaborador',
      '50 gerações de IA por mês',
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
    ia_quota_limit: 150,
    lastlink_product_id: process.env.LASTLINK_PRODUCT_PRO || null,
    features: [
      '5 clientes',
      '3 colaboradores',
      '150 gerações de IA por mês',
      'Tudo do Starter',
      'Gerador de Carrossel',
      'Aprovação do cliente',
    ],
  },
  agency: {
    code: 'agency',
    name: 'Agency',
    price_cents: 19700,
    max_clients: 15,
    max_collaborators: 10,
    ia_quota_limit: 1500,
    lastlink_product_id: process.env.LASTLINK_PRODUCT_AGENCY || null,
    features: [
      '15 clientes',
      '10 colaboradores',
      '1500 gerações de IA por mês',
      'Tudo do Pro',
      'Dashboard exportavel PDF',
      'Suporte prioritário',
    ],
  },
};

function getPlan(code) {
  return PLANS[code] || PLANS.free;
}

function listPlans() {
  return Object.values(PLANS);
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
