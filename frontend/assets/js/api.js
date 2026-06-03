// SocialFlow - helper de chamadas a API
window.api = {
  async request(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(path, opts);
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  del(path) { return this.request('DELETE', path); },
};

// ===== Pop-up estilizado (substitui alert/confirm nativos do navegador) =====
// Uso:
//   window.popup({ title, message, icon, confirmText, cancelText, danger })
//      -> retorna Promise<boolean> (true = confirmou, false = cancelou)
//   window.popup.alert(message, title?)   -> so um botao OK
(function () {
  function ensureStyles() {
    if (document.getElementById('sf-popup-styles')) return;
    const css = `
      .sf-popup-backdrop { position: fixed; inset: 0; background: rgba(40,30,20,0.5);
        display: flex; align-items: center; justify-content: center; z-index: 9999;
        opacity: 0; transition: opacity 140ms ease; padding: 20px; }
      .sf-popup-backdrop.open { opacity: 1; }
      .sf-popup { background: var(--bg-1, #fff); border-radius: var(--radius, 14px);
        box-shadow: var(--shadow-lg, 0 20px 60px rgba(0,0,0,0.25)); width: 100%; max-width: 420px;
        padding: 26px 26px 22px; transform: translateY(8px) scale(0.98);
        transition: transform 140ms ease; text-align: center; }
      .sf-popup-backdrop.open .sf-popup { transform: translateY(0) scale(1); }
      .sf-popup-icon { width: 52px; height: 52px; border-radius: 50%; margin: 0 auto 14px;
        display: flex; align-items: center; justify-content: center; font-size: 26px;
        background: var(--brand-soft, #efe6da); }
      .sf-popup h3 { font-size: 18px; font-weight: 800; margin: 0 0 8px; color: var(--text-1, #3d2c1d);
        letter-spacing: -0.01em; }
      .sf-popup p { font-size: 14px; line-height: 1.55; color: var(--text-2, #6b5848); margin: 0 0 20px; }
      .sf-popup-actions { display: flex; gap: 10px; justify-content: center; }
      .sf-popup-actions .btn { min-width: 110px; justify-content: center; }
    `;
    const tag = document.createElement('style');
    tag.id = 'sf-popup-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function popup(opts) {
    opts = opts || {};
    const {
      title = 'Aviso',
      message = '',
      icon = 'ℹ️',
      confirmText = 'OK',
      cancelText = null,        // se null, mostra so o botao de confirmar
      danger = false,
    } = opts;

    ensureStyles();
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'sf-popup-backdrop';
      backdrop.innerHTML = `
        <div class="sf-popup" role="dialog" aria-modal="true">
          <div class="sf-popup-icon">${icon}</div>
          <h3></h3>
          <p></p>
          <div class="sf-popup-actions">
            ${cancelText ? `<button class="btn btn-ghost" data-act="cancel">${cancelText}</button>` : ''}
            <button class="btn" data-act="ok" ${danger ? 'style="background:var(--danger,#b04545);"' : ''}>${confirmText}</button>
          </div>
        </div>`;
      // textContent evita injecao de HTML no titulo/mensagem
      backdrop.querySelector('h3').textContent = title;
      backdrop.querySelector('p').textContent = message;
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('open'));

      function close(result) {
        backdrop.classList.remove('open');
        setTimeout(() => backdrop.remove(), 150);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter') close(true);
      }
      backdrop.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
      const cancelBtn = backdrop.querySelector('[data-act="cancel"]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
      document.addEventListener('keydown', onKey);
      backdrop.querySelector('[data-act="ok"]').focus();
    });
  }

  // Atalho: so informa (1 botao). window.popup.alert('texto', 'Titulo opcional')
  popup.alert = (message, title) => popup({ message, title: title || 'Aviso' });
  // Atalho: confirmacao (2 botoes). window.popup.confirm('texto', { ... })
  popup.confirm = (message, extra) => popup(Object.assign({
    message, title: 'Confirmar', confirmText: 'Confirmar', cancelText: 'Cancelar',
  }, extra || {}));

  window.popup = popup;
})();

