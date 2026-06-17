require('dotenv').config();
const express  = require('express');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const Stripe   = require('stripe');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const PORT   = process.env.PORT || 3000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const KINDE_DOMAIN = process.env.KINDE_DOMAIN || 'https://aelcorporation.kinde.com';
const JWKS = createRemoteJWKSet(new URL(`${KINDE_DOMAIN}/.well-known/jwks`));

// Wrapper pour capturer les erreurs dans les routes async (Express 4)
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Empêche les crashes sur promesses non gérées
process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));

// ── IN-MEMORY PLAN STORAGE ─────────────────────────────────
const userPlans = new Map();

const PRODUCT_PLAN = {
  'prod_UOOnnUxP5ugY6J': { plan: 'pro',        period: 'mensuel' },
  'prod_UToPyjLGc4P78s': { plan: 'pro',        period: 'annuel'  },
  'prod_UTl6uQBtZfbgwN': { plan: 'entreprise', period: 'mensuel' },
  'prod_UTl7nKtP1jGmaQ': { plan: 'entreprise', period: 'annuel'  },
  'prod_UidtCz0y33grQr': { plan: 'max',        period: 'mensuel' },
  'prod_UidulMoJXxiiqL': { plan: 'max',        period: 'annuel'  },
};

// ── KINDE AUTH MIDDLEWARE ──────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const { payload } = await jwtVerify(header.slice(7), JWKS, { issuer: KINDE_DOMAIN });
    req.userId    = payload.sub;
    req.userEmail = payload.email;
    req.userName  = [payload.given_name, payload.family_name].filter(Boolean).join(' ') || payload.email;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

// ── WEBHOOK STRIPE (raw body — doit être avant express.json) ──
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session   = event.data.object;
      const userId    = session.metadata?.userId;
      const productId = session.metadata?.productId;
      const planInfo  = PRODUCT_PLAN[productId];
      if (userId && planInfo) {
        userPlans.set(userId, {
          plan:             planInfo.plan,
          period:           planInfo.period,
          stripeCustomerId: session.customer,
          subscriptionId:   session.subscription,
        });
        console.log(`✓ Plan "${planInfo.plan}" activé pour ${userId}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      for (const [uid, data] of userPlans.entries()) {
        if (data.stripeCustomerId === sub.customer) {
          userPlans.delete(uid);
          console.log(`Subscription cancelled for ${uid}`);
          break;
        }
      }
    }

    res.json({ received: true });
  }
);

// ── MIDDLEWARES ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false, limit: '4mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.header('Access-Control-Allow-Origin',      origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers',     'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods',     'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════════════════════════
//  API ROUTES (protégées par Kinde)
// ══════════════════════════════════════════════════════════

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const planData = userPlans.get(req.userId) || { plan: 'gratuit', period: 'mensuel' };
  res.json({
    id:     req.userId,
    email:  req.userEmail,
    name:   req.userName || 'Utilisateur',
    plan:   planData.plan,
    period: planData.period,
  });
}));

app.post('/api/user/plan', requireAuth, wrap(async (req, res) => {
  const { plan } = req.body;
  const valid = ['gratuit', 'pro', 'entreprise', 'max'];
  if (!valid.includes(plan)) return res.status(400).json({ error: 'Plan invalide.' });
  const existing = userPlans.get(req.userId) || {};
  userPlans.set(req.userId, { ...existing, plan });
  res.json({ success: true, plan });
}));

app.post('/api/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const { productId } = req.body;
    if (!PRODUCT_PLAN[productId]) return res.status(400).json({ error: 'Produit invalide.' });

    const prices = await stripe.prices.list({ product: productId, active: true, limit: 1 });
    if (!prices.data.length) return res.status(400).json({ error: 'Aucun prix trouvé pour ce produit.' });

    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items:           [{ price: prices.data[0].id, quantity: 1 }],
      customer_email:       req.userEmail,
      success_url:          `${appUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${appUrl}/?payment=cancelled`,
      metadata:             { userId: req.userId, productId },
      locale:               'fr',
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stripe/session/:sessionId', requireAuth, async (req, res) => {
  try {
    const session  = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const planInfo = PRODUCT_PLAN[session.metadata?.productId] || null;
    res.json({ status: session.payment_status, planInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
//  INTEGRATION PROXY ROUTES (no Kinde auth — user provides credentials)
// ══════════════════════════════════════════════════════════

// Notion — créer une page
app.post('/api/integ/notion', wrap(async (req, res) => {
  const { token, databaseId, title, content } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Notion manquant' });

  const parent = databaseId ? { database_id: databaseId } : { workspace: true };
  const titleProp = databaseId
    ? { Name: { title: [{ text: { content: (title || 'Document Archiva').slice(0, 2000) } }] } }
    : { title: [{ text: { content: (title || 'Document Archiva').slice(0, 2000) } }] };

  const chunks = [];
  const text = (content || '').replace(/\n{3,}/g, '\n\n');
  for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
  const children = chunks.slice(0, 100).map(chunk => ({
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
  }));

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({ parent, properties: titleProp, children }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data.message || 'Erreur Notion' });
  res.json({ success: true, url: data.url });
}));

// Slack — poster un message
app.post('/api/integ/slack', wrap(async (req, res) => {
  const { token, channel, title, content } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Slack manquant' });

  const text = `*${(title || 'Document Archiva').slice(0, 150)}*\n\n${(content || '').slice(0, 3000)}`;
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channel || 'general', text }),
  });
  const data = await r.json();
  if (!data.ok) return res.status(400).json({ error: data.error || 'Erreur Slack' });
  res.json({ success: true });
}));

// N8N — déclencher un webhook
app.post('/api/integ/n8n', wrap(async (req, res) => {
  const { url, apiKey, title, content } = req.body;
  if (!url) return res.status(400).json({ error: 'URL N8N manquante' });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-N8N-API-KEY'] = apiKey;

  const r = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({ title: title || 'Document Archiva', content, source: 'archiva', timestamp: new Date().toISOString() }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => 'Erreur N8N');
    return res.status(r.status).json({ error: txt.slice(0, 200) });
  }
  res.json({ success: true });
}));

// Airtable — créer un enregistrement
app.post('/api/integ/airtable', wrap(async (req, res) => {
  const { token, baseId, tableName, title, content } = req.body;
  if (!token || !baseId) return res.status(400).json({ error: 'Token ou Base ID Airtable manquant' });

  const table = encodeURIComponent(tableName || 'Documents');
  const r = await fetch(`https://api.airtable.com/v0/${baseId}/${table}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { Nom: (title || 'Document Archiva').slice(0, 255), Contenu: (content || '').slice(0, 100000), Source: 'Archiva', Date: new Date().toISOString() } }),
  });
  const data = await r.json();
  if (data.error) return res.status(400).json({ error: data.error.message || 'Erreur Airtable' });
  res.json({ success: true, id: data.id });
}));

