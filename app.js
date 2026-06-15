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
  renderSignatures();
  renderTemplates();
  renderTriggers();
  setTimeout(checkTriggers, 3000);
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
  const allLib = loadLibrary();
  const lib    = allLib.filter(d => ['gen','extract','analysis'].includes(d.module));
  const grid   = document.getElementById('docGrid');
  const count  = document.getElementById('docLibCount');
  if (!grid) return;
  count.textContent = lib.length;

  if (!lib.length) {
    grid.innerHTML = '<p class="doc-lib-empty">Aucun document encore. Générez ou analysez un document pour le voir apparaître ici.</p>';
    return;
  }

  const icons = { gen: '📝', extract: '🔍', analysis: '📊', email: '📧', storage: '☁️', chat: '💬' };
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

  const templateCtx = buildTemplateContext(instr);
  const prompt = `Tu es un expert en rédaction professionnelle. Génère un(e) ${type} en ${lang}.
Contexte : ${company || 'Non précisé'} | Longueur : ${length}
Instructions : ${instr || 'Document standard professionnel'}${templateCtx}
Génère un document complet, structuré en Markdown (## H2, ### H3). Professionnel et complet.${templateCtx ? '\nRespecte strictement la structure et le style du/des modèle(s) de référence fourni(s).' : ''}`;

  try {
    advanceStep(1); setTimeout(() => advanceStep(2), 800);
    const result = await callAI(prompt, 3000);
    advanceStep(3);

    const activeSig = getActiveSignature();
    const sigBlock  = activeSig ? renderSignatureBlock(activeSig) : '';
    document.getElementById('genOutput').innerHTML = `
      <div class="output-bar"><span class="output-lbl">📝 ${escHtml(type)}</span><div class="output-acts"><button class="btn btn-sm btn-ghost" onclick="copyOutput('genContent')">📋 Copier</button><button class="btn btn-sm btn-primary" onclick="exportPdf('genContent')">⬇️ PDF</button></div></div>
      <div class="output-body" id="genContent">${markdownToHtml(result)}${sigBlock}</div>`;
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

  const extractInstrText = document.getElementById('extractPasteText')?.value || '';
  const extractTemplateCtx = buildTemplateContext(extractInstrText);
  const prompt = `Expert en analyse documentaire. Effectue une ${mode} du document suivant.
Réponds en Markdown structuré (##, listes, données en **gras**).${extractTemplateCtx}
DOCUMENT : ${text.slice(0, 12000)}`;

  try {
    advanceStep(1);
    const result = await callAI(prompt, 2500);
    document.getElementById('extractOutput').innerHTML = `
      <div class="output-bar"><span class="output-lbl">🔍 Résultats</span><div class="output-acts"><button class="btn btn-sm btn-ghost" onclick="copyOutput('extractContent')">📋 Copier</button><button class="btn btn-sm btn-primary" onclick="exportPdf('extractContent')">⬇️ PDF</button></div></div>
      <div class="output-body" id="extractContent">${markdownToHtml(result)}</div>`;

    addToLibrary({ title: mode + ' — ' + title, content: result, module: 'extract' });
    document.getElementById('extractOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    checkAndRunInteg(extractInstrText, result, mode + ' — ' + title);
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
  const analysisTemplateCtx = buildTemplateContext(context);
  const prompt = `Expert analyste de données. Réalise une ${type}.
Contexte : ${context || 'Analyse générale'}${analysisTemplateCtx}
DONNÉES : ${dataText.slice(0, 12000)}

Rapport Markdown avec : ## Synthèse, ## Analyse, ## Données clés (tableau), ## Tendances, ## Recommandations${analysisTemplateCtx ? '\nRespecte la structure du/des modèle(s) de référence fourni(s).' : ''}

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
  gdrive: {
    logo: '📁', name: 'Google Drive',
    desc: 'Sauvegardez vos documents directement dans Google Drive',
    fields: [
      { key: 'token',    label: 'Access Token Google Drive', type: 'password', placeholder: 'ya29.A0…' },
      { key: 'folderId', label: 'ID du dossier (optionnel)', type: 'text',     placeholder: '1BxiMVs0XRA5…' },
    ],
  },
  dropbox: {
    logo: '💧', name: 'Dropbox',
    desc: 'Exportez vos documents vers Dropbox',
    fields: [
      { key: 'token', label: 'Access Token Dropbox', type: 'password', placeholder: 'sl.A0…' },
      { key: 'path',  label: 'Dossier de destination', type: 'text',   placeholder: '/Documents/Archiva' },
    ],
  },
  gmail: {
    logo: '📧', name: 'Gmail',
    desc: 'Envoyez vos documents par email via Gmail',
    fields: [
      { key: 'token', label: 'Access Token Gmail',    type: 'password', placeholder: 'ya29.A0…' },
      { key: 'to',    label: 'Destinataire par défaut', type: 'text',   placeholder: 'destinataire@email.com' },
    ],
  },
  outlook: {
    logo: '📮', name: 'Outlook',
    desc: 'Envoyez vos documents par email via Outlook',
    fields: [
      { key: 'token', label: 'Access Token Microsoft Graph', type: 'password', placeholder: 'eyJ…' },
      { key: 'to',    label: 'Destinataire par défaut',      type: 'text',     placeholder: 'destinataire@email.com' },
    ],
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
      dot.className = 'integ-dot off';
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
  gdrive:   ['google drive', 'gdrive', 'drive google'],
  dropbox:  ['dropbox'],
  gmail:    ['gmail', 'google mail'],
  outlook:  ['outlook', 'hotmail'],
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

// ── ASSISTANT IA CHAT ──────────────────────────────────────
const chatMessages = [];

function renderChatMessage(msg) {
  const history = document.getElementById('chatHistory');
  if (!history) return;
  const div = document.createElement('div');
  const isUser = msg.role === 'user';
  div.style.cssText = `display:flex;gap:.65rem;align-items:flex-start;${isUser ? 'flex-direction:row-reverse' : ''}`;
  const avatar = document.createElement('div');
  avatar.style.cssText = 'width:2rem;height:2rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;' + (isUser ? 'background:rgba(99,102,241,.2)' : 'background:rgba(249,115,22,.15)');
  avatar.textContent = isUser ? '👤' : '🤖';
  const bubble = document.createElement('div');
  bubble.style.cssText = 'max-width:78%;padding:.7rem .95rem;border-radius:1rem;font-size:.875rem;line-height:1.6;' +
    (isUser ? 'background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.2);border-top-right-radius:.25rem'
            : 'background:var(--bg2);border:1px solid var(--border);border-top-left-radius:.25rem');
  bubble.innerHTML = isUser ? escHtml(msg.content) : markdownToHtml(msg.content);
  div.appendChild(avatar);
  div.appendChild(bubble);
  history.appendChild(div);
  history.scrollTop = history.scrollHeight;
}

function chatQuick(text) {
  const input = document.getElementById('chatInput');
  if (input) { input.value = text; sendChatMessage(); }
}

async function sendChatMessage() {
  if (!checkConnection()) return;
  const input = document.getElementById('chatInput');
  const text  = input?.value.trim();
  if (!text) return;
  input.value = '';

  const userMsg = { role: 'user', content: text };
  chatMessages.push(userMsg);
  renderChatMessage(userMsg);

  const btn = document.getElementById('chatSendBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }

  const integs    = loadIntegrations();
  const templates = loadTemplates();
  const lib       = loadLibrary();
  const connectedTools = Object.keys(integs).filter(k => integs[k]).join(', ') || 'aucun';
  const templateNames  = templates.map(t => t.name).join(', ') || 'aucun';
  const recentDocs     = lib.slice(0, 5).map(d => d.title).join(', ') || 'aucun';

  const systemContext = `Tu es l'assistant IA intégré d'Archiva, une plateforme SaaS de gestion documentaire.
Capacités disponibles :
- Générer des documents (contrats, rapports, propositions, etc.)
- Extraire et résumer des fichiers
- Analyser des données avec graphiques
- Exporter vers les outils connectés : ${connectedTools}
Modèles de documents disponibles : ${templateNames}
Documents récents en bibliothèque : ${recentDocs}

Réponds en français. Si l'utilisateur demande une génération de document, génère-le directement en Markdown complet et professionnel. Si l'utilisateur veut exporter, dis-lui ce que tu fais. Sois concis et utile.`;

  const history = chatMessages.slice(-6).map(m => ({ role: m.role, content: m.content }));

  try {
    const result = await callAI(systemContext + '\n\nConversation précédente :\n' + history.slice(0,-1).map(m => m.role + ': ' + m.content).join('\n') + '\n\nUtilisateur : ' + text, 2500);

    const assistantMsg = { role: 'assistant', content: result };
    chatMessages.push(assistantMsg);
    renderChatMessage(assistantMsg);

    if (result.length > 300 && (result.includes('##') || result.includes('**'))) {
      addToLibrary({ title: 'Chat — ' + text.slice(0, 60), content: result, module: 'chat' });
    }
    await checkAndRunInteg(text, result, 'Chat — ' + text.slice(0, 60));
    if (isTriggerRequest(text)) await createTriggerFromDescription(text);
  } catch (err) {
    const errMsg = { role: 'assistant', content: `Désolé, une erreur s'est produite : ${err.message}` };
    chatMessages.push(errMsg);
    renderChatMessage(errMsg);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'; }
  }
}

// ── SIGNATURES ────────────────────────────────────────────
function loadSignatures() {
  try { return JSON.parse(localStorage.getItem('archiva_signatures') || '[]'); } catch { return []; }
}
function saveSignaturesStore(arr) { localStorage.setItem('archiva_signatures', JSON.stringify(arr)); }

function buildSignatureText(sig) {
  const lines = [];
  if (sig.name)    lines.push(sig.name + (sig.title ? ` — ${sig.title}` : ''));
  if (sig.company) lines.push(sig.company);
  if (sig.email)   lines.push(sig.email);
  if (sig.phone)   lines.push(sig.phone);
  if (sig.website) lines.push(sig.website);
  return lines.join('\n');
}

function renderSignatureBlock(sig) {
  const initials = sig.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  return `
<div style="margin-top:2.5rem;padding-top:1.5rem;border-top:2px solid rgba(249,115,22,.3)">
  <div style="display:flex;align-items:center;gap:1rem">
    <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#f97316,#ea580c);display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:700;color:#fff;flex-shrink:0">${escHtml(initials)}</div>
    <div>
      <div style="font-size:1rem;font-weight:700;color:var(--t100)">${escHtml(sig.name)}${sig.title ? `<span style="font-weight:400;color:var(--t400);font-size:.875rem"> — ${escHtml(sig.title)}</span>` : ''}</div>
      ${sig.company ? `<div style="font-size:.82rem;color:var(--orange);font-weight:600;margin-top:.1rem">${escHtml(sig.company)}</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:.75rem;margin-top:.35rem">
        ${sig.email   ? `<span style="font-size:.78rem;color:var(--t400)">✉ ${escHtml(sig.email)}</span>` : ''}
        ${sig.phone   ? `<span style="font-size:.78rem;color:var(--t400)">📞 ${escHtml(sig.phone)}</span>` : ''}
        ${sig.website ? `<span style="font-size:.78rem;color:var(--t400)">🌐 ${escHtml(sig.website)}</span>` : ''}
      </div>
    </div>
  </div>
</div>`;
}

function getActiveSignature() {
  return loadSignatures().find(s => s.active) || null;
}

function renderSignatures() {
  const sigs  = loadSignatures();
  const count = document.getElementById('signaturesCount');
  if (count) count.textContent = sigs.length;
  const list = document.getElementById('signaturesList');
  if (!list) return;
  if (!sigs.length) {
    list.innerHTML = '<p style="font-size:.8rem;color:var(--t500);margin:.25rem 0 .5rem">Aucune signature. Cliquez sur ➕ pour en créer une.</p>';
    return;
  }
  list.innerHTML = sigs.map(s => `
    <div style="background:var(--bg2);border:1px solid ${s.active ? 'var(--orange)' : 'var(--border)'};border-radius:.5rem;padding:.65rem .9rem;display:flex;align-items:center;gap:.75rem">
      <div style="flex:1;min-width:0">
        <div style="font-size:.85rem;font-weight:600;color:var(--t100)">${escHtml(s.name)}${s.title ? ` <span style="font-weight:400;color:var(--t400)">— ${escHtml(s.title)}</span>` : ''}</div>
        <div style="font-size:.74rem;color:var(--t500);margin-top:.15rem">${[s.company, s.email].filter(Boolean).map(escHtml).join(' · ')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:.5rem;flex-shrink:0">
        ${s.active
          ? `<span style="font-size:.72rem;background:rgba(249,115,22,.12);color:var(--orange);padding:.2rem .5rem;border-radius:9999px;font-weight:600">Active</span>`
          : `<button onclick="activateSignature(${s.id})" style="font-size:.72rem;background:var(--glass);border:1px solid var(--border);color:var(--t300);padding:.2rem .5rem;border-radius:9999px;cursor:pointer">Activer</button>`}
        <button onclick="deleteSignature(${s.id})" style="background:none;border:none;color:var(--t400);cursor:pointer;font-size:.9rem" title="Supprimer">🗑</button>
      </div>
    </div>`).join('');
}

function toggleSignatures() {
  document.getElementById('signaturesBody').classList.toggle('open');
  document.getElementById('signaturesToggle').classList.toggle('open');
}

function openSignatureModal() {
  ['sigName','sigTitle','sigCompany','sigEmail','sigPhone','sigWebsite'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('signatureModalError').style.display = 'none';
  document.getElementById('signaturePreview').innerHTML = '<em style="color:var(--t500)">L\'aperçu apparaît ici…</em>';
  ['sigName','sigTitle','sigCompany','sigEmail','sigPhone','sigWebsite'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateSignaturePreview);
  });
  document.getElementById('signatureModal').style.display = 'flex';
  setTimeout(() => document.getElementById('sigName').focus(), 80);
}

function updateSignaturePreview() {
  const sig = {
    name: document.getElementById('sigName').value.trim(),
    title: document.getElementById('sigTitle').value.trim(),
    company: document.getElementById('sigCompany').value.trim(),
    email: document.getElementById('sigEmail').value.trim(),
    phone: document.getElementById('sigPhone').value.trim(),
    website: document.getElementById('sigWebsite').value.trim(),
  };
  const text = buildSignatureText(sig);
  document.getElementById('signaturePreview').innerHTML = text
    ? text.split('\n').map(l => `<div>${escHtml(l)}</div>`).join('')
    : '<em style="color:var(--t500)">L\'aperçu apparaît ici…</em>';
}

function closeSignatureModal() {
  document.getElementById('signatureModal').style.display = 'none';
}

function saveSignature() {
  const name = document.getElementById('sigName').value.trim();
  const errEl = document.getElementById('signatureModalError');
  errEl.style.display = 'none';
  if (!name) { errEl.textContent = 'Le nom est requis.'; errEl.style.display = 'block'; return; }

  const sigs = loadSignatures().map(s => ({ ...s, active: false }));
  sigs.unshift({
    id:      Date.now(),
    name,
    title:   document.getElementById('sigTitle').value.trim(),
    company: document.getElementById('sigCompany').value.trim(),
    email:   document.getElementById('sigEmail').value.trim(),
    phone:   document.getElementById('sigPhone').value.trim(),
    website: document.getElementById('sigWebsite').value.trim(),
    active:  true,
  });
  saveSignaturesStore(sigs);
  renderSignatures();
  closeSignatureModal();
  showNotif(`✍️ Signature "${name}" créée et activée.`);
}

function activateSignature(id) {
  saveSignaturesStore(loadSignatures().map(s => ({ ...s, active: s.id === id })));
  renderSignatures();
}

function deleteSignature(id) {
  saveSignaturesStore(loadSignatures().filter(s => s.id !== id));
  renderSignatures();
}

// ── MODÈLES DE DOCUMENTS ───────────────────────────────────
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem('archiva_templates') || '[]'); }
  catch { return []; }
}
function saveTemplatesStore(arr) {
  localStorage.setItem('archiva_templates', JSON.stringify(arr));
}

function renderTemplates() {
  const templates = loadTemplates();
  const count = document.getElementById('templatesCount');
  if (count) count.textContent = templates.length;
  const list = document.getElementById('templatesList');
  if (!list) return;
  if (!templates.length) {
    list.innerHTML = '<p style="font-size:.8rem;color:var(--t500);margin:0">Aucun modèle enregistré.</p>';
    return;
  }
  list.innerHTML = templates.map(t => `
    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg2);border:1px solid var(--border);border-radius:.5rem;padding:.6rem .85rem;gap:.75rem">
      <div style="min-width:0">
        <div style="font-size:.85rem;font-weight:600;color:var(--t100);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.name)}</div>
        <div style="font-size:.74rem;color:var(--t500);margin-top:.15rem">${t.date} · ${t.content.length} caractères</div>
      </div>
      <button onclick="deleteTemplate(${t.id})" style="background:none;border:none;color:var(--t400);font-size:1rem;cursor:pointer;flex-shrink:0;padding:.25rem" title="Supprimer">🗑</button>
    </div>`).join('');
}

function toggleTemplates() {
  document.getElementById('templatesBody').classList.toggle('open');
  document.getElementById('templatesToggle').classList.toggle('open');
}

// current file content stored while modal is open
let _templateFileContent = '';

function openTemplateModal() {
  _templateFileContent = '';
  document.getElementById('templateNameInput').value  = '';
  document.getElementById('templatePasteText').value  = '';
  document.getElementById('templateFilePreview').textContent = '';
  document.getElementById('templateModalError').style.display = 'none';
  switchTemplateTab('file');
  document.getElementById('templateModal').style.display = 'flex';
  setTimeout(() => document.getElementById('templateNameInput').focus(), 80);
}

function closeTemplateModal() {
  document.getElementById('templateModal').style.display = 'none';
}

function switchTemplateTab(tab) {
  document.getElementById('ttab-file').classList.toggle('active', tab === 'file');
  document.getElementById('ttab-paste').classList.toggle('active', tab === 'paste');
  document.getElementById('ttab-content-file').style.display  = tab === 'file'  ? '' : 'none';
  document.getElementById('ttab-content-paste').style.display = tab === 'paste' ? '' : 'none';
}

async function handleTemplateFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  document.getElementById('templateFilePreview').textContent = `Lecture de "${file.name}"…`;
  try {
    _templateFileContent = await readFileText(file);
    document.getElementById('templateFilePreview').textContent = `✓ "${file.name}" — ${_templateFileContent.length} caractères`;
  } catch (err) {
    document.getElementById('templateFilePreview').textContent = `✗ Erreur : ${err.message}`;
    _templateFileContent = '';
  }
}

async function handleTemplateFileDrop(event) {
  event.preventDefault();
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  document.getElementById('templateFilePreview').textContent = `Lecture de "${file.name}"…`;
  try {
    _templateFileContent = await readFileText(file);
    document.getElementById('templateFilePreview').textContent = `✓ "${file.name}" — ${_templateFileContent.length} caractères`;
  } catch (err) {
    document.getElementById('templateFilePreview').textContent = `✗ Erreur : ${err.message}`;
    _templateFileContent = '';
  }
}

function saveTemplate() {
  const name = document.getElementById('templateNameInput').value.trim();
  const errEl = document.getElementById('templateModalError');
  errEl.style.display = 'none';

  if (!name) { errEl.textContent = 'Veuillez donner un nom au modèle.'; errEl.style.display = 'block'; return; }

  const activeTab = document.getElementById('ttab-paste').classList.contains('active') ? 'paste' : 'file';
  let content = '';
  if (activeTab === 'paste') {
    content = document.getElementById('templatePasteText').value.trim();
    if (!content) { errEl.textContent = 'Veuillez coller du texte.'; errEl.style.display = 'block'; return; }
  } else {
    content = _templateFileContent;
    if (!content) { errEl.textContent = 'Veuillez importer un fichier.'; errEl.style.display = 'block'; return; }
  }

  const templates = loadTemplates();
  if (templates.find(t => t.name.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = `Un modèle nommé "${name}" existe déjà.`;
    errEl.style.display = 'block';
    return;
  }

  templates.unshift({
    id:      Date.now(),
    name,
    content: content.slice(0, 50000),
    date:    new Date().toLocaleDateString('fr-FR'),
  });
  saveTemplatesStore(templates);
  renderTemplates();
  closeTemplateModal();
  showNotif(`✓ Modèle "${name}" enregistré.`);
}

function deleteTemplate(id) {
  const templates = loadTemplates().filter(t => t.id !== id);
  saveTemplatesStore(templates);
  renderTemplates();
}

function buildTemplateContext(instructionText) {
  if (!instructionText) return '';
  const templates = loadTemplates();
  if (!templates.length) return '';
  const lower = instructionText.toLowerCase();
  const matched = templates.filter(t => lower.includes(t.name.toLowerCase()));
  if (!matched.length) return '';
  return matched.map(t =>
    `\n\n--- MODÈLE DE RÉFÉRENCE : "${t.name}" ---\n${t.content.slice(0, 8000)}\n--- FIN DU MODÈLE ---`
  ).join('');
}

// ── DÉCLENCHEURS & WORKFLOWS ───────────────────────────────
function loadTriggers() {
  try { return JSON.parse(localStorage.getItem('archiva_triggers') || '[]'); } catch { return []; }
}
function saveTriggersStore(arr) { localStorage.setItem('archiva_triggers', JSON.stringify(arr)); }

function renderTriggers() {
  const triggers = loadTriggers();
  const count = document.getElementById('triggersCount');
  if (count) count.textContent = triggers.length;
  const list = document.getElementById('triggersList');
  if (!list) return;
  if (!triggers.length) {
    list.innerHTML = '<p style="font-size:.8rem;color:var(--t500);margin:0">Aucun déclencheur configuré.</p>';
    return;
  }
  const freqLabel = { daily: 'Quotidien', weekly: 'Hebdomadaire', monthly: 'Mensuel' };
  const days = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
  list.innerHTML = triggers.map(t => {
    let schedLabel = freqLabel[t.freq] + ' à ' + t.time;
    if (t.freq === 'weekly')  schedLabel += ' — ' + (days[t.weekday] || '');
    if (t.freq === 'monthly') schedLabel += ' — jour ' + t.day;
    const lastRun = t.lastRun ? 'Dernière exécution : ' + new Date(t.lastRun).toLocaleDateString('fr-FR') : 'Jamais exécuté';
    return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:.5rem;padding:.7rem .9rem;display:flex;gap:.75rem;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          <span style="font-size:.85rem;font-weight:600;color:var(--t100)">${escHtml(t.name)}</span>
          <span style="font-size:.72rem;background:rgba(249,115,22,.12);color:var(--orange);padding:.15rem .45rem;border-radius:9999px">${schedLabel}</span>
          ${t.enabled ? '<span style="font-size:.72rem;background:rgba(16,185,129,.1);color:#10b981;padding:.15rem .45rem;border-radius:9999px">Actif</span>' : '<span style="font-size:.72rem;background:rgba(100,116,139,.1);color:var(--t400);padding:.15rem .45rem;border-radius:9999px">Pausé</span>'}
        </div>
        <div style="font-size:.77rem;color:var(--t400);margin-top:.3rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.action.slice(0, 80))}${t.action.length > 80 ? '…' : ''}</div>
        <div style="font-size:.72rem;color:var(--t500);margin-top:.2rem">${lastRun}</div>
      </div>
      <div style="display:flex;gap:.4rem;flex-shrink:0">
        <button onclick="toggleTriggerEnabled(${t.id})" style="background:none;border:none;cursor:pointer;font-size:.9rem;color:var(--t400)" title="${t.enabled ? 'Mettre en pause' : 'Activer'}">${t.enabled ? '⏸' : '▶️'}</button>
        <button onclick="deleteTrigger(${t.id})" style="background:none;border:none;cursor:pointer;font-size:.9rem;color:var(--t400)" title="Supprimer">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function toggleTriggers() {
  document.getElementById('triggersBody')?.classList.toggle('open');
  document.getElementById('triggersToggle')?.classList.toggle('open');
}

function openTriggerModal() {
  document.getElementById('triggerNameInput').value = '';
  document.getElementById('triggerAction').value    = '';
  document.getElementById('triggerFreq').value      = 'daily';
  document.getElementById('triggerTime').value      = '08:00';
  document.getElementById('triggerModalError').style.display = 'none';
  updateTriggerSchedule();
  document.getElementById('triggerModal').style.display = 'flex';
  setTimeout(() => document.getElementById('triggerNameInput').focus(), 80);
}

function closeTriggerModal() { document.getElementById('triggerModal').style.display = 'none'; }

function updateTriggerSchedule() {
  const freq = document.getElementById('triggerFreq').value;
  document.getElementById('triggerWeekdayField').style.display = freq === 'weekly'  ? '' : 'none';
  document.getElementById('triggerDayField').style.display     = freq === 'monthly' ? '' : 'none';
}

function saveTrigger() {
  const name   = document.getElementById('triggerNameInput').value.trim();
  const action = document.getElementById('triggerAction').value.trim();
  const errEl  = document.getElementById('triggerModalError');
  errEl.style.display = 'none';
  if (!name)   { errEl.textContent = 'Veuillez nommer le déclencheur.'; errEl.style.display = 'block'; return; }
  if (!action) { errEl.textContent = "Veuillez décrire l'action à effectuer."; errEl.style.display = 'block'; return; }

  const freq    = document.getElementById('triggerFreq').value;
  const time    = document.getElementById('triggerTime').value || '08:00';
  const weekday = parseInt(document.getElementById('triggerWeekday')?.value || '1');
  const day     = parseInt(document.getElementById('triggerDay')?.value || '1');

  const triggers = loadTriggers();
  triggers.unshift({ id: Date.now(), name, action, freq, time, weekday, day, enabled: true, lastRun: null });
  saveTriggersStore(triggers);
  renderTriggers();
  closeTriggerModal();
  showNotif(`⚡ Déclencheur "${name}" créé.`);
}

function deleteTrigger(id) {
  saveTriggersStore(loadTriggers().filter(t => t.id !== id));
  renderTriggers();
}

function toggleTriggerEnabled(id) {
  const triggers = loadTriggers().map(t => t.id === id ? { ...t, enabled: !t.enabled } : t);
  saveTriggersStore(triggers);
  renderTriggers();
}

async function checkTriggers() {
  if (!state.connected) return;
  const now = new Date();
  const triggers = loadTriggers();
  let changed = false;
  for (const t of triggers) {
    if (!t.enabled) continue;
    const [h, m] = (t.time || '08:00').split(':').map(Number);
    const shouldRun = (() => {
      const lastRun = t.lastRun ? new Date(t.lastRun) : null;
      const sameDay = (a, b) => a.toDateString() === b.toDateString();
      if (lastRun && sameDay(lastRun, now)) return false;
      if (now.getHours() < h || (now.getHours() === h && now.getMinutes() < m)) return false;
      if (t.freq === 'daily')   return true;
      if (t.freq === 'weekly')  return now.getDay() === (t.weekday ?? 1);
      if (t.freq === 'monthly') return now.getDate() === (t.day ?? 1);
      return false;
    })();
    if (!shouldRun) continue;
    t.lastRun = now.toISOString();
    changed = true;
    showNotif(`⚡ Exécution du déclencheur "${t.name}"…`);
    try {
      const result = await callAI(`Tu es l'assistant Archiva. Exécute cette tâche automatique : ${t.action}`, 2500);
      addToLibrary({ title: '⚡ ' + t.name, content: result, module: 'chat' });
      await checkAndRunInteg(t.action, result, t.name);
      showNotif(`✓ Déclencheur "${t.name}" exécuté.`);
    } catch (err) { showNotif(`✗ Déclencheur "${t.name}" : ${err.message}`); }
  }
  if (changed) saveTriggersStore(triggers);
}