window.requireSession = async function () {
  try {
    const me = await window.api.get('/api/me');
    window.applySidebarForRole(me.role);
    window.initSidebarToggle();
    // Aplica white-label se o usuario for cliente externo de uma org Pro/BLACK
    if (me.role === 'client' && me.organization_id) {
      window.applyBranding(me.organization_id).catch(() => {});
    }
    return me;
  } catch (err) {
    if (err.status === 401) {
      window.location.href = '/login';
      return null;
    }
    throw err;
  }
};

// Botao de minimizar/restaurar a sidebar. Ao recolher, vira uma barra estreita
// (rail) so com a logo - o proprio botao alterna os dois estados, sem botao
// flutuante sobre o conteudo. Estado salvo em localStorage entre paginas.
window.initSidebarToggle = function () {
  const shell = document.querySelector('.app-shell');
  const sidebar = document.querySelector('.sidebar');
  if (!shell || !sidebar || sidebar.querySelector('.sidebar-collapse-btn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sidebar-collapse-btn';
  sidebar.appendChild(btn);

  function sync() {
    const collapsed = shell.classList.contains('sidebar-collapsed');
    btn.innerHTML = collapsed ? '&raquo;' : '&laquo;';
    btn.title = collapsed ? 'Expandir menu' : 'Minimizar menu';
    btn.setAttribute('aria-label', btn.title);
  }
  function setCollapsed(v) {
    shell.classList.toggle('sidebar-collapsed', v);
    try { localStorage.setItem('sf_sidebar_collapsed', v ? '1' : '0'); } catch (e) {}
    sync();
  }
  btn.addEventListener('click', () => setCollapsed(!shell.classList.contains('sidebar-collapsed')));

  let saved = '0';
  try { saved = localStorage.getItem('sf_sidebar_collapsed') || '0'; } catch (e) {}
  if (saved === '1') shell.classList.add('sidebar-collapsed');
  sync();
};

window.applySidebarForRole = function (role) {
  if (role !== 'client') return;
  // Client role: esconde rotas internas da agencia
  const hidden = ['Clientes', 'Personas', 'Configuracoes', 'Planos e cobranca', 'Edicao'];
  document.querySelectorAll('.sidebar .nav-item').forEach((el) => {
    const text = (el.textContent || '').trim();
    if (hidden.includes(text)) el.style.display = 'none';
  });
};

// Substitui logo/nome do SocialFlow pela identidade da agencia quando o usuario
// e cliente externo de uma org com white-label ativo.
window.applyBranding = async function (orgId) {
  try {
    const meta = await window.api.get('/api/branding/meta/' + orgId);
    if (!meta) return;
    if (meta.brand_color) {
      document.documentElement.style.setProperty('--brand', meta.brand_color);
      document.documentElement.style.setProperty('--brand-hover', meta.brand_color);
      document.documentElement.style.setProperty('--brand-strong', meta.brand_color);
    }
    document.querySelectorAll('.brand-mark').forEach((el) => {
      el.innerHTML = '';
      if (meta.logo_url) {
        const img = document.createElement('img');
        img.src = meta.logo_url;
        img.alt = meta.name || 'Agencia';
        img.style.cssText = 'width:28px; height:28px; object-fit:contain; border-radius:6px;';
        el.appendChild(img);
      } else {
        const dot = document.createElement('span');
        dot.className = 'dot';
        el.appendChild(dot);
      }
      el.appendChild(document.createTextNode(' ' + (meta.name || 'SocialFlow')));
    });
    if (meta.name) {
      document.title = document.title.replace(/SocialFlow/g, meta.name);
    }
  } catch (e) {
    // Silencio - se branding falhar, mantem padrao SocialFlow
  }
};
