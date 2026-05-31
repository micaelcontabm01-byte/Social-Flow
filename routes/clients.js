const express = require('express');
const { z } = require('zod');
const { query } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { requireOrgAccess, requireOrgRole, checkClientLimit } = require('../middleware/tenant');
const drive = require('../lib/drive');
const { getFreshGoogleToken } = require('../lib/integrations');

const router = express.Router();
router.use(requireAuth, requireOrgAccess);

const clientSchema = z.object({
  name: z.string().min(2).max(120),
  niche: z.string().max(200).optional().nullable(),
  instagram_handle: z.string().max(50).optional().nullable(),
  drive_folder_url: z.string().url().max(500).optional().nullable().or(z.literal('')),
  drive_folder_id: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

router.get('/', async (req, res, next) => {
  try {
    const filters = ['c.organization_id = $1', 'c.archived = false'];
    const values = [req.orgId];
    if (req.role === 'client') {
      if (!req.memberClientId) return res.json({ clients: [] });
      filters.push(`c.id = $${values.length + 1}`);
      values.push(req.memberClientId);
    }
    const r = await query(
      `SELECT c.id, c.name, c.niche, c.instagram_handle, c.drive_folder_url, c.notes,
              c.created_at, c.updated_at,
              (SELECT count(*) FROM personas WHERE client_id = c.id) AS personas_count
       FROM clients c
       WHERE ${filters.join(' AND ')}
       ORDER BY c.created_at DESC`,
      values
    );
    res.json({ clients: r.rows });
  } catch (err) { next(err); }
});

router.post('/', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = clientSchema.parse(req.body);
    await checkClientLimit(req.orgId);
    const r = await query(
      `INSERT INTO clients (organization_id, name, niche, instagram_handle, drive_folder_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.orgId,
        data.name,
        data.niche || null,
        (data.instagram_handle || '').replace(/^@/, '') || null,
        data.drive_folder_url || null,
        data.notes || null,
      ]
    );
    res.status(201).json({ client: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    if (err.code === 'CLIENT_LIMIT_REACHED') {
      return res.status(402).json({ error: err.message, used: err.used, limit: err.limit });
    }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (req.role === 'client' && req.params.id !== req.memberClientId) {
      return res.status(403).json({ error: 'Sem acesso a esse cliente' });
    }
    const r = await query(
      `SELECT * FROM clients WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json({ client: r.rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const data = clientSchema.partial().parse(req.body);
    const fields = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(data)) {
      fields.push(`${k} = $${i++}`);
      values.push(k === 'instagram_handle' && v ? v.replace(/^@/, '') : (v || null));
    }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.orgId);
    const r = await query(
      `UPDATE clients SET ${fields.join(', ')}
       WHERE id = $${i++} AND organization_id = $${i}
       RETURNING *`,
      values
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json({ client: r.rows[0] });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors });
    next(err);
  }
});

// Cria (ou reaproveita) uma subpasta no Drive com o nome do cliente, dentro da
// pasta "SocialFlow". Salva folder_id + url no cliente. Requer Google conectado.
router.post('/:id/drive/folder', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const cr = await query(
      `SELECT id, name FROM clients WHERE id = $1 AND organization_id = $2`,
      [req.params.id, req.orgId]
    );
    if (cr.rowCount === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });
    const client = cr.rows[0];

    const integ = await getFreshGoogleToken(req.orgId);
    if (!integ) return res.status(409).json({ error: 'Conecte sua conta do Google Drive em Configuracoes primeiro.' });

    // Garante a pasta-mae SocialFlow (usa a salva na config ou cria).
    let parentId = integ.config?.folder_id;
    if (!parentId) {
      const parent = await drive.ensureFolder(integ.access_token, 'SocialFlow');
      parentId = parent.id;
    }
    const sub = await drive.ensureFolder(integ.access_token, client.name, parentId);

    const url = sub.webViewLink || `https://drive.google.com/drive/folders/${sub.id}`;
    await query(
      `UPDATE clients SET drive_folder_id = $1, drive_folder_url = $2, updated_at = now()
         WHERE id = $3 AND organization_id = $4`,
      [sub.id, url, client.id, req.orgId]
    );
    res.json({ ok: true, folder_id: sub.id, folder_url: url });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/:id', requireOrgRole('owner', 'collaborator'), async (req, res, next) => {
  try {
    const r = await query(
      `UPDATE clients SET archived = true, updated_at = now()
       WHERE id = $1 AND organization_id = $2 AND archived = false
       RETURNING id`,
      [req.params.id, req.orgId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/:id/personas', async (req, res, next) => {
  try {
    if (req.role === 'client' && req.params.id !== req.memberClientId) {
      return res.status(403).json({ error: 'Sem acesso' });
    }
    const r = await query(
      `SELECT p.* FROM personas p
       JOIN clients c ON c.id = p.client_id
       WHERE p.client_id = $1 AND c.organization_id = $2
       ORDER BY p.created_at DESC`,
      [req.params.id, req.orgId]
    );
    res.json({ personas: r.rows });
  } catch (err) { next(err); }
});

module.exports = router;
