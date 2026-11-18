import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
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
    try { await tt.exchangeCode(String(req.query.code || '')); res.redirect('/admin?ok=TikTok+conectado'); }
    catch (e) { logEvent('tiktok', 'error', e.message); res.redirect(`/admin?ok=${encodeURIComponent(`Error TikTok: ${e.message}`)}`); }
  });

  // ---------- YouTube ----------
  app.get('/youtube/callback', async (req, res) => {
    if (!req.query.state || req.query.state !== getSetting('yt_state')) return res.status(400).send('Estado inválido');
    try { await yt.exchangeCode(String(req.query.code || '')); res.redirect('/admin?ok=YouTube+conectado'); }
    catch (e) { logEvent('youtube', 'error', e.message); res.redirect(`/admin?ok=${encodeURIComponent(`Error YouTube: ${e.message}`)}`); }
  });

  // ---------- Panel ----------
  const admin = express.Router();
  admin.use(basicAuth);
  admin.get('/', (req, res) => res.send(renderAdmin({ flash: req.query.ok ? String(req.query.ok) : '' })));
  admin.post('/rules', (req, res) => {
    const b = req.body;
    if (!['instagram', 'tiktok', 'youtube'].includes(b.platform) || !String(b.keywords || '').trim()) return res.redirect('/admin?ok=Datos+inv%C3%A1lidos');
    saveRule({ ...b, active: b.active === 'on' });
    res.redirect('/admin?ok=Regla+guardada');
  });
  admin.post('/rules/:id/delete', (req, res) => { deleteRule(Number(req.params.id)); res.redirect('/admin?ok=Regla+eliminada'); });
  admin.post('/instagram/token', async (req, res) => {
    const t = String(req.body.token || '').trim();
    if (!t) return res.redirect('/admin');
    setSetting('ig_access_token', t);
    setSetting('ig_token_refreshed_at', String(Date.now()));
    try { const me = await ig.loadAccount(); res.redirect(`/admin?ok=${encodeURIComponent(`Instagram conectado: @${me.username}`)}`); }
    catch (e) { res.redirect(`/admin?ok=${encodeURIComponent(`Token inválido: ${e.message}`)}`); }
  });
  admin.post('/instagram/subscribe', async (_req, res) => {
    try { if (!getSetting('ig_user_id')) await ig.loadAccount(); await ig.subscribeWebhooks(); res.redirect('/admin?ok=Webhooks+de+Instagram+activados'); }
    catch (e) { res.redirect(`/admin?ok=${encodeURIComponent(`Error: ${e.message}`)}`); }
  });
  admin.get('/tiktok/connect', (_req, res) => {
    if (!config.tiktok.appId) return res.redirect('/admin?ok=Falta+TIKTOK_APP_ID');
    res.redirect(tt.authorizeUrl(newState('tt_state')));
  });
  admin.post('/tiktok/webhook', async (_req, res) => {
    try { await tt.registerWebhook(); res.redirect('/admin?ok=Webhook+de+TikTok+registrado'); }
    catch (e) { res.redirect(`/admin?ok=${encodeURIComponent(`Error: ${e.message}`)}`); }
  });
  admin.get('/youtube/connect', (_req, res) => {
    if (!config.youtube.clientId) return res.redirect('/admin?ok=Falta+YT_CLIENT_ID');
    res.redirect(yt.authorizeUrl(newState('yt_state')));
  });
  app.use('/admin', admin);

  return app;
}