// Trello — créer une carte
app.post('/api/integ/trello', wrap(async (req, res) => {
  const { apiKey, token, listId, title, content } = req.body;
  if (!apiKey || !token) return res.status(400).json({ error: 'Clés Trello manquantes' });

  const params = new URLSearchParams({ key: apiKey, token, name: (title || 'Document Archiva').slice(0, 16384), desc: (content || '').slice(0, 16384) });
  if (listId) params.set('idList', listId);

  const r = await fetch(`https://api.trello.com/1/cards?${params}`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (data.message && !data.id) return res.status(400).json({ error: data.message });
  res.json({ success: true, url: data.url });
}));

// Google Sheets — ajouter une ligne
app.post('/api/integ/gsheets', wrap(async (req, res) => {
  const { apiKey, sheetId, title, content } = req.body;
  if (!sheetId) return res.status(400).json({ error: 'Spreadsheet ID manquant' });

  const range = 'A1';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=RAW&key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[new Date().toISOString(), title || 'Document Archiva', (content || '').slice(0, 50000)]] }),
  });
  const data = await r.json();
  if (data.error) return res.status(400).json({ error: data.error.message || 'Erreur Google Sheets' });
  res.json({ success: true });
}));

// Google Drive — upload file as text
app.post('/api/integ/gdrive', wrap(async (req, res) => {
  const { token, folderId, title, content } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Google Drive manquant' });

  const metadata = { name: (title || 'Document Archiva') + '.txt', mimeType: 'text/plain' };
  if (folderId) metadata.parents = [folderId];

  const boundary = '-------archiva_boundary';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    content || '',
    `--${boundary}--`,
  ].join('\r\n');

  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Erreur Google Drive' });
  res.json({ success: true, url: `https://drive.google.com/file/d/${data.id}/view` });
}));

