/* ============================================================
   ARCHIVA — app.js  v3
   Nouvelles fonctionnalités :
   - Bibliothèque IA partagée cross-modules
   - Recherche LLM dans les documents
   - Tarification annuelle -15%
   - Générateur de site marque blanche (ZIP)
============================================================ */

'use strict';

// ── STATE ──────────────────────────────────────────────────
const state = {
  provider: 'claude',
  apiKey: '',
  connected: false,
  docType: 'Contrat commercial',
  emailProvider: 'gmail',
  storageProvider: 'gdrive',
  selectedStorageFiles: new Set(),
  charts: [],
  pricingAnnual: false,
  userPlan: 'gratuit',
};

// Bibliothèque partagée (sessionStorage)
function loadLibrary() {
  try { return JSON.parse(sessionStorage.getItem('archiva_library') || '[]'); }
  catch { return []; }
}
function saveLibraryStore(lib) {
  sessionStorage.setItem('archiva_library', JSON.stringify(lib));
}
function addToLibrary(doc) {
  const lib = loadLibrary();
  lib.unshift({ ...doc, id: Date.now(), date: new Date().toLocaleDateString('fr-FR') });
  if (lib.length > 100) lib.pop();
  saveLibraryStore(lib);
  renderLibrary();
}
function clearLibrary() {
  sessionStorage.removeItem('archiva_library');
  renderLibrary();
  showNotif('Bibliothèque vidée.');
}

// ── INIT ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Apply white label config if running on subdomain
  if (window.__WL__) {
    const wl = window.__WL__;
    const r  = document.documentElement.style;
    if (wl.colors?.primary)   r.setProperty('--orange',  wl.colors.primary);
    if (wl.colors?.secondary) r.setProperty('--indigo',  wl.colors.secondary);
    if (wl.colors?.bg)        r.setProperty('--bg1',     wl.colors.bg);
    if (wl.font) r.setProperty('--font', wl.font);
    document.querySelectorAll('.brand-name, .nav-logo span, .hero-title .gradient-text').forEach(el => {
      if (el.dataset.brand !== 'skip') el.textContent = wl.name;
    });
    document.title = wl.name + ' — Intelligence Documentaire';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && wl.heroDesc) metaDesc.content = wl.heroDesc;
    // Hide whitelabel nav item in subdomain sites
    const navWl = document.getElementById('navWhitelabel');
    if (navWl) navWl.style.display = 'none';
  }

  const saved     = sessionStorage.getItem('archiva_key');
  const savedProv = sessionStorage.getItem('archiva_provider');
  if (saved) {
    state.apiKey   = saved;
    state.provider = savedProv || 'claude';
    document.getElementById('apiKeyInput').value = saved;
    selectProvider(state.provider, false);
    setApiStatus('ok', 'Clé restaurée');
    state.connected = true;
    document.getElementById('apiCard').classList.add('connected');
  }

  if (!localStorage.getItem('archiva_cookies')) {
    document.getElementById('cookieBanner').classList.remove('hidden');
  } else {
    document.getElementById('cookieBanner').classList.add('hidden');
  }

  window.addEventListener('scroll', () => {
    document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 20);
  });

  document.getElementById('docTypeGrid').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#docTypeGrid .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.docType = chip.dataset.type;
  });

  renderLibrary();
  renderPartners();
  renderIntegrations();
  initKinde();
  handleStripeReturn();
});

// ── AUTHENTIFICATION — KINDE PKCE ──────────────────────────
const KINDE_DOMAIN    = 'https://aelcorporation.kinde.com';
const KINDE_CLIENT_ID = 'a398643a85044a7fba7f89994be28c5a';
const KINDE_REDIRECT  = window.location.origin + '/';

function b64urlEncode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE() {
  const verifier  = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const hash      = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = b64urlEncode(hash);
  return { verifier, challenge };
}

async function kindeLogin() {
  const { verifier, challenge } = await generatePKCE();
  const st = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('kinde_verifier', verifier);
  sessionStorage.setItem('kinde_state',    st);
  const params = new URLSearchParams({
    client_id:             KINDE_CLIENT_ID,
    redirect_uri:          KINDE_REDIRECT,
    response_type:         'code',
    scope:                 'openid profile email',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state:                 st,
  });
  window.location.href = `${KINDE_DOMAIN}/oauth2/auth?${params}`;
}

async function kindeRegister() {
  const { verifier, challenge } = await generatePKCE();
  const st = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('kinde_verifier', verifier);
  sessionStorage.setItem('kinde_state',    st);
  const params = new URLSearchParams({
    client_id:             KINDE_CLIENT_ID,
    redirect_uri:          KINDE_REDIRECT,
    response_type:         'code',
    scope:                 'openid profile email',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state:                 st,
    prompt:                'create',
  });
  window.location.href = `${KINDE_DOMAIN}/oauth2/auth?${params}`;
}

async function handleKindeCallback() {
  const params       = new URLSearchParams(window.location.search);
  const code         = params.get('code');
  const returnedState = params.get('state');
  if (!code) return;

  const storedState  = sessionStorage.getItem('kinde_state');
  const codeVerifier = sessionStorage.getItem('kinde_verifier');
  sessionStorage.removeItem('kinde_state');
  sessionStorage.removeItem('kinde_verifier');
  window.history.replaceState({}, '', '/');

  if (returnedState !== storedState) {
    console.error('Kinde state mismatch');
    return;
  }

  try {
    const res = await fetch(`${KINDE_DOMAIN}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     KINDE_CLIENT_ID,
        redirect_uri:  KINDE_REDIRECT,
        code,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) { console.error('Kinde token exchange failed', await res.text()); return; }
    const tokens = await res.json();
    localStorage.setItem('kinde_access_token', tokens.access_token);
    if (tokens.id_token) localStorage.setItem('kinde_id_token', tokens.id_token);
    if (tokens.expires_in) {
      localStorage.setItem('kinde_expires_at', String(Date.now() + tokens.expires_in * 1000));
    }
    const user = decodeKindeJwt(tokens.id_token || tokens.access_token);
    updateNavAuth(user);
    fetchUserPlan();
    showNotif(`✓ Bienvenue, ${user?.given_name || user?.email || 'vous'} !`);
    showPage('ai');
  } catch (e) {
    console.error('Kinde callback error:', e);
  }
}

function decodeKindeJwt(token) {
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

function getKindeToken() {
  const token     = localStorage.getItem('kinde_access_token');
  const expiresAt = parseInt(localStorage.getItem('kinde_expires_at') || '0');
  if (!token) return null;
  if (expiresAt && Date.now() > expiresAt) { kindeLogout(); return null; }
  return token;
}

function getKindeUser() {
  const token = getKindeToken();
  return token ? decodeKindeJwt(token) : null;
}

function isAuthenticated() {
  return !!getKindeToken();
}

function initKinde() {
  const user = getKindeUser();
  updateNavAuth(user);
  if (user) fetchUserPlan();
  if (window.location.search.includes('code=')) handleKindeCallback();
}

function updateNavAuth(user) {
  const lo  = document.getElementById('navLoggedOut');
  const li  = document.getElementById('navLoggedIn');
  const mlo = document.getElementById('mobileLoggedOut');
  const mli = document.getElementById('mobileLoggedIn');
  const displayName = user
    ? (user.given_name || user.email || 'Mon compte')
    : null;

  if (displayName) {
    if (lo)  lo.style.display  = 'none';
    if (li)  { li.style.display = 'flex'; document.getElementById('navUserName').textContent = displayName; }
    if (mlo) mlo.style.display = 'none';
    if (mli) { mli.style.display = 'block'; document.getElementById('mobileUserName').textContent = displayName; }
  } else {
    if (lo)  lo.style.display  = 'flex';
    if (li)  li.style.display  = 'none';
    if (mlo) mlo.style.display = 'block';
    if (mli) mli.style.display = 'none';
  }
}

function kindeLogout() {
  localStorage.removeItem('kinde_access_token');
  localStorage.removeItem('kinde_id_token');
  localStorage.removeItem('kinde_expires_at');
  updateNavAuth(null);
  state.userPlan = 'gratuit';
  window.location.href = `${KINDE_DOMAIN}/logout?redirect=${encodeURIComponent(window.location.origin + '/')}`;
}

function logoutUser() {
  kindeLogout();
}

// ── API BACKEND ────────────────────────────────────────────
async function apiRequest(path, options = {}) {
  const token = getKindeToken();
  if (!token) throw new Error('Non authentifié');
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Erreur API ${res.status}`);
  return res.json();
}

async function fetchUserPlan() {
  try {
    const data = await apiRequest('/api/me');
    state.userPlan = data.plan || 'gratuit';
    updatePlanBadge(data);
    const navWl = document.getElementById('navWhitelabel');
    if (navWl) navWl.style.display = state.userPlan === 'entreprise' ? '' : 'none';
  } catch {
    state.userPlan = 'gratuit';
  }
}

function updatePlanBadge(user) {
  const planLabels = { gratuit: 'Gratuit', pro: 'Pro', entreprise: 'Entreprise', 'sur-devis': 'Sur devis' };
  const badge = document.getElementById('navUserName');
  if (badge && user) {
    const plan = user.plan && user.plan !== 'gratuit' ? ` · ${planLabels[user.plan] || user.plan}` : '';
    badge.textContent = (user.name || 'Utilisateur') + plan;
  }
}

// ── NAVIGATION ─────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  if (page) page.classList.add('active');
  const link = document.querySelector(`.nav-link[data-page="${name}"]`);
  if (link) link.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleMobile() {
  document.getElementById('mobileNav').classList.toggle('open');
  document.getElementById('hamburger').classList.toggle('open');
}

// ── API CONNECTION ─────────────────────────────────────────
function selectProvider(name, updateUI = true) {
  state.provider = name;
  if (updateUI) {
    document.querySelectorAll('.prov-pill').forEach(p => p.classList.remove('active'));
    const pill = document.getElementById('pill-' + name);
    if (pill) pill.classList.add('active');
    document.getElementById('apiKeyInput').placeholder =
      name === 'claude' ? 'sk-ant-api03-…' : 'Votre clé Mistral AI…';
  }
}

async function connectApi() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) { showApiResult('err', 'Veuillez entrer une clé API.'); return; }
  setApiStatus('loading', 'Vérification…');
  showApiResult('', '');
  try {
    let ok = false;
    if (state.provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
      });
      ok = res.ok || res.status === 400;
    } else {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mistral-large-latest', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
      });
      ok = res.ok || res.status === 400;
    }
    if (ok) {
      state.apiKey = key; state.connected = true;
      sessionStorage.setItem('archiva_key', key);
      sessionStorage.setItem('archiva_provider', state.provider);
      setApiStatus('ok', 'Connecté');
      document.getElementById('apiCard').classList.add('connected');
      showApiResult('ok', '✓ Connexion réussie ! Tous les modules sont disponibles.');
    } else { throw new Error('Clé invalide'); }
  } catch {
    setApiStatus('err', 'Erreur'); state.connected = false;
    showApiResult('err', '✗ Clé invalide ou erreur réseau.');
  }
}

