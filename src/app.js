import crypto from 'node:crypto';
import express from 'express';
import { config, PANEL_CREDENTIALS, applyPanelCredentials } from './config.js';
import { getSetting, setSetting, saveRule, deleteRule, getRule, logEvent } from './db.js';
import * as ig from './instagram.js';
import * as tt from './tiktok.js';
import * as yt from './youtube.js';
import * as fb from './facebook.js';
import { renderAdmin } from './admin.js';
import { createApiRouter, rotateApiKey } from './api.js';
import { buildRule, RuleError } from './rules.js';

function basicAuth(req, res, next) {
  if (!config.adminPassword) return res.status(503).send('Configura ADMIN_PASSWORD para usar el panel.');
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && value) {
    const [u, ...rest] = Buffer.from(value, 'base64').toString().split(':');
    const p = rest.join(':');
    const ok = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (ok(u, config.adminUser) && ok(p, config.adminPassword)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Kodevon Gate"').status(401).send('Autenticación requerida');
}

function newState(key) {
  const s = crypto.randomBytes(16).toString('hex');
  setSetting(key, s);
  return s;
}

const runAsync = (platform, fn) => {
  Promise.resolve().then(fn).catch((e) => logEvent(platform, 'error', e.message));
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => res.redirect('/admin'));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ---------- Páginas legales (requeridas por Meta / TikTok / Google) ----------
  const legal = (title, body) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Kodevon</title>
<style>body{font:16px/1.6 Inter,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1A1A1A}h1{font-family:Outfit,Inter,sans-serif}h1 b{color:#FF5F1F}</style></head>
<body><h1><b>Kodevon</b> · ${title}</h1>${body}<p style="color:#8C8C8C">Kodevon S.A.S · Popayán, Colombia · <a href="mailto:ventas@kodevon.com">ventas@kodevon.com</a></p></body></html>`;
  app.get('/privacidad', (_req, res) => res.send(legal('Política de privacidad', `
<p>Este servicio automatiza respuestas a comentarios y mensajes directos de las cuentas oficiales de Kodevon en Instagram, Facebook, TikTok y YouTube.</p>
<p><b>Datos que tratamos:</b> identificador de la conversación o del usuario en la plataforma, nombre de usuario, texto del comentario o mensaje y si la persona sigue nuestra cuenta. Solo se usan para responder y entregar el contenido solicitado.</p>
<p><b>No vendemos ni compartimos</b> estos datos con terceros. Se almacenan en nuestro propio servidor y se conservan solo el tiempo necesario para operar el servicio.</p>
<p>Puedes solicitar la eliminación de tus datos en <a href="/eliminar-datos">/eliminar-datos</a>.</p>`)));
  app.get('/eliminar-datos', (_req, res) => res.send(legal('Eliminación de datos', `
<p>Para eliminar los datos asociados a tus interacciones con nuestras cuentas, escribe a <a href="mailto:ventas@kodevon.com?subject=Eliminar%20mis%20datos">ventas@kodevon.com</a> con el asunto <b>"Eliminar mis datos"</b> e indica tu nombre de usuario de Instagram, Facebook, TikTok o YouTube.</p>
<p>Eliminaremos tus datos en un plazo máximo de 15 días hábiles y te confirmaremos por correo.</p>`)));
  app.get('/terminos', (_req, res) => res.send(legal('Términos del servicio', `
<p>Al comentar o escribir una palabra clave a nuestras cuentas aceptas recibir una respuesta automática con el contenido solicitado. El servicio es gratuito y puede cambiar o suspenderse en cualquier momento.</p>`)));

  // ---------- Instagram ----------
  app.get('/webhooks/instagram', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && config.instagram.verifyToken && req.query['hub.verify_token'] === config.instagram.verifyToken) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });
  app.post('/webhooks/instagram', (req, res) => {
    if (!ig.verifySignature(req.rawBody || '', req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200);
    // Si la app de Meta manda aquí también los eventos de la página (object "page"), van a Facebook.
    if (req.body?.object === 'page') runAsync('facebook', () => fb.handleWebhook(req.body));
    else runAsync('instagram', () => ig.handleWebhook(req.body));
  });

  // ---------- Facebook (página) ----------
  app.get('/webhooks/facebook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && config.instagram.verifyToken && req.query['hub.verify_token'] === config.instagram.verifyToken) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });
  app.post('/webhooks/facebook', (req, res) => {
    if (!ig.verifySignature(req.rawBody || '', req.get('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200);
    runAsync('facebook', () => fb.handleWebhook(req.body));
  });

  // ---------- TikTok ----------
  app.post('/webhooks/tiktok', (req, res) => {
    if (!tt.verifySignature(req.rawBody || '', req.get('tiktok-signature'))) return res.sendStatus(401);
    res.sendStatus(200);
    runAsync('tiktok', () => tt.handleWebhook(req.body));
  });
  app.get('/tiktok/callback', async (req, res) => {
    if (!req.query.state || req.query.state !== getSetting('tt_state')) return res.status(400).send('Estado inválido');
    try { await tt.exchangeCode(String(req.query.code || '')); res.redirect('/admin?tab=conexiones&ok=TikTok+conectado'); }
    catch (e) { logEvent('tiktok', 'error', e.message); res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Error TikTok: ${e.message}`)}`); }
  });

  // ---------- YouTube ----------
  app.get('/youtube/callback', async (req, res) => {
    if (!req.query.state || req.query.state !== getSetting('yt_state')) return res.status(400).send('Estado inválido');
    try { await yt.exchangeCode(String(req.query.code || '')); res.redirect('/admin?tab=conexiones&ok=YouTube+conectado'); }
    catch (e) { logEvent('youtube', 'error', e.message); res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Error YouTube: ${e.message}`)}`); }
  });

  // ---------- API ----------
  app.use('/api/v1', createApiRouter());

  // ---------- Panel ----------
  const admin = express.Router();
  admin.use(basicAuth);
  admin.get('/', (req, res) => res.send(renderAdmin({ flash: req.query.ok ? String(req.query.ok) : '', tab: String(req.query.tab || 'instagram') })));
  admin.post('/rules', async (req, res) => {
    const b = { ...req.body, active: req.body.active === 'on' };
    try {
      const existing = b.id ? getRule(Number(b.id)) : null;
      const rule = await buildRule(b, { existing });
      saveRule(existing ? { ...rule, id: existing.id } : rule);
    } catch (e) {
      const msg = e instanceof RuleError ? e.message : `No se guardó: ${e.message}`;
      return res.redirect(`/admin?tab=${encodeURIComponent(b.platform || 'instagram')}&ok=${encodeURIComponent(msg)}`);
    }
    res.redirect(`/admin?tab=${encodeURIComponent(b.platform || 'instagram')}&ok=Regla+guardada`);
  });
  admin.post('/api-key/rotate', (_req, res) => {
    if (config.apiKey) return res.redirect('/admin?tab=conexiones&ok=La+clave+viene+de+API_KEY+en+Coolify;+c%C3%A1mbiala+all%C3%AD');
    rotateApiKey();
    res.redirect('/admin?tab=conexiones&ok=Nueva+API+key+generada');
  });
  admin.post('/credentials', (req, res) => {
    let n = 0;
    for (const key of Object.keys(PANEL_CREDENTIALS)) {
      const v = String(req.body[key] ?? '').trim();
      if (v) { setSetting(key, v); n++; } // vacío = no cambiar
    }
    applyPanelCredentials(getSetting);
    res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`${n} credencial(es) guardada(s)`)}`);
  });
  admin.post('/rules/:id/delete', (req, res) => {
    const r = getRule(Number(req.params.id));
    deleteRule(Number(req.params.id));
    res.redirect(`/admin?tab=${encodeURIComponent(r?.platform || 'instagram')}&ok=Regla+eliminada`);
  });
  admin.post('/instagram/token', async (req, res) => {
    const t = String(req.body.token || '').trim();
    if (!t) return res.redirect('/admin?tab=conexiones');
    setSetting('ig_access_token', t);
    setSetting('ig_token_refreshed_at', String(Date.now()));
    try { const me = await ig.loadAccount(); res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Instagram conectado: @${me.username}`)}`); }
    catch (e) { res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Token inválido: ${e.message}`)}`); }
  });
  admin.post('/instagram/subscribe', async (_req, res) => {
    try { if (!getSetting('ig_user_id')) await ig.loadAccount(); await ig.subscribeWebhooks(); res.redirect('/admin?tab=conexiones&ok=Webhooks+de+Instagram+activados'); }
    catch (e) { res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Error: ${e.message}`)}`); }
  });
  admin.post('/facebook/token', async (req, res) => {
    const t = String(req.body.token || '').trim();
    if (!t) return res.redirect('/admin?tab=conexiones');
    try { const pg = await fb.connect(t, String(req.body.page || '')); res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Facebook conectado: ${pg.name}`)}`); }
    catch (e) { res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Token inválido: ${e.message}`)}`); }
  });
  admin.post('/facebook/subscribe', async (_req, res) => {
    try { await fb.subscribeWebhooks(); res.redirect('/admin?tab=conexiones&ok=Webhooks+de+Facebook+activados'); }
    catch (e) { res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Error: ${e.message}`)}`); }
  });
  admin.get('/tiktok/connect', (_req, res) => {
    if (!config.tiktok.appId) return res.redirect('/admin?tab=conexiones&ok=Falta+TIKTOK_APP_ID');
    if (!config.tiktok.clientKey) return res.redirect('/admin?tab=conexiones&ok=Falta+TIKTOK_CLIENT_KEY');
    res.redirect(tt.authorizeUrl(newState('tt_state')));
  });
  admin.post('/tiktok/webhook', async (_req, res) => {
    try { await tt.registerWebhook(); res.redirect('/admin?tab=conexiones&ok=Webhook+de+TikTok+registrado'); }
    catch (e) { res.redirect(`/admin?tab=conexiones&ok=${encodeURIComponent(`Error: ${e.message}`)}`); }
  });
  admin.get('/youtube/connect', (_req, res) => {
    if (!config.youtube.clientId) return res.redirect('/admin?tab=conexiones&ok=Falta+YT_CLIENT_ID');
    res.redirect(yt.authorizeUrl(newState('yt_state')));
  });
  app.use('/admin', admin);

  // JSON mal formado u otros errores de parseo
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'JSON inválido' : err.message });
    res.status(status).send(err.message);
  });

  return app;
}
