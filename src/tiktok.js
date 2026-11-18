import crypto from 'node:crypto';
import { config } from './config.js';
import { request } from './http.js';
import {
  getSetting, setSetting, markSeen, logEvent, getRule, upsertSession, getPendingSession,
  bumpAttempts, setSessionStatus,
} from './db.js';
import { matchRule, render, isConfirmation } from './engine.js';

const P = 'tiktok';
const api = () => `https://business-api.tiktok.com/open_api/${config.tiktok.apiVersion}`;
const SCOPES = ['user.info.basic', 'user.info.username', 'user.info.profile', 'user.account.type',
  'message.list.read', 'message.list.send', 'message.list.manage'];

export const redirectUri = () => `${config.baseUrl}/tiktok/callback`;
export const webhookUrl = () => `${config.baseUrl}/webhooks/tiktok`;
export const businessId = () => getSetting('tt_business_id');
const myUsername = () => (getSetting('tt_username') || config.tiktok.username).replace(/^@/, '').toLowerCase();

async function call(path, { method = 'GET', query, body, auth = true } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const headers = { Accept: 'application/json' };
  if (auth) headers['Access-Token'] = await accessToken();
  const json = await request(`${api()}${path}${qs}`, { method, headers, body });
  if (json.code !== 0) throw new Error(`TikTok ${path}: ${json.code} ${json.message}`);
  return json.data;
}

/** Firma: header Tiktok-Signature = "t=<ts>,s=<hmac>", HMAC-SHA256(secret, `${t}.${body}`). */
export function verifySignature(rawBody, header, now = Date.now()) {
  if (!config.tiktok.appSecret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t); const s = parts.s;
  if (!t || !s) return false;
  const expected = crypto.createHmac('sha256', config.tiktok.appSecret).update(`${t}.${rawBody}`).digest('hex');
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return false;
  return Math.abs(now / 1000 - t) <= 300;
}

export function authorizeUrl(state) {
  const q = new URLSearchParams({
    client_key: config.tiktok.appId, response_type: 'code', scope: SCOPES.join(','),
    redirect_uri: redirectUri(), state,
  });
  return `https://www.tiktok.com/v2/auth/authorize?${q}`;
}

function saveTokens(d) {
  if (d.open_id) setSetting('tt_business_id', d.open_id);
  setSetting('tt_access_token', d.access_token);
  setSetting('tt_refresh_token', d.refresh_token);
  setSetting('tt_expires_at', String(Date.now() + Number(d.expires_in || 86400) * 1000));
}

export async function exchangeCode(code) {
  const d = await call('/tt_user/oauth2/token/', {
    method: 'POST', auth: false,
    body: { client_id: config.tiktok.appId, client_secret: config.tiktok.appSecret, grant_type: 'authorization_code', auth_code: code, redirect_uri: redirectUri() },
  });
  saveTokens(d);
  try {
    const info = await call('/business/get/', { query: { business_id: businessId(), fields: JSON.stringify(['username', 'display_name']) } });
    if (info.username) setSetting('tt_username', info.username);
  } catch (e) { logEvent(P, 'warn', `No se pudo leer el perfil: ${e.message}`); }
  logEvent(P, 'info', `Cuenta conectada (@${getSetting('tt_username')})`);
}

export async function accessToken() {
  const expires = Number(getSetting('tt_expires_at', '0'));
  if (Date.now() < expires - 10 * 60 * 1000) return getSetting('tt_access_token');
  const refresh = getSetting('tt_refresh_token');
  if (!refresh) throw new Error('TikTok no conectado');
  const d = await call('/tt_user/oauth2/refresh_token/', {
    method: 'POST', auth: false,
    body: { client_id: config.tiktok.appId, client_secret: config.tiktok.appSecret, grant_type: 'refresh_token', refresh_token: refresh },
  });
  saveTokens(d);
  return d.access_token;
}

export async function registerWebhook() {
  return call('/business/webhook/update/', {
    method: 'POST', auth: false,
    body: { app_id: config.tiktok.appId, secret: config.tiktok.appSecret, event_type: 'DIRECT_MESSAGE', callback_url: webhookUrl() },
  });
}

async function sendText(conversationId, text) {
  return call('/business/message/send/', {
    method: 'POST',
    body: { business_id: businessId(), recipient_type: 'CONVERSATION', recipient: conversationId, message_type: 'TEXT', text: { body: text } },
  });
}

/**
 * Verifica si `username` sigue la cuenta revisando SU lista pública de "siguiendo" con Apify.
 * Devuelve true / false / null (no se pudo saber: lista privada, error, sin token).
 */
export async function followsMe(username) {
  if (config.tiktok.followCheck !== 'apify' || !config.tiktok.apifyToken || !myUsername()) return null;
  const url = `https://api.apify.com/v2/acts/${config.tiktok.apifyActor}/run-sync-get-dataset-items?token=${encodeURIComponent(config.tiktok.apifyToken)}&timeout=120`;
  try {
    const items = await request(url, {
      method: 'POST', timeoutMs: 130000,
      body: { handles: [username], get_followers: false, get_following: true, max_following: config.tiktok.followCheckMax },
    });
    if (!Array.isArray(items)) return null;
    const rows = items.filter((i) => i.list_type === 'following');
    if (!rows.length) return null; // lista privada o vacía
    const me = myUsername();
    return rows.some((i) => String(i.unique_id || i.username || '').toLowerCase() === me);
  } catch (e) {
    logEvent(P, 'error', `Apify falló: ${e.message}`);
    return null;
  }
}

async function checkAndDeliver(conversationId, session, username) {
  const rule = getRule(session.rule_id);
  if (!rule) return;
  const vars = { username, nombre: username };
  const follows = await followsMe(username);
  if (follows === false) {
    bumpAttempts(session.id);
    await sendText(conversationId, render(rule.not_following_msg || rule.ask_follow_msg, vars));
    logEvent(P, 'info', `@${username} aún no sigue la cuenta`);
    return;
  }
  await sendText(conversationId, render(rule.content_msg, vars));
  setSessionStatus(session.id, 'delivered');
  logEvent(P, 'info', `Contenido entregado a @${username}${follows === null ? ' (seguimiento no verificable)' : ''}`);
}

export async function handleMessage(content) {
  const conversationId = content.conversation_id;
  const fromId = content.from_user?.id;
  const username = String(content.from || '').replace(/^@/, '');
  if (!conversationId || !fromId || fromId === businessId()) return;
  if (content.message_id && !markSeen(P, `msg:${content.message_id}`)) return;
  if (content.type !== 'text') return;
  const text = content.text?.body || '';

  const rule = matchRule(P, text);
  if (rule) {
    upsertSession(P, conversationId, rule.id, username, 'awaiting_follow');
    await sendText(conversationId, render(rule.ask_follow_msg, { username, nombre: username }));
    logEvent(P, 'info', `DM de @${username} con palabra clave (regla #${rule.id})`);
    return;
  }
  const pending = getPendingSession(P, conversationId);
  if (pending && isConfirmation(text, config.tiktok.confirmWords)) {
    await checkAndDeliver(conversationId, pending, username || pending.username);
  }
}

export async function handleWebhook(event) {
  if (event.event !== 'im_receive_msg') return;
  if (event.user_openid && businessId() && event.user_openid !== businessId()) return;
  const content = typeof event.content === 'string' ? JSON.parse(event.content) : event.content || {};
  await handleMessage(content);
}