function setApiStatus(type, text) {
  document.getElementById('statusDot').className  = 'status-dot' + (type ? ' ' + type : '');
  document.getElementById('statusText').textContent = text;
}
function showApiResult(type, msg) {
  const el = document.getElementById('apiResult');
  if (!type) { el.style.display = 'none'; return; }
  el.className = 'api-result ' + type; el.textContent = msg; el.style.display = 'block';
}

// ── PANEL SWITCHING ────────────────────────────────────────
function switchPanel(name) {
  document.querySelectorAll('.f-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.fnav').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('fnav-' + name).classList.add('active');
}

function switchDataTab(name) {
  ['upload', 'paste'].forEach(t => {
    document.getElementById('dtab-' + t).classList.toggle('active', t === name);
    document.getElementById('dtab-content-' + t).style.display = t === name ? '' : 'none';
  });
}

// ── BIBLIOTHÈQUE PARTAGÉE ──────────────────────────────────
function toggleDocLib() {
  const body   = document.getElementById('docLibBody');
  const toggle = document.getElementById('docLibToggle');
  body.classList.toggle('open');
  toggle.classList.toggle('open');
}

function renderLibrary() {
  const lib   = loadLibrary();
  const grid  = document.getElementById('docGrid');
  const count = document.getElementById('docLibCount');
  if (!grid) return;
  count.textContent = lib.length;

  if (!lib.length) {
    grid.innerHTML = '<p class="doc-lib-empty">Aucun document encore. Générez ou analysez un document pour le voir apparaître ici.</p>';
    return;
  }

  const icons = { gen: '📝', extract: '🔍', analysis: '📊', email: '📧', storage: '☁️' };
  grid.innerHTML = lib.map(doc => `
    <div class="doc-card" onclick="loadDocFromLibrary('${doc.id}')">
      <div class="doc-card-top">
        <span class="doc-card-ico">${icons[doc.module] || '📄'}</span>
        <span class="doc-card-type">${doc.module || 'doc'}</span>
      </div>
      <div class="doc-card-title">${escHtml(doc.title || 'Sans titre')}</div>
      <div class="doc-card-date">${doc.date}</div>
    </div>`).join('');
}

function loadDocFromLibrary(id) {
  const lib = loadLibrary();
  const doc = lib.find(d => String(d.id) === String(id));
  if (!doc) return;

  switchPanel(doc.module || 'gen');
  const outputId  = doc.module + 'Output';
  const contentId = doc.module + 'Content';
  const outputEl  = document.getElementById(outputId);
  const contentEl = document.getElementById(contentId);
  if (!outputEl || !contentEl) return;

  outputEl.style.display = 'block';
  contentEl.innerHTML = markdownToHtml(doc.content);
  showPage('ai');
  setTimeout(() => outputEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 300);
  showNotif(`📄 "${doc.title}" rechargé depuis la bibliothèque.`);
}

// ── RECHERCHE IA CROSS-MODULES ─────────────────────────────
async function searchDocuments() {
  const query = document.getElementById('aiSearchInp').value.trim();
  if (!query) return;
  if (!checkConnection()) return;

  const resultEl = document.getElementById('aiSearchResult');
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="color:var(--t400);font-size:.85rem">⏳ Recherche en cours…</div>';

  const lib = loadLibrary();
  const libContext = lib.length
    ? lib.map((d, i) => `[${i+1}] ${d.title} (${d.module}, ${d.date}) :\n${d.content.slice(0, 400)}`).join('\n\n---\n\n')
    : 'Bibliothèque vide.';

  const prompt = `Tu es l'assistant IA d'Archiva. L'utilisateur a les documents suivants dans sa bibliothèque :

${libContext}

Question / demande de l'utilisateur : "${query}"

Réponds directement et précisément. Si la question concerne un document spécifique, cite son contenu pertinent.
Si c'est une question générale sur les documents, synthétise les informations disponibles.
Réponds en français, en Markdown structuré, de façon concise et utile.`;

  try {
    const result = await callAI(prompt, 1500);
    resultEl.innerHTML = markdownToHtml(result);
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--red)">${escHtml(err.message)}</span>`;
  }
}

// ── PRICING TOGGLE ─────────────────────────────────────────
function togglePricingPeriod() {
  setPricingPeriod(state.pricingAnnual ? 'monthly' : 'annual');
}

function setPricingPeriod(period) {
  state.pricingAnnual = period === 'annual';
  const sw = document.getElementById('ptogSwitch');
  sw.classList.toggle('on', state.pricingAnnual);
  document.getElementById('ptog-monthly').classList.toggle('active', !state.pricingAnnual);
  document.getElementById('ptog-annual').classList.toggle('active',  state.pricingAnnual);

  const proM  = 57, entM = 147;
  const proA  = Math.round(proM  * 0.85);
  const entA  = Math.round(entM  * 0.85);

  if (state.pricingAnnual) {
    document.getElementById('priceProAmount').textContent = proA + '€';
    document.getElementById('priceProPer').textContent    = '/mois (facturé annuellement)';
    document.getElementById('priceProNote').innerHTML     = `<span style="color:var(--green);font-size:.78rem">✓ Économisez ${(proM - proA) * 12}€/an</span>`;
    document.getElementById('priceEntAmount').textContent = entA + '€';
    document.getElementById('priceEntPer').textContent    = '/mois (facturé annuellement)';
    document.getElementById('priceEntNote').innerHTML     = `<span style="color:var(--green);font-size:.78rem">✓ Économisez ${(entM - entA) * 12}€/an</span>`;
  } else {
    document.getElementById('priceProAmount').textContent = proM + '€';
    document.getElementById('priceProPer').textContent    = '/mois par utilisateur';
    document.getElementById('priceProNote').textContent   = 'Pour les professionnels et PMEs';
    document.getElementById('priceEntAmount').textContent = entM + '€';
    document.getElementById('priceEntPer').textContent    = '/mois par utilisateur';
    document.getElementById('priceEntNote').textContent   = 'Pour les grandes équipes';
  }
}

