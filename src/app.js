import crypto from 'node:crypto';
import express from 'express';
import { config, PANEL_CREDENTIALS, applyPanelCredentials } from './config.js';
import { getSetting, setSetting, saveRule, deleteRule, logEvent } from './db.js';
import * as ig from './instagram.js';
import * as tt from './tiktok.js';
import * as yt from './youtube.js';
import { renderAdmin } from './admin.js';

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
<p>Este servicio automatiza respuestas a comentarios y mensajes directos de las cuentas oficiales de Kodevon en Instagram, TikTok y YouTube.</p>
<p><b>Datos que tratamos:</b> identificador de la conversación o del usuario en la plataforma, nombre de usuario, texto del comentario o mensaje y si la persona sigue nuestra cuenta. Solo se usan para responder y entregar el contenido solicitado.</p>
<p><b>No vendemos ni compartimos</b> estos datos con terceros. Se almacenan en nuestro propio servidor y se conservan solo el tiempo necesario para operar el servicio.</p>
<p>Puedes solicitar la eliminación de tus datos en <a href="/eliminar-datos">/eliminar-datos</a>.</p>`)));
  app.get('/eliminar-datos', (_req, res) => res.send(legal('Eliminación de datos', `
<p>Para eliminar los datos asociados a tus interacciones con nuestras cuentas, escribe a <a href="mailto:ventas@kodevon.com?subject=Eliminar%20mis%20datos">ventas@kodevon.com</a> con el asunto <b>"Eliminar mis datos"</b> e indica tu nombre de usuario de Instagram, TikTok o YouTube.</p>
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
    runAsync('instagram', () => ig.handleWebhook(req.body));
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

  // ---------- Panel ----------
  const admin = express.Router();
  admin.use(basicAuth);
  admin.get('/', (req, res) => res.send(renderAdmin({ flash: req.query.ok ? String(req.query.ok) : '', tab: String(req.query.tab || 'reglas') })));
  admin.post('/rules', async (req, res) => {
    const b = { ...req.body };
    if (!['instagram', 'tiktok', 'youtube'].includes(b.platform) || !String(b.keywords || '').trim()) return res.redirect('/admin?tab=reglas&ok=Datos+inv%C3%A1lidos');
    try {
      if (b.platform === 'instagram' && b.media_id) b.media_id = await ig.resolveMediaId(b.media_id);
      if (b.platform === 'youtube' && b.media_id) {
        const m = String(b.media_id).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
        if (m) b.media_id = m[1];
      }
    } catch (e) {
      return res.redirect(`/admin?tab=reglas&ok=${encodeURIComponent(`No se guardó: ${e.message}`)}`);
    }
    saveRule({ ...b, active: b.active === 'on' });
    res.redirect('/admin?tab=reglas&ok=Regla+guardada');
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
  admin.post('/rules/:id/delete', (req, res) => { deleteRule(Number(req.params.id)); res.redirect('/admin?tab=reglas&ok=Regla+eliminada'); });
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
  admin.get('/tiktok/connect', (_req, res) => {
    if (!config.tiktok.appId) return res.redirect('/admin?tab=conexiones&ok=Falta+TIKTOK_APP_ID');
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

  return app;
}
