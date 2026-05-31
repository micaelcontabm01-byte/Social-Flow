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

// Botao de minimizar/restaurar a sidebar. Roda em toda pagina do app via
// requireSession. Estado fica salvo em localStorage entre paginas.
window.initSidebarToggle = function () {
  const shell = document.querySelector('.app-shell');
  const sidebar = document.querySelector('.sidebar');
  if (!shell || !sidebar || sidebar.querySelector('.sidebar-collapse-btn')) return;

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'sidebar-collapse-btn';
  collapseBtn.title = 'Minimizar menu';
  collapseBtn.setAttribute('aria-label', 'Minimizar menu');
  collapseBtn.innerHTML = '&laquo;';
  sidebar.appendChild(collapseBtn);

  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.className = 'sidebar-reopen';
  reopen.title = 'Abrir menu';
  reopen.setAttribute('aria-label', 'Abrir menu');
  reopen.innerHTML = '&#9776;'; // hamburguer
  document.body.appendChild(reopen);

  function setCollapsed(v) {
    shell.classList.toggle('sidebar-collapsed', v);
    try { localStorage.setItem('sf_sidebar_collapsed', v ? '1' : '0'); } catch (e) {}
  }
  collapseBtn.addEventListener('click', () => setCollapsed(true));
  reopen.addEventListener('click', () => setCollapsed(false));

  let saved = '0';
  try { saved = localStorage.getItem('sf_sidebar_collapsed') || '0'; } catch (e) {}
  if (saved === '1') shell.classList.add('sidebar-collapsed');
};

window.applySidebarForRole = function (role) {
  if (role !== 'client') return;
  // Client role: esconde rotas internas da agencia
  const hidden = ['Clientes', 'Personas', 'Configuracoes', 'Planos e cobranca'];
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