// ── FILE HANDLING ──────────────────────────────────────────
function handleDrag(e, zoneId) { e.preventDefault(); document.getElementById(zoneId).classList.add('drag-over'); }
function handleDragLeave(e, zoneId) { document.getElementById(zoneId).classList.remove('drag-over'); }
function handleDrop(e, listId) {
  e.preventDefault();
  document.getElementById(e.currentTarget.id).classList.remove('drag-over');
  renderFileList(Array.from(e.dataTransfer.files), listId);
}
function handleFileSelect(e, listId) { renderFileList(Array.from(e.target.files), listId); }

function renderFileList(files, listId) {
  const container = document.getElementById(listId);
  container.innerHTML = '';
  container._files = files;
  files.forEach((f, i) => {
    const ext = f.name.split('.').pop().toLowerCase();
    const ico = { pdf: '📄', docx: '📝', xlsx: '📊', csv: '📋', txt: '📃' }[ext] || '📎';
    const div = document.createElement('div');
    div.className = 'file-item';
    div.dataset.index = i;
    div.innerHTML = `<span class="file-ico">${ico}</span><span class="file-name">${f.name}</span><span class="file-sz">${formatSize(f.size)}</span><button class="file-rm" onclick="this.closest('.file-item').remove()">✕</button>`;
    container.appendChild(div);
  });
}

function formatSize(b) {
  if (b < 1024) return b + ' o';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' Ko';
  return (b / 1048576).toFixed(1) + ' Mo';
}

async function readFileText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'txt' || ext === 'csv') return file.text();
  if (ext === 'pdf')  return readPdf(file);
  if (ext === 'docx') return readDocx(file);
  if (ext === 'xlsx') return readXlsx(file);
  return file.text();
}

async function readPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= Math.min(pdf.numPages, 30); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(s => s.str).join(' ') + '\n';
  }
  return text;
}