// Dropbox — upload file
app.post('/api/integ/dropbox', wrap(async (req, res) => {
  const { token, path: dropboxPath, title, content } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Dropbox manquant' });

  const destPath = ((dropboxPath || '/Archiva') + '/' + (title || 'Document') + '.txt').replace(/\/+/g, '/');
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: destPath, mode: 'add', autorename: true }),
    },
    body: content || '',
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data.error_summary || 'Erreur Dropbox' });
  res.json({ success: true });
}));

// Gmail — send email with document content
app.post('/api/integ/gmail', wrap(async (req, res) => {
  const { token, to, title, content } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Gmail manquant' });
  if (!to)    return res.status(400).json({ error: 'Destinataire Gmail manquant' });

  const subject = title || 'Document Archiva';
  const body    = content || '';
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`
  ).toString('base64url');

  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Erreur Gmail' });
  res.json({ success: true });
}));

// Outlook — send email via Microsoft Graph
app.post('/api/integ/outlook', wrap(async (req, res) => {
  const { token, to, title, content } = req.body;
  if (!token) return res.status(400).json({ error: 'Token Outlook manquant' });
  if (!to)    return res.status(400).json({ error: 'Destinataire Outlook manquant' });

  const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: title || 'Document Archiva',
        body:    { contentType: 'Text', content: content || '' },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    }),
  });
  if (r.status === 202 || r.status === 200) return res.json({ success: true });
  const data = await r.json().catch(() => ({}));
  res.status(r.status).json({ error: data.error?.message || 'Erreur Outlook' });
}));

// ── WHITE LABEL ────────────────────────────────────────────
const whitelabelConfigs = new Map(); // subdomain -> config

app.post('/api/whitelabel/create', requireAuth, wrap(async (req, res) => {
  const { name, subdomain, tagline, heroDesc, ctaText, email, lang, font, logoStyle, colors } = req.body;
  if (!name || !subdomain) return res.status(400).json({ error: 'Nom et sous-domaine requis.' });
  if (!/^[a-z0-9-]{2,32}$/.test(subdomain)) return res.status(400).json({ error: 'Sous-domaine invalide.' });

  // Check plan — user must have entreprise
  const planData = userPlans.get(req.userId);
  if (!planData || planData.plan !== 'entreprise') {
    return res.status(403).json({ error: 'Réservé au plan Entreprise.' });
  }

  whitelabelConfigs.set(subdomain, {
    name, tagline: tagline || '', heroDesc: heroDesc || '', ctaText: ctaText || 'Démarrer gratuitement',
    email: email || '', lang: lang || 'fr', font: font || 'Inter', logoStyle: logoStyle || 'text',
    colors: colors || { primary: '#f97316', secondary: '#6366f1', bg: '#050c1a' },
    createdBy: req.userId, createdAt: new Date().toISOString(),
  });

  const appUrl = process.env.APP_URL || 'archiva.app';
  const host   = appUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  res.json({ success: true, url: `${subdomain}.${host}` });
}));

app.get('/api/whitelabel/config', (req, res) => {
  const host      = req.headers.host || '';
  const subdomain = host.split('.')[0];
  const config    = whitelabelConfigs.get(subdomain);
  if (!config) return res.json({ whitelabel: false });
  res.json({ whitelabel: true, config });
});

// Fallback SPA
app.get('*', (req, res) => {
  const host      = req.headers.host || '';
  const subdomain = host.split('.')[0];
  const wlConfig  = whitelabelConfigs.get(subdomain);
  if (wlConfig) {
    // Serve index.html with white label meta injected
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const safeJson = JSON.stringify(wlConfig).replace(/</g,'\\u003c');
    html = html.replace('</head>', `<script>window.__WL__=${safeJson};</script></head>`);
    // Hide the whitelabel page in generated sites
    html = html.replace('id="page-whitelabel"', 'id="page-whitelabel" style="display:none!important"');
    return res.send(html);
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware d'erreur global — empêche les crashes 500
app.use((err, req, res, next) => {
  console.error('Express error:', err.stack || err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur serveur interne', detail: err.message });
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✓ Archiva backend démarré sur le port ${PORT}`);
});
