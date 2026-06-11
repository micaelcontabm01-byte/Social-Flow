require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool } = require('./lib/db');
const { requireAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const billingRoutes = require('./routes/billing');
const clientsRoutes = require('./routes/clients');
const personasRoutes = require('./routes/personas');
const scriptsRoutes = require('./routes/scripts');
const notificationsRoutes = require('./routes/notifications');
const carouselsRoutes = require('./routes/carousels');
const invitationsRoutes = require('./routes/invitations');
const dashboardRoutes = require('./routes/dashboard');
const planningRoutes = require('./routes/planning');
const ideasRoutes = require('./routes/ideas');
const brandingRoutes = require('./routes/branding');
const reportsRoutes = require('./routes/reports');
const integrationsRoutes = require('./routes/integrations');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (isProd) app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'sessions',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret-troque-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'socialflow', time: new Date().toISOString() });
});

// Keep-alive: cron diario faz uma consulta leve pra o projeto Supabase (Free)
// nao pausar por inatividade. SELECT 1 e inofensivo se chamado publicamente.
app.get('/api/cron/keep-alive', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/me', requireAuth, meRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/personas', personasRoutes);
app.use('/api/scripts', scriptsRoutes);
app.use('/api/notifications', requireAuth, notificationsRoutes);
app.use('/api/carousels', carouselsRoutes);
app.use('/api/invitations', invitationsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/planning', planningRoutes);
app.use('/api/ideas', ideasRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/integrations', integrationsRoutes);

// Vercel cron: hit GET com Authorization: Bearer $CRON_SECRET
app.get('/api/cron/monthly-reports', reportsRoutes.runMonthlyCron);
app.post('/api/cron/monthly-reports', reportsRoutes.runMonthlyCron);

app.use(express.static(path.join(__dirname, 'frontend'), {
  extensions: ['html'],
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SocialFlow rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