async function readDocx(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

function readXlsx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'binary' });
        let text = '';
        wb.SheetNames.forEach(n => { text += `=== ${n} ===\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]) + '\n\n'; });
        resolve(text);
      } catch (err) { reject(err); }
    };
    reader.readAsBinaryString(file);
  });
}

// ── AI CALL ────────────────────────────────────────────────
async function callAI(prompt, maxTokens = 2048) {
  if (!state.connected || !state.apiKey) throw new Error('Veuillez d\'abord connecter votre clé API.');
  if (state.provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || 'Erreur API Claude'); }
    return (await res.json()).content[0].text;
  } else {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + state.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-large-latest', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || 'Erreur API Mistral'); }
    return (await res.json()).choices[0].message.content;
  }
}

function showLoading(boxId, steps = []) {
  const el = document.getElementById(boxId);
  el.style.display = 'block';
  el.innerHTML = `
    <div class="output-bar"><span class="output-lbl">Traitement en cours…</span></div>
    <div class="loading-box">
      <div class="loading-ring"></div>
      <h3>L'IA analyse votre demande</h3>
      <p>Généralement 5 à 30 secondes</p>
      ${steps.length ? '<div class="loading-steps">' + steps.map((s, i) => `<div class="ls-row" id="step-${i}"><div class="ls-dot ${i===0?'on':''}"></div><span>${s}</span></div>`).join('') + '</div>' : ''}
    </div>`;
}

function advanceStep(i) {
  const prev = document.getElementById('step-' + (i - 1));
  const curr = document.getElementById('step-' + i);
  if (prev) prev.querySelector('.ls-dot').className = 'ls-dot done';
  if (curr) curr.querySelector('.ls-dot').className = 'ls-dot on';
}

// ── MODULE 1 : GÉNÉRATION ──────────────────────────────────
async function generateDoc() {
  if (!checkConnection()) return;
  const type    = state.docType;
  const company = document.getElementById('genCompany').value.trim();
  const lang    = document.getElementById('genLang').value;
  const instr   = document.getElementById('genInstructions').value.trim();
  const length  = document.getElementById('genLength').value;

  showLoading('genOutput', ['Analyse de la demande', 'Structuration', 'Rédaction IA', 'Mise en forme']);

  const prompt = `Tu es un expert en rédaction professionnelle. Génère un(e) ${type} en ${lang}.
Contexte : ${company || 'Non précisé'} | Longueur : ${length}
Instructions : ${instr || 'Document standard professionnel'}
Génère un document complet, structuré en Markdown (## H2, ### H3). Professionnel et complet.`;

  try {
    advanceStep(1); setTimeout(() => advanceStep(2), 800);
    const result = await callAI(prompt, 3000);
    advanceStep(3);

    document.getElementById('genOutput').innerHTML = `
      <div class="output-bar"><span class="output-lbl">📝 ${escHtml(type)}</span><div class="output-acts"><button class="btn btn-sm btn-ghost" onclick="copyOutput('genContent')">📋 Copier</button><button class="btn btn-sm btn-primary" onclick="exportPdf('genContent')">⬇️ PDF</button></div></div>
      <div class="output-body" id="genContent">${markdownToHtml(result)}</div>`;
    document.getElementById('genOutput').style.display = 'block';

    addToLibrary({ title: type + (company ? ' — ' + company : ''), content: result, module: 'gen' });
    document.getElementById('genOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    checkAndRunInteg(instr, result, type + (company ? ' — ' + company : ''));
  } catch (err) { showError('genOutput', err.message); }
}

// ── MODULE 2 : EXTRACTION ──────────────────────────────────
async function runExtraction() {
  if (!checkConnection()) return;
  const mode = document.getElementById('extractMode').value;
  let text = '';
  let title = 'Extraction';

  const tab = document.querySelector('.dtab.active')?.id;
  if (tab === 'dtab-paste') {
    text = document.getElementById('extractPasteText').value.trim();
    if (!text) { showNotif('Veuillez coller du texte.'); return; }
    title = 'Texte collé';
  } else {
    const container = document.getElementById('extractFiles');
    const items = container.querySelectorAll('.file-item');
    if (!items.length) { showNotif('Veuillez importer au moins un fichier.'); return; }
    showLoading('extractOutput', ['Lecture des fichiers', 'Extraction du contenu', 'Analyse IA', 'Résumé']);
    try {
      const texts = [];
      for (const item of items) {
        const file = container._files?.[parseInt(item.dataset.index)];
        if (file) { texts.push(`=== ${file.name} ===\n` + await readFileText(file)); }
      }
      text  = texts.join('\n\n---\n\n');
      title = container._files?.[0]?.name || 'Fichier';
    } catch (err) { showError('extractOutput', 'Erreur de lecture : ' + err.message); return; }
  }

  if (!document.getElementById('extractOutput').querySelector('.loading-box')) {
    showLoading('extractOutput', ['Analyse', 'Extraction', 'Résumé']);
  }

  const prompt = `Expert en analyse documentaire. Effectue une ${mode} du document suivant.
Réponds en Markdown structuré (##, listes, données en **gras**).
DOCUMENT : ${text.slice(0, 12000)}`;

  try {
    advanceStep(1);
    const result = await callAI(prompt, 2500);
    document.getElementById('extractOutput').innerHTML = `
      <div class="output-bar"><span class="output-lbl">🔍 Résultats</span><div class="output-acts"><button class="btn btn-sm btn-ghost" onclick="copyOutput('extractContent')">📋 Copier</button><button class="btn btn-sm btn-primary" onclick="exportPdf('extractContent')">⬇️ PDF</button></div></div>
      <div class="output-body" id="extractContent">${markdownToHtml(result)}</div>`;

    addToLibrary({ title: mode + ' — ' + title, content: result, module: 'extract' });
    document.getElementById('extractOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const extractInstr = document.getElementById('extractPasteText')?.value || '';
    checkAndRunInteg(extractInstr, result, mode + ' — ' + title);
  } catch (err) { showError('extractOutput', err.message); }
}

// ── MODULE 3 : ANALYSE ─────────────────────────────────────
async function runAnalysis() {
  if (!checkConnection()) return;
  const type    = document.getElementById('analysisType').value;
  const context = document.getElementById('analysisContext').value.trim();
  const container = document.getElementById('analysisFiles');
  const items = container.querySelectorAll('.file-item');
  if (!items.length) { showNotif('Veuillez importer au moins un fichier.'); return; }

  showLoading('analysisOutput', ['Lecture des données', 'Analyse statistique', 'Génération du rapport', 'Graphiques']);
  let dataText = '';
  try {
    for (const item of items) {
      const file = container._files?.[parseInt(item.dataset.index)];
      if (file) dataText += `=== ${file.name} ===\n` + await readFileText(file) + '\n\n';
    }
  } catch (err) { showError('analysisOutput', 'Erreur de lecture : ' + err.message); return; }

  advanceStep(1);
  const prompt = `Expert analyste de données. Réalise une ${type}.
Contexte : ${context || 'Analyse générale'}
DONNÉES : ${dataText.slice(0, 12000)}

Rapport Markdown avec : ## Synthèse, ## Analyse, ## Données clés (tableau), ## Tendances, ## Recommandations

Puis à la toute fin, données graphiques JSON délimitées exactement ainsi :
\`\`\`chartdata
{"charts":[{"type":"bar","title":"Titre","labels":["A","B","C","D"],"data":[100,200,150,300],"color":"orange"},{"type":"line","title":"Tendance","labels":["Jan","Fév","Mar","Avr","Mai"],"data":[10,25,18,35,28],"color":"blue"},{"type":"doughnut","title":"Répartition","labels":["A","B","C"],"data":[40,35,25],"color":"mixed"}]}
\`\`\``;

  try {
    advanceStep(2);
    const result = await callAI(prompt, 3500);
    advanceStep(3);

    const chartMatch = result.match(/```chartdata\s*([\s\S]*?)```/);
    const reportText = result.replace(/```chartdata[\s\S]*?```/, '').trim();

    document.getElementById('analysisOutput').innerHTML = `
      <div class="output-bar"><span class="output-lbl">📊 Rapport</span><div class="output-acts"><button class="btn btn-sm btn-ghost" onclick="copyOutput('analysisContent')">📋 Copier</button><button class="btn btn-sm btn-primary" onclick="exportFullReport()">⬇️ PDF</button></div></div>
      <div class="output-body" id="analysisContent">${markdownToHtml(reportText)}</div>
      <div id="chartsArea" style="padding:1.25rem 1.5rem;border-top:1px solid var(--border)"></div>`;
    document.getElementById('analysisOutput').style.display = 'block';

    if (chartMatch) { try { renderCharts(JSON.parse(chartMatch[1].trim()).charts || []); } catch {} }
    addToLibrary({ title: type, content: reportText, module: 'analysis' });
    document.getElementById('analysisOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    checkAndRunInteg(context, reportText, type);
  } catch (err) { showError('analysisOutput', err.message); }
}

function renderCharts(charts) {
  const area = document.getElementById('chartsArea');
  if (!charts.length) return;
  state.charts.forEach(c => c.destroy()); state.charts = [];
  const grid = document.createElement('div'); grid.className = 'charts-grid';
  const palette = {
    orange: ['rgba(249,115,22,.8)','rgba(251,146,60,.6)','rgba(234,88,12,.5)'],
    blue:   ['rgba(99,102,241,.8)','rgba(129,140,248,.6)','rgba(67,56,202,.5)'],
    green:  ['rgba(34,197,94,.8)','rgba(74,222,128,.6)','rgba(22,163,74,.5)'],
    mixed:  ['rgba(249,115,22,.8)','rgba(99,102,241,.8)','rgba(34,197,94,.8)','rgba(245,158,11,.8)','rgba(239,68,68,.8)'],
  };
  charts.forEach((ch, i) => {
    const card = document.createElement('div'); card.className = 'chart-card';
    card.innerHTML = `<h4>${ch.title || 'Graphique ' + (i+1)}</h4><canvas id="chart-${i}"></canvas>`;
    grid.appendChild(card);
    requestAnimationFrame(() => {
      const ctx = document.getElementById('chart-' + i)?.getContext('2d');
      if (!ctx) return;
      const colors = palette[ch.color] || palette.orange;
      const instance = new Chart(ctx, {
        type: ch.type || 'bar',
        data: { labels: ch.labels || [], datasets: [{ label: ch.title || '', data: ch.data || [], backgroundColor: ch.type === 'line' ? 'transparent' : colors, borderColor: ch.type === 'line' ? colors[0] : colors, borderWidth: ch.type === 'line' ? 2.5 : 1, borderRadius: ch.type === 'bar' ? 6 : 0, tension: 0.4, pointRadius: ch.type === 'line' ? 4 : 0, pointBackgroundColor: colors[0] }] },
        options: { responsive: true, plugins: { legend: { display: ['doughnut','pie'].includes(ch.type), labels: { color: '#94a3b8', font: { size: 11 } } } }, scales: ['bar','line'].includes(ch.type) ? { x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.04)' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.06)' } } } : {} },
      });
      state.charts.push(instance);
    });
  });
  area.appendChild(grid);
}

// ── MODULE 4 : EMAIL ───────────────────────────────────────
function selectEmailProvider(name) {
  state.emailProvider = name;
  document.querySelectorAll('[id^="eprov-"]').forEach(el => el.classList.remove('active'));
  document.getElementById('eprov-' + name).classList.add('active');
  document.getElementById('emailConfigGmail').style.display   = name === 'gmail'   ? '' : 'none';
  document.getElementById('emailConfigOutlook').style.display = name === 'outlook' ? '' : 'none';
}

async function connectEmail() {
  if (!checkConnection()) return;
  const count = parseInt(document.getElementById('emailCount').value);
  try {
    const emails = state.emailProvider === 'gmail' ? await fetchGmailEmails(count) : await fetchOutlookEmails(count);
    renderEmails(emails);
  } catch (err) { showNotif('Erreur : ' + err.message); }
}

async function fetchGmailEmails(count) {
  const token = document.getElementById('gmailToken').value.trim();
  if (!token) throw new Error('Access Token Gmail requis');
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}&labelIds=INBOX`, { headers: { Authorization: 'Bearer ' + token } });
  if (!listRes.ok) throw new Error('Token Gmail invalide ou expiré');
  const { messages = [] } = await listRes.json();
  const emails = [];
  for (const msg of messages.slice(0, count)) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) continue;
    const data = await res.json();
    const h = {}; (data.payload?.headers || []).forEach(x => { h[x.name] = x.value; });
    emails.push({ id: msg.id, from: h.From || 'Inconnu', subject: h.Subject || '(Sans objet)', date: h.Date || '', snippet: data.snippet || '', unread: (data.labelIds || []).includes('UNREAD') });
  }
  return emails;
}

async function fetchOutlookEmails(count) {
  const token = document.getElementById('outlookToken').value.trim();
  if (!token) throw new Error('Access Token Outlook requis');
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${count}&$select=from,subject,receivedDateTime,bodyPreview,isRead`, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Token Outlook invalide');
  return (await res.json()).value?.map(m => ({ id: m.id, from: m.from?.emailAddress?.address || 'Inconnu', subject: m.subject || '(Sans objet)', date: m.receivedDateTime || '', snippet: m.bodyPreview || '', unread: !m.isRead })) || [];
}

function renderEmails(emails) {
  const wrap = document.getElementById('emailsWrap');
  const list = document.getElementById('emailsList');
  list.innerHTML = '';
  if (!emails.length) { list.innerHTML = '<p style="color:var(--t500);font-size:.875rem">Aucun email.</p>'; wrap.style.display = 'block'; return; }
  emails.forEach(email => {
    const row = document.createElement('div');
    row.className = 'email-row' + (email.unread ? ' unread' : '');
    const dateStr = email.date ? new Date(email.date).toLocaleDateString('fr-FR') : '';
    row.innerHTML = `<div class="email-top"><span class="email-from">${escHtml(email.from)}</span><span class="email-date">${dateStr}</span></div><div class="email-subj">${escHtml(email.subject)}</div><div class="email-prev">${escHtml(email.snippet.slice(0,100))}…</div><div class="email-acts"><button class="btn btn-sm btn-ghost" onclick="summarizeEmail(this)" data-subj="${encodeURIComponent(email.subject)}" data-body="${encodeURIComponent(email.snippet)}">🤖 Résumer</button></div>`;
    list.appendChild(row);
  });
  wrap.style.display = 'block';
}

async function summarizeEmail(btn) {
  const subj = decodeURIComponent(btn.dataset.subj);
  const body = decodeURIComponent(btn.dataset.body);
  btn.disabled = true; btn.textContent = '⏳…';
  try {
    const result = await callAI(`Résume cet email en 3 points clés et propose une réponse si utile.\nSujet: ${subj}\nContenu: ${body}`, 500);
    const existing = btn.closest('.email-row').querySelector('.email-summary');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'email-summary';
    div.style.cssText = 'margin-top:.6rem;padding:.6rem .75rem;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:8px;font-size:.8rem;color:var(--t300);line-height:1.55';
    div.innerHTML = markdownToHtml(result);
    btn.closest('.email-row').appendChild(div);
    addToLibrary({ title: 'Email — ' + subj, content: result, module: 'email' });
  } catch (err) { showNotif(err.message); }
  finally { btn.disabled = false; btn.textContent = '🤖 Résumer'; }
}

// ── MODULE 5 : STOCKAGE ────────────────────────────────────
function selectStorageProvider(name) {
  state.storageProvider = name;
  document.querySelectorAll('[id^="sprov-"]').forEach(el => el.classList.remove('active'));
  document.getElementById('sprov-' + name).classList.add('active');
  ['gdrive','dropbox','onedrive'].forEach(p => {
    document.getElementById('storageConfig' + p.charAt(0).toUpperCase() + p.slice(1)).style.display = p === name ? '' : 'none';
  });
}

async function connectStorage() {
  if (!checkConnection()) return;
  try {
    let files = [];
    if (state.storageProvider === 'gdrive')   files = await listGDriveFiles();
    if (state.storageProvider === 'dropbox')  files = await listDropboxFiles();
    if (state.storageProvider === 'onedrive') files = await listOneDriveFiles();
    renderStorageFiles(files);
  } catch (err) { showNotif('Erreur stockage : ' + err.message); }
}

async function listGDriveFiles() {
  const token = document.getElementById('gdriveToken').value.trim();
  const fId   = document.getElementById('gdriveFolderId').value.trim();
  if (!token) throw new Error('Access Token Drive requis');
  const q = fId ? `'${fId}' in parents` : "'root' in parents";
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,mimeType)&pageSize=50`, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Token Drive invalide');
  return (await res.json()).files?.map(f => ({ id: f.id, name: f.name, size: f.size ? formatSize(parseInt(f.size)) : '—', source: 'gdrive' })) || [];
}

async function listDropboxFiles() {
  const token = document.getElementById('dropboxToken').value.trim();
  const path  = document.getElementById('dropboxPath').value.trim() || '';
  if (!token) throw new Error('Access Token Dropbox requis');
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path || '', recursive: false }) });
  if (!res.ok) throw new Error('Token Dropbox invalide');
  return (await res.json()).entries?.filter(e => e['.tag'] === 'file').map(f => ({ id: f.id, name: f.name, size: f.size ? formatSize(f.size) : '—', source: 'dropbox' })) || [];
}

async function listOneDriveFiles() {
  const token = document.getElementById('onedriveToken').value.trim();
  if (!token) throw new Error('Access Token OneDrive requis');
  const res = await fetch('https://graph.microsoft.com/v1.0/me/drive/root/children?$select=id,name,size,file', { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Token OneDrive invalide');
  return (await res.json()).value?.filter(f => f.file).map(f => ({ id: f.id, name: f.name, size: f.size ? formatSize(f.size) : '—', source: 'onedrive' })) || [];
}

function renderStorageFiles(files) {
  const wrap = document.getElementById('storageWrap');
  const list = document.getElementById('storageList');
  state.selectedStorageFiles.clear(); list.innerHTML = '';
  if (!files.length) { list.innerHTML = '<p style="color:var(--t500);font-size:.875rem">Aucun fichier trouvé.</p>'; wrap.style.display = 'block'; return; }
  files.forEach(file => {
    const ext = file.name.split('.').pop().toLowerCase();
    const ico = { pdf: '📄', docx: '📝', xlsx: '📊', csv: '📋', txt: '📃' }[ext] || '📎';
    const row = document.createElement('div'); row.className = 'storage-row';
    row.innerHTML = `<input type="checkbox" style="accent-color:var(--orange)" onchange="toggleStorageFile('${file.id}',this)"><span class="storage-ico">${ico}</span><span class="storage-name">${escHtml(file.name)}</span><span class="storage-sz">${file.size}</span><div class="storage-acts"><button class="btn btn-sm btn-ghost" onclick="analyzeStorageFile('${encodeURIComponent(file.name)}','${file.id}','${file.source}')">🔍 Analyser</button></div>`;
    list.appendChild(row);
  });
  wrap.style.display = 'block';
}

function toggleStorageFile(id, cb) { if (cb.checked) state.selectedStorageFiles.add(id); else state.selectedStorageFiles.delete(id); }
function analyzeSelectedFiles() { if (!state.selectedStorageFiles.size) { showNotif('Sélectionnez au moins un fichier.'); return; } showNotif(`Analyse de ${state.selectedStorageFiles.size} fichier(s)…`); }

async function analyzeStorageFile(encodedName, fileId, source) {
  if (!checkConnection()) return;
  const name = decodeURIComponent(encodedName);
  showNotif(`Analyse de "${name}"…`);
  try {
    const result = await callAI(`Analyse ce fichier cloud nommé "${name}" (source: ${source}). Fournis un résumé exécutif en Markdown avec les points clés attendus pour ce type de fichier.`, 1000);
    document.getElementById('storageOutput').innerHTML = `
      <div class="output-bar"><span class="output-lbl">📂 ${escHtml(name)}</span><div class="output-acts"><button class="btn btn-sm btn-ghost" onclick="copyOutput('storageContent')">📋 Copier</button><button class="btn btn-sm btn-primary" onclick="exportPdf('storageContent')">⬇️ PDF</button></div></div>
      <div class="output-body" id="storageContent">${markdownToHtml(result)}</div>`;
    document.getElementById('storageOutput').style.display = 'block';
    addToLibrary({ title: 'Cloud — ' + name, content: result, module: 'storage' });
  } catch (err) { showNotif(err.message); }
}

// ── EXPORT ─────────────────────────────────────────────────
function copyOutput(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => showNotif('✓ Copié'));
}

async function exportPdf(contentId) {
  const el = document.getElementById(contentId);
  if (!el) return;
  showNotif('Génération PDF…');
  try {
    const canvas = await html2canvas(el, { backgroundColor: '#050c1a', scale: 2, useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const w = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const h = canvas.height * w / canvas.width;
    let y = 0;
    while (y < h) {
      const sc = document.createElement('canvas');
      sc.width = canvas.width; sc.height = Math.min(canvas.height, (pageH * canvas.width) / w);
      sc.getContext('2d').drawImage(canvas, 0, -(y * canvas.width / w), canvas.width, canvas.height);
      pdf.addImage(sc.toDataURL('image/png'), 'PNG', 0, 0, w, Math.min(pageH, h - y));
      y += pageH; if (y < h) pdf.addPage();
    }
    pdf.save('archiva-document.pdf'); showNotif('✓ PDF téléchargé');
  } catch { showNotif('Erreur PDF.'); }
}

async function exportFullReport() {
  const analysisEl = document.getElementById('analysisContent');
  const chartsEl   = document.getElementById('chartsArea');
  if (!analysisEl) return;
  showNotif('Génération du rapport…');
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'background:#050c1a;padding:2rem;color:#e2e8f0;font-family:Inter,sans-serif';
  wrapper.appendChild(analysisEl.cloneNode(true));
  if (chartsEl) wrapper.appendChild(chartsEl.cloneNode(true));
  document.body.appendChild(wrapper);
  try {
    const canvas = await html2canvas(wrapper, { backgroundColor: '#050c1a', scale: 2, useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const w = pdf.internal.pageSize.getWidth();
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, canvas.height * w / canvas.width);
    pdf.save('archiva-rapport.pdf'); showNotif('✓ PDF téléchargé');
  } catch { showNotif('Erreur export.'); }
  finally { document.body.removeChild(wrapper); }
}

// ── PARTENAIRES ────────────────────────────────────────────
const PARTNER_PASSWORD = 'Archiva2025!'; // ← changez ce mot de passe ici

function loadPartners() {
  try { return JSON.parse(localStorage.getItem('archiva_partners') || '[]'); }
  catch { return []; }
}
function savePartners(list) {
  localStorage.setItem('archiva_partners', JSON.stringify(list));
}

function renderPartners() {
  const grid  = document.getElementById('partnersGrid');
  const empty = document.getElementById('partnersEmpty');
  if (!grid) return;
  const list = loadPartners();
  if (!list.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = list.map((p, i) => `
    <div class="partner-card">
      <div class="partner-card-emoji">${p.emoji || '🤝'}</div>
      <h3 class="partner-card-title">${escHtml(p.title)}</h3>
      <p class="partner-card-desc">${escHtml(p.desc)}</p>
      ${p.code ? `<div class="partner-code-badge">🔑 ${escHtml(p.code)}</div>` : ''}
      <button class="btn btn-ghost btn-sm partner-delete-btn" onclick="confirmDeletePartner(${i})">Supprimer</button>
    </div>
  `).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openPartnerAuth() {
  const modal = document.getElementById('partnerAuthModal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('partnerAuthInput').value = '';
    document.getElementById('partnerAuthError').style.display = 'none';
    setTimeout(() => document.getElementById('partnerAuthInput').focus(), 50);
  }
}
function closePartnerAuth() {
  const modal = document.getElementById('partnerAuthModal');
  if (modal) modal.style.display = 'none';
}

function checkPartnerAuth() {
  const val = document.getElementById('partnerAuthInput').value;
  if (val === PARTNER_PASSWORD) {
    closePartnerAuth();
    openPartnerAdd();
  } else {
    document.getElementById('partnerAuthError').style.display = 'block';
    document.getElementById('partnerAuthInput').value = '';
    document.getElementById('partnerAuthInput').focus();
  }
}

function openPartnerAdd() {
  const modal = document.getElementById('partnerAddModal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('partnerEmoji').value = '';
    document.getElementById('partnerTitle').value = '';
    document.getElementById('partnerDesc').value  = '';
    document.getElementById('partnerCode').value  = '';
    setTimeout(() => document.getElementById('partnerTitle').focus(), 50);
  }
}
function closePartnerAdd() {
  const modal = document.getElementById('partnerAddModal');
  if (modal) modal.style.display = 'none';
}

function savePartner() {
  const emoji = document.getElementById('partnerEmoji').value.trim() || '🤝';
  const title = document.getElementById('partnerTitle').value.trim();
  const desc  = document.getElementById('partnerDesc').value.trim();
  const code  = document.getElementById('partnerCode').value.trim().toUpperCase();
  if (!title) { showNotif('Le titre est obligatoire.'); return; }
  if (!desc)  { showNotif('La description est obligatoire.'); return; }
  if (!code)  { showNotif('Le code partenaire est obligatoire.'); return; }
  const list = loadPartners();
  if (list.some(p => p.code === code)) { showNotif('Ce code est déjà utilisé par un autre partenaire.'); return; }
  list.push({ emoji, title, desc, code });
  savePartners(list);
  renderPartners();
  closePartnerAdd();
  showNotif('✓ Partenaire ajouté.');
}

function confirmDeletePartner(index) {
  const pw = prompt('Entrez le mot de passe administrateur pour supprimer ce partenaire :');
  if (pw === PARTNER_PASSWORD) {
    const list = loadPartners();
    list.splice(index, 1);
    savePartners(list);
    renderPartners();
    showNotif('Partenaire supprimé.');
  } else if (pw !== null) {
    showNotif('Mot de passe incorrect.');
  }
}

// ── MODAL ACHAT + STRIPE ───────────────────────────────────
const STRIPE_PUB_KEY = 'pk_live_51TPbrzJqhcsMOyVS72huiP10Z3oll5Rl1r8hn7Vhq2hV48B5CvN4PJ9T2FFtznTspqdz5EufdhxJpRN8Logbjxet00A3nrZzA8';

const STRIPE_PRODUCTS = {
  'pro-mensuel':        'prod_UOOnnUxP5ugY6J',
  'pro-annuel':         'prod_UToPyjLGc4P78s',
  'entreprise-mensuel': 'prod_UTl6uQBtZfbgwN',
  'entreprise-annuel':  'prod_UTl7nKtP1jGmaQ',
};

const PLAN_LABELS = {
  'pro':        { name: 'Pro',        mensuel: '57€/mois',  annuel: '48€/mois' },
  'entreprise': { name: 'Entreprise', mensuel: '147€/mois', annuel: '125€/mois' },
};

let currentPurchasePlanKey = '';

function openPurchaseModal(planKey) {
  if (planKey === 'sur-devis') { showPage('contact'); return; }
  currentPurchasePlanKey = planKey;
  const period   = state.pricingAnnual ? 'annuel' : 'mensuel';
  const label    = PLAN_LABELS[planKey];
  const price    = label[period];
  document.getElementById('purchasePlanName').textContent  = label.name;
  document.getElementById('purchasePlanBadge').textContent = label.name;
  document.getElementById('purchasePlanPrice').textContent = price + (state.pricingAnnual ? ' · facturation annuelle' : '');
  document.getElementById('purchasePartnerCode').value     = '';
  document.getElementById('purchaseModal').style.display   = 'flex';
  setTimeout(() => document.getElementById('purchasePartnerCode').focus(), 50);
}
function closePurchaseModal() {
  document.getElementById('purchaseModal').style.display = 'none';
}

async function confirmPurchase() {
  const code = document.getElementById('purchasePartnerCode').value.trim().toUpperCase();


  if (!isAuthenticated()) {
    showNotif('Veuillez vous connecter avant de souscrire.');
    closePurchaseModal();
    showPage('login');
    return;
  }

  const period    = state.pricingAnnual ? 'annuel' : 'mensuel';
  const productId = STRIPE_PRODUCTS[currentPurchasePlanKey + '-' + period];

  if (code) sessionStorage.setItem('archiva_partner_code', code);
  else      sessionStorage.removeItem('archiva_partner_code');

  const btn = document.querySelector('#purchaseModal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Redirection…'; }

  try {
    const data = await apiRequest('/api/stripe/checkout', {
      method: 'POST',
      body: JSON.stringify({ productId }),
    });
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || 'Erreur inconnue');
    }
  } catch (err) {
    showNotif('Erreur lors du paiement : ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Continuer vers le paiement →'; }
  }
}

// Gère le retour depuis Stripe (success ou cancelled)
function handleStripeReturn() {
  const params  = new URLSearchParams(window.location.search);
  const payment = params.get('payment');
  if (!payment) return;
  window.history.replaceState({}, '', '/');
  if (payment === 'success') {
    const sessionId = params.get('session_id');
    showNotif('🎉 Paiement réussi ! Votre abonnement est activé.');
    if (sessionId && isAuthenticated()) {
      apiRequest(`/api/stripe/session/${sessionId}`).then(data => {
        if (data.planInfo) {
          state.userPlan = data.planInfo.plan;
          showNotif(`✓ Plan ${data.planInfo.plan} actif — bienvenue !`);
          fetchUserPlan();
        }
      }).catch(() => {});
    }
  } else if (payment === 'cancelled') {
    showNotif('Paiement annulé. Vous pouvez réessayer à tout moment.');
  }
}

// ── INTÉGRATIONS EXTERNES ──────────────────────────────────
const INTEG_CONFIG = {
  notion: {
    logo: '📝', name: 'Notion',
    desc: 'Connectez votre espace Notion via l\'Integration Token',
    fields: [
      { key: 'token',      label: 'Integration Token',          type: 'password', placeholder: 'secret_...' },
      { key: 'databaseId', label: 'Database ID (optionnel)',    type: 'text',     placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    ],
  },
  gsheets: {
    logo: '📊', name: 'Google Sheets',
    desc: 'Accédez à vos feuilles de calcul Google via l\'API',
    fields: [
      { key: 'apiKey',  label: 'API Key Google',  type: 'password', placeholder: 'AIzaSy...' },
      { key: 'sheetId', label: 'Spreadsheet ID',  type: 'text',     placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms' },
    ],
  },
  airtable: {
    logo: '🗄️', name: 'Airtable',
    desc: 'Connectez vos bases Airtable',
    fields: [
      { key: 'token',     label: 'Personal Access Token', type: 'password', placeholder: 'pat...' },
      { key: 'baseId',    label: 'Base ID',               type: 'text',     placeholder: 'appXXXXXXXXXXXXXX' },
      { key: 'tableName', label: 'Nom de la table',       type: 'text',     placeholder: 'Documents' },
    ],
  },
  n8n: {
    logo: '⚙️', name: 'N8N',
    desc: 'Déclenchez vos workflows N8N depuis Archiva',
    fields: [
      { key: 'url',    label: 'URL webhook N8N',  type: 'text',     placeholder: 'https://votre-n8n.app/webhook/...' },
      { key: 'apiKey', label: 'API Key N8N',      type: 'password', placeholder: 'n8n_api_...' },
    ],
  },
  slack: {
    logo: '💬', name: 'Slack',
    desc: 'Envoyez des notifications et fichiers vers Slack',
    fields: [
      { key: 'token',   label: 'Bot Token',              type: 'password', placeholder: 'xoxb-...' },
      { key: 'channel', label: 'ID du canal',            type: 'text',     placeholder: 'C0123456789' },
    ],
  },
  excel: {
    logo: '📈', name: 'Excel / OneDrive',
    desc: 'Accédez à vos fichiers Excel via Microsoft Graph',
    fields: [
      { key: 'token',    label: 'Access Token Microsoft Graph', type: 'password', placeholder: 'eyJ...' },
      { key: 'tenantId', label: 'Tenant ID (optionnel)',        type: 'text',     placeholder: 'xxxxxxxx-xxxx-...' },
    ],
  },
  trello: {
    logo: '📌', name: 'Trello',
    desc: 'Importez vos tableaux et cartes Trello',
    fields: [
      { key: 'apiKey', label: 'API Key Trello', type: 'text',     placeholder: '32 caractères hexadécimaux' },
      { key: 'token',  label: 'Token Trello',   type: 'password', placeholder: '64 caractères hexadécimaux' },
      { key: 'listId', label: 'ID de la liste', type: 'text',     placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
  },
  googlekeep: {
    logo: '🟡', name: 'Google Keep',
    desc: 'Bientôt disponible',
    fields: [],
  },
};

function loadIntegrations() {
  try { return JSON.parse(localStorage.getItem('archiva_integrations') || '{}'); } catch { return {}; }
}
function saveIntegrations(obj) { localStorage.setItem('archiva_integrations', JSON.stringify(obj)); }

function renderIntegrations() {
  const integs = loadIntegrations();
  Object.keys(INTEG_CONFIG).forEach(key => {
    const dot = document.getElementById('status-' + key)?.querySelector('.integ-dot');
    const btn = document.querySelector(`#integ-${key} .integ-btn`);
    if (!dot) return;
    if (integs[key]) {
      dot.className = 'integ-dot on';
      if (btn && !btn.disabled) { btn.textContent = 'Déconnecter'; btn.onclick = () => disconnectInteg(key); }
    } else {
      dot.className = key === 'googlekeep' ? 'integ-dot soon' : 'integ-dot off';
      if (btn && !btn.disabled) { btn.textContent = 'Connecter'; btn.onclick = () => openIntegModal(key); }
    }
  });
}

