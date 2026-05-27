const FROM = process.env.RESEND_FROM_EMAIL || 'SocialFlow <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.log('[email] RESEND_API_KEY nao configurado - simulando envio:', { to, subject });
    return { simulated: true };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html, text }),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('[email] resend erro:', r.status, err);
      return { error: err, status: r.status };
    }
    const data = await r.json();
    return { id: data.id };
  } catch (e) {
    console.error('[email] falha de rede:', e.message);
    return { error: e.message };
  }
}

function layout(content) {
  return `
<!doctype html>
<html><body style="margin:0; padding:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#faf6f0; color:#3d2c1d;">
  <div style="max-width:560px; margin: 24px auto; background:#fff; border:1px solid #d9c9b0; border-radius:12px; overflow:hidden;">
    <div style="padding: 20px 28px; border-bottom:1px solid #d9c9b0;">
      <div style="display:inline-flex; align-items:center; gap:8px; font-weight:700; font-size:18px;">
        <span style="width:10px; height:10px; background: linear-gradient(135deg, #a0826d, #8b6f47); border-radius:50%; display:inline-block;"></span>
        SocialFlow
      </div>
    </div>
    <div style="padding: 28px;">
      ${content}
    </div>
    <div style="padding: 16px 28px; border-top:1px solid #d9c9b0; font-size:12px; color:#9a8970;">
      <a href="${APP_URL}" style="color:#8b6f47; text-decoration:none;">${APP_URL.replace(/^https?:\/\//, '')}</a>
    </div>
  </div>
</body></html>`;
}

function button(href, text) {
  return `<a href="${href}" style="display:inline-block; padding: 11px 22px; background:#8b6f47; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">${text}</a>`;
}

const templates = {
  scriptSubmittedForApproval({ scriptTitle, clientName, link }) {
    return {
      subject: `${clientName}: novo conteudo aguardando aprovacao`,
      html: layout(`
        <h2 style="font-size:18px; margin:0 0 12px;">Tem conteudo novo pra voce aprovar</h2>
        <p style="margin: 0 0 8px; color: #6b5848;">Roteiro: <strong>${scriptTitle}</strong></p>
        <p style="margin: 0 0 20px; color: #6b5848;">Da uma olhada, aprova ou peca alteracao.</p>
        ${button(link, 'Ver e aprovar')}
      `),
      text: `Novo conteudo aguardando aprovacao: ${scriptTitle}\n${link}`,
    };
  },
  scriptApproved({ scriptTitle, approverName, link }) {
    return {
      subject: `${approverName} aprovou: ${scriptTitle}`,
      html: layout(`
        <h2 style="font-size:18px; margin:0 0 12px;">Conteudo aprovado</h2>
        <p style="margin: 0 0 8px; color: #6b5848;">${approverName} aprovou o roteiro <strong>${scriptTitle}</strong>. Ja pode publicar.</p>
        <p style="margin: 0 0 20px;"></p>
        ${button(link, 'Ver roteiro')}
      `),
      text: `${approverName} aprovou: ${scriptTitle}\n${link}`,
    };
  },
  scriptRejected({ scriptTitle, reviewerName, reason, link }) {
    return {
      subject: `${reviewerName} pediu alteracoes em: ${scriptTitle}`,
      html: layout(`
        <h2 style="font-size:18px; margin:0 0 12px;">Pediram alteracao</h2>
        <p style="margin: 0 0 8px; color: #6b5848;">${reviewerName} comentou no roteiro <strong>${scriptTitle}</strong>:</p>
        <div style="background:#f3ece0; padding: 14px 16px; border-radius: 8px; margin: 12px 0; font-style: italic; color: #3d2c1d;">${(reason || '(sem motivo informado)').replace(/\n/g, '<br>')}</div>
        ${button(link, 'Ver e ajustar')}
      `),
      text: `${reviewerName} pediu alteracoes em ${scriptTitle}:\n${reason || ''}\n${link}`,
    };
  },
  scriptCommented({ scriptTitle, commenterName, comment, link }) {
    return {
      subject: `${commenterName} comentou em: ${scriptTitle}`,
      html: layout(`
        <h2 style="font-size:18px; margin:0 0 12px;">Novo comentario</h2>
        <p style="margin: 0 0 8px; color: #6b5848;">${commenterName} comentou no roteiro <strong>${scriptTitle}</strong>:</p>
        <div style="background:#f3ece0; padding: 14px 16px; border-radius: 8px; margin: 12px 0; color: #3d2c1d;">${comment.replace(/\n/g, '<br>')}</div>
        ${button(link, 'Ver no SocialFlow')}
      `),
      text: `${commenterName} comentou em ${scriptTitle}:\n${comment}\n${link}`,
    };
  },
};

module.exports = { sendEmail, templates, layout, button, APP_URL };
