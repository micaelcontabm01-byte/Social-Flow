const express = require('express');
const { query } = require('../lib/db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT id, kind, title, body, link, read_at, created_at, metadata
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.session.userId]
    );
    const unread = await query(
      `SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.session.userId]
    );
    res.json({ notifications: r.rows, unread: unread.rows[0].unread });
  } catch (err) { next(err); }
});

router.post('/mark-read', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) && req.body.ids.length > 0
      ? req.body.ids
      : null;
    if (ids) {
      await query(
        `UPDATE notifications SET read_at = now()
         WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
        [req.session.userId, ids]
      );
    } else {
      await query(
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
        [req.session.userId]
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