let currentIntegKey = '';
function openIntegModal(key) {
  const cfg   = INTEG_CONFIG[key];
  if (!cfg) return;
  const integs = loadIntegrations();
  currentIntegKey = key;

  document.getElementById('integModalLogo').textContent  = cfg.logo;
  document.getElementById('integModalTitle').textContent = 'Connecter ' + cfg.name;
  document.getElementById('integModalDesc').textContent  = cfg.desc;
  document.getElementById('integModalError').style.display = 'none';

  const saved  = integs[key] || {};
  const fields = document.getElementById('integModalFields');
  fields.innerHTML = cfg.fields.map(f => `
    <div class="form-field" style="margin-bottom:1rem">
      <label style="display:block;font-size:.82rem;font-weight:600;color:var(--t200);margin-bottom:.5rem">${f.label}</label>
      <input
        type="${f.type}"
        class="form-input"
        id="integ-field-${f.key}"
        placeholder="${f.placeholder}"
        value="${escHtml(typeof saved === 'object' ? (saved[f.key] || '') : (cfg.fields.length === 1 ? (saved || '') : ''))}"
        autocomplete="off">
    </div>`).join('');

  document.getElementById('integModal').style.display = 'flex';
  const first = fields.querySelector('input');
  if (first) setTimeout(() => first.focus(), 80);
}

