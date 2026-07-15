// SocialFlow - helper de chamadas a API
// __spaGen: geracao da navegacao SPA atual (ver roteador la embaixo). Uma
// chamada iniciada por uma pagina que ja foi trocada (geracao antiga) nunca
// resolve/rejeita - assim o script antigo, que ainda pode estar com um
// `await` pendente, nunca chega a mexer em DOM que ja foi removido.
window.__spaGen = 0;

window.api = {
  async request(method, path, body) {
    const gen = window.__spaGen;
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
    if (gen !== window.__spaGen) return new Promise(() => {});
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
    window.initSidebarActions();
    window.initSpaRouter();
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

// Tema claro/escuro. Aplicado assim que o script roda (fora do await de
// requireSession) pra minimizar o flash de tela clara antes de virar escura.
// Persistido em localStorage, independente da sidebar existir ou nao na pagina.
window.initTheme = function () {
  let saved = 'light';
  try { saved = localStorage.getItem('sf_theme') || 'light'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');
};
window.initTheme();

window.toggleTheme = function () {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sf_theme', next); } catch (e) {}
  document.dispatchEvent(new CustomEvent('sf:theme-changed', { detail: { theme: next } }));
};

// Botao de minimizar/restaurar (fixo perto da logo) + botao de tema (item de
// menu com label "Brilho", no rodape acima de "Planos e cobranca"). Estados
// salvos em localStorage entre paginas.
window.initSidebarActions = function () {
  const shell = document.querySelector('.app-shell');
  const sidebar = document.querySelector('.sidebar');
  if (!shell || !sidebar || sidebar.querySelector('.sidebar-collapse-wrap')) return;

  const collapseWrap = document.createElement('div');
  collapseWrap.className = 'sidebar-collapse-wrap';
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  function syncCollapse() {
    const collapsed = shell.classList.contains('sidebar-collapsed');
    collapseBtn.className = 'sidebar-collapse-btn';
    collapseBtn.innerHTML = collapsed ? '&raquo;' : '&laquo;';
    collapseBtn.title = collapsed ? 'Expandir menu' : 'Minimizar menu';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
  }
  function setCollapsed(v) {
    shell.classList.toggle('sidebar-collapsed', v);
    try { localStorage.setItem('sf_sidebar_collapsed', v ? '1' : '0'); } catch (e) {}
    syncCollapse();
  }
  collapseBtn.addEventListener('click', () => setCollapsed(!shell.classList.contains('sidebar-collapsed')));
  collapseWrap.appendChild(collapseBtn);
  sidebar.appendChild(collapseWrap);

  const themeBtn = document.createElement('button');
  themeBtn.type = 'button';
  themeBtn.className = 'nav-item theme-toggle-item';
  const themeIcon = document.createElement('span');
  themeIcon.className = 'nav-icon-wrap';
  const themeLabel = document.createElement('span');
  themeLabel.textContent = 'Brilho';
  function syncTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    themeIcon.innerHTML = isDark ? '&#9788;' : '&#9790;'; // sol (clicar = clarear) / lua (clicar = escurecer)
    themeBtn.title = isDark ? 'Mudar para tema claro' : 'Mudar para tema escuro';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }
  themeBtn.addEventListener('click', () => { window.toggleTheme(); syncTheme(); });
  themeBtn.appendChild(themeIcon);
  themeBtn.appendChild(themeLabel);
  syncTheme();

  // Fica acima do "Planos e cobranca", no rodape do menu (junto com Configuracoes/Sair).
  const billingLink = sidebar.querySelector('.nav-item[href="/billing"]');
  if (billingLink) billingLink.before(themeBtn);
  else sidebar.appendChild(themeBtn);

  let savedCollapsed = '0';
  try { savedCollapsed = localStorage.getItem('sf_sidebar_collapsed') || '0'; } catch (e) {}
  if (savedCollapsed === '1') shell.classList.add('sidebar-collapsed');
  syncCollapse();
};

window.applySidebarForRole = function (role) {
  if (role !== 'client') return;
  // Client role: esconde rotas internas da agencia
  const hidden = ['Clientes', 'Personas', 'Configuracoes', 'Planos e cobranca', 'Edição'];
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

// ===== Roteador SPA-lite: troca de pagina sem reload completo =====
// So atua entre paginas que tem o app-shell (sidebar + main). Busca o HTML
// da pagina destino, troca o <style> de pagina e o conteudo do app-shell
// (main + modais) preservando a sidebar intacta, e reexecuta o script de
// inicializacao da pagina nova. Qualquer erro no meio do caminho cai pra
// navegacao normal do navegador - nunca deixa o app travado sem nav.
const SPA_PAGES = new Set([
  '/dashboard', '/clientes', '/cliente', '/personas', '/persona', '/persona-nova',
  '/roteiros', '/roteiro', '/roteiro-novo', '/carrosseis', '/carrossel', '/carrossel-novo',
  '/calendario', '/edicao', '/materiais', '/billing', '/configuracoes', '/relatorios',
]);

function isSpaLink(a) {
  if (!a || a.target || a.hasAttribute('download')) return false;
  let url;
  try { url = new URL(a.href, location.href); } catch (e) { return false; }
  if (url.origin !== location.origin) return false;
  if (!SPA_PAGES.has(url.pathname)) return false;
  return true;
}

async function spaNavigate(url, push) {
  // Qualquer chamada de API que a pagina atual ainda tenha pendente vira
  // "orfa" a partir daqui - ver window.__spaGen em window.api.request.
  const gen = ++window.__spaGen;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('fetch da pagina falhou: ' + res.status);
  const html = await res.text();
  // Se o usuario ja clicou em outro link enquanto isso carregava, uma
  // geracao mais nova comecou - descarta esta navegacao (evita a corrida
  // de duas paginas terminando de carregar fora de ordem).
  if (gen !== window.__spaGen) return;
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const newShell = doc.querySelector('.app-shell');
  const curShell = document.querySelector('.app-shell');
  if (!newShell || !curShell) throw new Error('app-shell nao encontrado na pagina destino');

  // Troca o <style> de pagina (cada pagina tem exatamente um, no <head>).
  const newStyle = doc.head.querySelector('style');
  const curStyle = document.head.querySelector('style');
  if (newStyle && curStyle) curStyle.textContent = newStyle.textContent;

  // Troca tudo dentro do app-shell exceto a sidebar (main da pagina).
  const keepSidebar = curShell.querySelector(':scope > .sidebar');
  Array.from(curShell.children).forEach((el) => { if (el !== keepSidebar) el.remove(); });
  Array.from(newShell.children).forEach((el) => {
    if (!el.classList.contains('sidebar')) curShell.appendChild(document.importNode(el, true));
  });

  // Modais (ex: "Novo cliente", "Convidar pessoa") ficam FORA do app-shell,
  // direto no <body> - trocam a parte, senao a pagina nova fica sem modal
  // e o script dela quebra procurando um elemento que nao existe.
  document.querySelectorAll('body > .modal-backdrop').forEach((el) => el.remove());
  Array.from(doc.querySelectorAll('body > .modal-backdrop')).forEach((el) => {
    document.body.appendChild(document.importNode(el, true));
  });

  document.title = doc.title;
  if (push) history.pushState({ spa: true }, '', url);

  // Atualiza o item ativo do menu (antes vinha "de fabrica" no HTML estatico).
  const path = new URL(url, location.href).pathname;
  curShell.querySelectorAll('.sidebar .nav-item.active').forEach((el) => el.classList.remove('active'));
  const activeLink = curShell.querySelector(`.sidebar .nav-item[href="${path}"]`);
  if (activeLink) activeLink.classList.add('active');

  // Reexecuta o script inline da pagina nova (o ultimo <script> sem src).
  // Isolado numa IIFE: cada pagina declara suas proprias const/let/function
  // no topo (ex: "const $ = ...", "const STATUS_LABEL = ..."), e sem isolar
  // isso colide (SyntaxError de redeclaracao) a partir da segunda pagina que
  // usa o mesmo nome. Funcoes que a propria pagina expõe de propósito (ex:
  // pra um onclick="" inline) já fazem isso via "window.algo = ...", que
  // continua funcionando normalmente de dentro da IIFE.
  const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
  const inline = scripts[scripts.length - 1];
  if (inline && inline.textContent.trim()) {
    const s = document.createElement('script');
    s.textContent = '(function () {\n' + inline.textContent + '\n})();';
    document.body.appendChild(s);
    s.remove();
  }

  window.scrollTo(0, 0);
}

function initSpaRouter() {
  if (window.__spaRouterInitialized) return;
  window.__spaRouterInitialized = true;

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a');
    if (!isSpaLink(a)) return;
    const url = a.href;
    if (url === location.href) { e.preventDefault(); return; }
    e.preventDefault();
    spaNavigate(url, true).catch((err) => {
      console.error('[spa] navegacao falhou, caindo pra reload normal:', err);
      window.location.href = url;
    });
  });

  window.addEventListener('popstate', () => {
    spaNavigate(location.href, false).catch((err) => {
      console.error('[spa] popstate falhou, recarregando:', err);
      window.location.reload();
    });
  });
}
window.initSpaRouter = initSpaRouter;
