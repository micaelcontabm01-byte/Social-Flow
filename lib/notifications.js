const { query } = require('./db');
const { sendEmail, APP_URL } = require('./email');

async function notify({ organizationId, userId, kind, title, body, link, metadata, email }) {
  try {
    const r = await query(
      `INSERT INTO notifications (organization_id, user_id, kind, title, body, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [organizationId, userId, kind, title, body || null, link || null, metadata ? JSON.stringify(metadata) : null]
    );
    const notifId = r.rows[0].id;
    if (email) {
      try {
        const result = await sendEmail(email);
        if (result?.id || result?.simulated) {
          await query(`UPDATE notifications SET email_sent_at = now() WHERE id = $1`, [notifId]);
        }
      } catch (e) {
        console.error('[notify] email failed:', e.message);
      }
    }
    return notifId;
  } catch (e) {
    console.error('[notify] insert failed:', e.message);
    return null;
  }
}

async function notifyClientUsers(orgId, clientId, payload, emailTemplate) {
  const r = await query(
    `SELECT u.id, u.email, u.name
     FROM organization_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.role = 'client' AND m.client_id = $2`,
    [orgId, clientId]
  );
  for (const u of r.rows) {
    await notify({
      organizationId: orgId,
      userId: u.id,
      kind: payload.kind,
      title: payload.title,
      body: payload.body,
      link: payload.link,
      metadata: payload.metadata,
      email: emailTemplate ? { to: u.email, ...emailTemplate } : null,
    });
  }
  return r.rows.length;
}

async function notifyOwnersAndCollabs(orgId, payload, emailTemplate) {
  const r = await query(
    `SELECT u.id, u.email, u.name
     FROM organization_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.role IN ('owner', 'collaborator')`,
    [orgId]
  );
  for (const u of r.rows) {
    await notify({
      organizationId: orgId,
      userId: u.id,
      kind: payload.kind,
      title: payload.title,
      body: payload.body,
      link: payload.link,
      metadata: payload.metadata,
      email: emailTemplate ? { to: u.email, ...emailTemplate } : null,
    });
  }
  return r.rows.length;
}

function fullLink(path) {
  return APP_URL + path;
}

module.exports = { notify, notifyClientUsers, notifyOwnersAndCollabs, fullLink };