function closeIntegModal() { document.getElementById('integModal').style.display = 'none'; }

function saveIntegration() {
  const cfg    = INTEG_CONFIG[currentIntegKey];
  if (!cfg) return;
  const errEl  = document.getElementById('integModalError');
  errEl.style.display = 'none';

  const data = {};
  for (const f of cfg.fields) {
    const val = document.getElementById('integ-field-' + f.key)?.value.trim() || '';
    data[f.key] = val;
  }

  const requiredFields = cfg.fields.filter((_, i) => i === 0);
  const firstVal = cfg.fields.length ? data[cfg.fields[0].key] : '';
  if (cfg.fields.length && !firstVal) {
    errEl.textContent = 'Le champ "' + cfg.fields[0].label + '" est requis.';
    errEl.style.display = 'block';
    return;
  }

  const integs = loadIntegrations();
  integs[currentIntegKey] = cfg.fields.length === 1 ? firstVal : data;
  saveIntegrations(integs);
  renderIntegrations();
  closeIntegModal();
  showNotif('✓ ' + cfg.name + ' connecté.');
}

function disconnectInteg(key) {
  const integs = loadIntegrations();
  delete integs[key];
  saveIntegrations(integs);
  renderIntegrations();
  showNotif('Intégration déconnectée.');
}