function isTriggerRequest(text) {
  const lower = text.toLowerCase();
  const patterns = [
    'tous les matins', 'chaque matin', 'chaque jour', 'tous les jours',
    'chaque semaine', 'tous les lundis', 'tous les mardis', 'tous les mercredis',
    'tous les jeudis', 'tous les vendredis', 'chaque lundi', 'chaque vendredi',
    'le 1er du mois', 'chaque mois', 'tous les mois', 'le premier du mois',
    'automatiquement', 'automatise', 'planifie', 'programme', 'déclenche',
    'chaque semaine à', 'à 8h', 'à 9h', 'à 7h', 'chaque nuit',
  ];
  return patterns.some(p => lower.includes(p));
}

async function createTriggerFromDescription(text) {
  try {
    const parsePrompt = `Analyse cette description de workflow et extrais les paramètres sous forme de JSON strict.
Description : "${text}"

Réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format exact :
{"name":"nom court du déclencheur","freq":"daily|weekly|monthly","time":"HH:MM","weekday":1,"day":1,"action":"description complète de l'action à exécuter"}

Règles :
- freq: "daily" si quotidien, "weekly" si hebdomadaire, "monthly" si mensuel
- time: heure au format 24h (défaut "08:00")
- weekday: jour de semaine 0-6 (0=dimanche, 1=lundi)
- day: jour du mois 1-28
- action: reprend fidèlement l'action demandée en français`;

    const result  = await callAI(parsePrompt, 300);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);

    const triggers = loadTriggers();
    triggers.unshift({
      id:      Date.now(),
      name:    parsed.name   || text.slice(0, 50),
      action:  parsed.action || text,
      freq:    ['daily','weekly','monthly'].includes(parsed.freq) ? parsed.freq : 'daily',
      time:    /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : '08:00',
      weekday: parseInt(parsed.weekday) || 1,
      day:     parseInt(parsed.day)     || 1,
      enabled: true,
      lastRun: null,
    });
    saveTriggersStore(triggers);
    renderTriggers();

    const confirmMsg = { role: 'assistant', content: `⚡ **Déclencheur créé** : "${parsed.name}" — ${parsed.freq === 'daily' ? 'quotidien' : parsed.freq === 'weekly' ? 'hebdomadaire' : 'mensuel'} à ${parsed.time}. Visible dans la section Déclencheurs & Workflows.` };
    chatMessages.push(confirmMsg);
    renderChatMessage(confirmMsg);
  } catch { /* silently skip if parsing fails */ }
}

