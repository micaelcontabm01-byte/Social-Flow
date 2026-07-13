const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { mock } = test;

// Fila de respostas canonicas do "banco". Cada chamada a query()/c.query() dentro
// de tx() consome o proximo item, na mesma ordem em que routes/auth.js as dispara.
const responses = [];
function queue(...items) {
  responses.push(...items);
}
async function mockQuery() {
  if (responses.length === 0) throw new Error('nenhuma resposta mockada na fila - query inesperada');
  return responses.shift();
}
async function mockTx(fn) {
  return fn({ query: mockQuery });
}

// Especificador precisa ser relativo com extensao .js explicita - mock.module()
// resolve por regras de ESM internamente, mesmo mockando um modulo CJS. Um
// require.resolve() (caminho absoluto) ou sem extensao nao e interceptado.
mock.module('../lib/db.js', {
  exports: { query: mockQuery, tx: mockTx, pool: {} },
});

const { buildApp, listen } = require('../test-helpers/http');
const authRoutes = require('../routes/auth');

test.beforeEach(() => {
  responses.length = 0;
});

async function withServer(fn) {
  const app = buildApp(authRoutes, '/api/auth');
  const server = await listen(app);
  try {
    await fn(server.baseUrl);
  } finally {
    await server.close();
  }
}

test('POST /signup cria usuario + org quando email e novo', async () => {
  queue(
    { rowCount: 0, rows: [] }, // checagem de email existente
    { rows: [{ id: 'u1', name: 'Ana', email: 'ana@teste.com' }] }, // insert users
    { rows: [{ id: 'o1', name: 'Workspace de Ana' }] }, // insert organizations
    { rowCount: 1 }, // insert organization_members
  );

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', email: 'ana@teste.com', password: 'senha1234' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.user.email, 'ana@teste.com');
    assert.equal(body.organization.id, 'o1');
    assert.equal(responses.length, 0, 'todas as respostas mockadas deveriam ter sido consumidas');
  });
});

test('POST /signup rejeita email ja cadastrado com 409', async () => {
  queue({ rowCount: 1, rows: [{ id: 'existing' }] });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', email: 'ana@teste.com', password: 'senha1234' }),
    });
    assert.equal(res.status, 409);
  });
});

test('POST /signup rejeita senha curta com 400 antes de tocar no banco', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ana', email: 'ana@teste.com', password: '123' }),
    });
    assert.equal(res.status, 400);
    assert.equal(responses.length, 0, 'zod deveria rejeitar antes de qualquer query');
  });
});

test('POST /login autentica com credenciais corretas', async () => {
  const hash = bcrypt.hashSync('senha-correta', 4);
  queue(
    { rowCount: 1, rows: [{ id: 'u1', name: 'Ana', email: 'ana@teste.com', password_hash: hash }] },
    { rowCount: 1, rows: [{ organization_id: 'o1', role: 'owner', organization_name: 'Workspace de Ana' }] },
  );

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@teste.com', password: 'senha-correta' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.organization.role, 'owner');
  });
});

test('POST /login rejeita email inexistente com 401 (sem revelar o motivo)', async () => {
  queue({ rowCount: 0, rows: [] });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fantasma@teste.com', password: 'qualquer123' }),
    });
    const body = await res.json();
    assert.equal(res.status, 401);
    assert.equal(body.error, 'Credenciais invalidas');
  });
});

test('POST /login rejeita senha errada com 401 e nao consulta organizacao', async () => {
  const hash = bcrypt.hashSync('senha-correta', 4);
  queue({ rowCount: 1, rows: [{ id: 'u1', name: 'Ana', email: 'ana@teste.com', password_hash: hash }] });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@teste.com', password: 'senha-errada' }),
    });
    assert.equal(res.status, 401);
    assert.equal(responses.length, 0, 'nao deveria ter sobrado query de organizacao na fila');
  });
});