// ── DÉTECTION ET EXÉCUTION AUTOMATIQUE DES INTÉGRATIONS ────
const INTEG_KEYWORDS = {
  notion:   ['notion'],
  gsheets:  ['google sheets', 'google sheet', 'sheets', 'spreadsheet', 'tableur'],
  airtable: ['airtable'],
  n8n:      ['n8n'],
  slack:    ['slack'],
  excel:    ['excel', 'onedrive'],
  trello:   ['trello'],
};

function detectIntegCommands(text) {
  const lower = text.toLowerCase();
  return Object.entries(INTEG_KEYWORDS)
    .filter(([, kws]) => kws.some(kw => lower.includes(kw)))
    .map(([key]) => key);
}

async function executeIntegration(toolKey, title, content) {
  const integs = loadIntegrations();
  const creds  = integs[toolKey];
  if (!creds) {
    showNotif(`⚠️ ${INTEG_CONFIG[toolKey]?.name || toolKey} n'est pas connecté dans les intégrations.`);
    return;
  }

  const toolName = INTEG_CONFIG[toolKey]?.name || toolKey;
  showNotif(`⏳ Export vers ${toolName}…`);

  const body = { title, content };
  if (typeof creds === 'string') { body.token = creds; }
  else { Object.assign(body, creds); }

  try {
    const res  = await fetch(`/api/integ/${toolKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success) {
      const link = data.url
        ? ` <a href="${data.url}" target="_blank" rel="noopener" style="color:var(--orange);text-decoration:underline">Ouvrir →</a>`
        : '';
      showNotifHtml(`✓ Exporté dans ${toolName} !${link}`);
    } else {
      showNotif(`✗ ${toolName} : ${data.error || 'Erreur inconnue'}`);
    }
  } catch (err) {
    showNotif(`✗ Erreur réseau vers ${toolName} : ${err.message}`);
  }
}

function showNotifHtml(html) {
  let notif = document.getElementById('globalNotif');
  if (!notif) {
    notif = document.createElement('div');
    notif.id = 'globalNotif';
    notif.style.cssText = 'position:fixed;top:80px;right:1.25rem;z-index:3000;background:rgba(11,22,40,.97);border:1px solid rgba(249,115,22,.3);color:var(--t100);font-size:.85rem;font-weight:500;padding:.7rem 1.25rem;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);backdrop-filter:blur(12px);transition:opacity .3s ease;max-width:360px;line-height:1.55';
    document.body.appendChild(notif);
  }
  notif.innerHTML = html;
  notif.style.opacity = '1';
  clearTimeout(_notifTimeout);
  _notifTimeout = setTimeout(() => { notif.style.opacity = '0'; }, 6000);
}

async function checkAndRunInteg(instructions, content, title) {
  if (!instructions) return;
  const tools = detectIntegCommands(instructions);
  for (const tool of tools) {
    await executeIntegration(tool, title, content);
  }
}


// ── CONTACT ────────────────────────────────────────────────
function submitContact() {
  const fn   = document.getElementById('cFirstname').value.trim();
  const ln   = document.getElementById('cLastname').value.trim();
  const em   = document.getElementById('cEmail').value.trim();
  const su   = document.getElementById('cSubject').value;
  const ms   = document.getElementById('cMessage').value.trim();
  const rg   = document.getElementById('cRgpd').checked;
  const plan = sessionStorage.getItem('archiva_purchase_plan') || '';
  const code = sessionStorage.getItem('archiva_partner_code') || '';
  if (!fn || !ln) { showNotif('Prénom et nom requis.'); return; }
  if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { showNotif('Email invalide.'); return; }
  if (!su) { showNotif('Veuillez sélectionner un sujet.'); return; }
  if (!ms) { showNotif('Veuillez écrire votre message.'); return; }
  if (!rg) { showNotif('Veuillez accepter la politique de confidentialité.'); return; }
  document.getElementById('contactFormArea').style.display = 'none';
  document.getElementById('successEmail').textContent = em;
  document.getElementById('contactSuccess').style.display = 'flex';
  const planLine = plan ? `Plan choisi: ${plan}\n` : '';
  const codeLine = code ? `Code partenaire: ${code}\n` : '';
  const body = `Prénom: ${fn}\nNom: ${ln}\nEmail: ${em}\nTél: ${document.getElementById('cPhone').value}\nEntreprise: ${document.getElementById('cCompany').value}\n${planLine}${codeLine}\n${ms}`;
  window.location.href = `mailto:a.e.l.corporation@hotmail.com?subject=${encodeURIComponent('[Archiva] ' + su + ' — ' + fn + ' ' + ln)}&body=${encodeURIComponent(body)}`;
  sessionStorage.removeItem('archiva_purchase_plan');
  sessionStorage.removeItem('archiva_partner_code');
}
function resetContact() {
  ['cFirstname','cLastname','cEmail','cPhone','cCompany','cMessage'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('cSubject').value = '';
  document.getElementById('cRgpd').checked  = false;
  document.getElementById('contactFormArea').style.display = '';
  document.getElementById('contactSuccess').style.display  = 'none';
}

// ── MODALS ─────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open'); });

// ── COOKIES ────────────────────────────────────────────────
function acceptCookies()    { localStorage.setItem('archiva_cookies','all');       hideCookieBanner(); }
function rejectCookies()    { localStorage.setItem('archiva_cookies','essential'); hideCookieBanner(); }
function hideCookieBanner() { document.getElementById('cookieBanner').classList.add('hidden'); }
function toggleCookie(el)   { if (!el.classList.contains('disabled')) el.classList.toggle('on'); }
function saveCookiePrefs()  {
  localStorage.setItem('archiva_cookies', JSON.stringify({ analytics: document.getElementById('togAnalytics').classList.contains('on'), prefs: document.getElementById('togPrefs').classList.contains('on') }));
  closeModal('modalCookies'); hideCookieBanner(); showNotif('✓ Préférences sauvegardées');
}
function acceptAllCookies() {
  document.getElementById('togAnalytics').classList.add('on');
  document.getElementById('togPrefs').classList.add('on');
  saveCookiePrefs();
}

// ── FAQ ────────────────────────────────────────────────────
function toggleFaq(btn) {
  const item = btn.closest('.faq-item');
  const isOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
  if (!isOpen) item.classList.add('open');
}

// ── HELPERS ────────────────────────────────────────────────
function checkConnection() {
  if (!state.connected || !state.apiKey) {
    showPage('ai');
    setTimeout(() => showNotif('⚠️ Connectez votre clé API pour utiliser cette fonctionnalité.'), 300);
    return false;
  }
  return true;
}

function showError(boxId, msg) {
  const box = document.getElementById(boxId);
  box.innerHTML = `<div class="output-bar"><span class="output-lbl" style="color:var(--red)">⚠️ Erreur</span></div><div class="loading-box"><div style="font-size:2.5rem">⚠️</div><h3 style="color:var(--red)">Une erreur est survenue</h3><p>${escHtml(msg)}</p></div>`;
  box.style.display = 'block';
}

let _notifTimeout;
function showNotif(msg) {
  let notif = document.getElementById('globalNotif');
  if (!notif) {
    notif = document.createElement('div'); notif.id = 'globalNotif';
    notif.style.cssText = 'position:fixed;top:80px;right:1.25rem;z-index:3000;background:rgba(11,22,40,.97);border:1px solid rgba(249,115,22,.3);color:var(--t100);font-size:.85rem;font-weight:500;padding:.7rem 1.25rem;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);backdrop-filter:blur(12px);transition:opacity .3s ease;max-width:320px;line-height:1.4';
    document.body.appendChild(notif);
  }
  notif.textContent = msg; notif.style.opacity = '1';
  clearTimeout(_notifTimeout);
  _notifTimeout = setTimeout(() => { notif.style.opacity = '0'; }, 3500);
}

function markdownToHtml(md) {
  if (!md) return '';
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^#### (.+)$/gm,'<h4>$1</h4>')
    .replace(/^### (.+)$/gm,'<h3>$1</h3>')
    .replace(/^## (.+)$/gm,'<h2>$1</h2>')
    .replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/^---$/gm,'<hr>')
    .replace(/^\> (.+)$/gm,'<blockquote>$1</blockquote>')
    .replace(/^\| (.+) \|$/gm,(_,row)=>'<tr>'+row.split(' | ').map(c=>`<td>${c.trim()}</td>`).join('')+'</tr>')
    .replace(/(<tr>.*<\/tr>\n?)+/g,m=>`<table>${m}</table>`)
    .replace(/^\s*[-*] (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g,m=>`<ul>${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm,'<li>$1</li>')
    .replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── WHITE LABEL ────────────────────────────────────────────
function sanitizeSubdomain() {
  const inp = document.getElementById('wlSubdomain');
  inp.value = inp.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
}

function syncColorFromHex(key) {
  const hex = document.getElementById('wlColor' + key + 'Hex').value;
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    document.getElementById('wlColor' + key).value = hex;
    updateWlPreview();
  }
}

function applyWlTheme(primary, secondary, bg) {
  document.getElementById('wlColorPrimary').value     = primary;
  document.getElementById('wlColorPrimaryHex').value  = primary;
  document.getElementById('wlColorSecondary').value   = secondary;
  document.getElementById('wlColorSecondaryHex').value = secondary;
  document.getElementById('wlColorBg').value          = bg;
  document.getElementById('wlColorBgHex').value       = bg;
  updateWlPreview();
}

function updateWlPreview() {
  const name      = document.getElementById('wlName')?.value || 'MonSite';
  const tagline   = document.getElementById('wlTagline')?.value || 'L\'IA documentaire de votre entreprise';
  const primary   = document.getElementById('wlColorPrimary')?.value   || '#f97316';
  const secondary = document.getElementById('wlColorSecondary')?.value || '#6366f1';
  const bg        = document.getElementById('wlColorBg')?.value        || '#050c1a';
  const ctaText   = document.getElementById('wlCtaText')?.value        || 'Démarrer gratuitement';
  const heroDesc  = document.getElementById('wlHeroDesc')?.value       || '';
  // sync hex inputs
  document.getElementById('wlColorPrimaryHex').value   = primary;
  document.getElementById('wlColorSecondaryHex').value = secondary;
  document.getElementById('wlColorBgHex').value        = bg;
  // update preview
  const inner = document.getElementById('wlPreviewInner');
  if (inner) inner.style.background = bg;
  const logo = document.getElementById('wlPreviewLogo');
  if (logo) { logo.textContent = name; logo.style.color = primary; }
  const gradient = document.getElementById('wlPreviewGradient');
  if (gradient) gradient.style.background = `linear-gradient(135deg,${primary},${secondary})`;
  const sub = document.getElementById('wlPreviewSub');
  if (sub) sub.textContent = heroDesc || tagline;
  const cta = document.getElementById('wlPreviewCta');
  if (cta) { cta.textContent = ctaText || 'Démarrer gratuitement'; cta.style.background = primary; }
}

async function generateWhitelabel() {
  const name      = document.getElementById('wlName')?.value.trim();
  const subdomain = document.getElementById('wlSubdomain')?.value.trim();
  const statusEl  = document.getElementById('wlStatus');
  const resultEl  = document.getElementById('wlResult');
  if (!name)      { showNotif('Le nom du site est requis.'); return; }
  if (!subdomain) { showNotif('Le sous-domaine est requis.'); return; }
  if (!/^[a-z0-9-]{2,32}$/.test(subdomain)) { showNotif('Sous-domaine invalide (lettres minuscules, chiffres, tirets).'); return; }

  statusEl.textContent = '⏳ Génération en cours…';
  const config = {
    name,
    subdomain,
    tagline:   document.getElementById('wlTagline')?.value.trim()   || '',
    email:     document.getElementById('wlEmail')?.value.trim()     || '',
    heroDesc:  document.getElementById('wlHeroDesc')?.value.trim()  || '',
    ctaText:   document.getElementById('wlCtaText')?.value.trim()   || 'Démarrer gratuitement',
    lang:      document.getElementById('wlLang')?.value             || 'fr',
    font:      document.getElementById('wlFont')?.value             || 'Inter',
    logoStyle: document.getElementById('wlLogoStyle')?.value        || 'text',
    colors: {
      primary:   document.getElementById('wlColorPrimary')?.value   || '#f97316',
      secondary: document.getElementById('wlColorSecondary')?.value || '#6366f1',
      bg:        document.getElementById('wlColorBg')?.value        || '#050c1a',
    },
  };

  try {
    const token = localStorage.getItem('kinde_access_token') || '';
    const res   = await fetch('/api/whitelabel/create', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body:    JSON.stringify(config),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');
    statusEl.textContent = '';
    resultEl.style.display = 'block';
    document.getElementById('wlResultUrl').textContent = data.url;
    document.getElementById('wlResultUrl').href        = 'https://' + data.url;
  } catch (err) {
    statusEl.textContent = '✗ ' + err.message;
  }
}