async function createTriggerFromChat() {
  if (!checkConnection()) return;
  const input = document.getElementById('triggerChatInput');
  const text  = input?.value.trim();
  if (!text) return;

  const btn = document.querySelector('#triggersBody button[onclick="createTriggerFromChat()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    const parsePrompt = `Analyse cette description de workflow et extrais les paramètres sous forme de JSON strict.
Description : "${text}"

Réponds UNIQUEMENT avec un JSON valide, sans texte autour, au format exact :
{"name":"nom court du déclencheur","freq":"daily|weekly|monthly","time":"HH:MM","weekday":1,"day":1,"action":"description complète de l'action à exécuter"}

Règles :
- freq: "daily" si quotidien, "weekly" si hebdomadaire, "monthly" si mensuel
- time: heure au format 24h (défaut "08:00")
- weekday: jour de semaine 0-6 (0=dimanche, 1=lundi) — pertinent si freq=weekly
- day: jour du mois 1-28 — pertinent si freq=monthly
- action: reprend fidèlement l'action demandée en français`;

    const result = await callAI(parsePrompt, 300);
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Format non reconnu');
    const parsed = JSON.parse(jsonMatch[0]);

    const triggers = loadTriggers();
    triggers.unshift({
      id:      Date.now(),
      name:    parsed.name    || text.slice(0, 50),
      action:  parsed.action  || text,
      freq:    ['daily','weekly','monthly'].includes(parsed.freq) ? parsed.freq : 'daily',
      time:    /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : '08:00',
      weekday: parseInt(parsed.weekday) || 1,
      day:     parseInt(parsed.day)     || 1,
      enabled: true,
      lastRun: null,
    });
    saveTriggersStore(triggers);
    renderTriggers();
    input.value = '';
    showNotif(`⚡ Déclencheur "${parsed.name || 'Nouveau'}" créé.`);
  } catch (err) {
    showNotif('✗ Impossible de créer le déclencheur : ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡'; }
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
