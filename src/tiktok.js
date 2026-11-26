import crypto from 'node:crypto';
import { config } from './config.js';
import { request } from './http.js';
import {
  getSetting, setSetting, markSeen, logEvent, getRule, upsertSession, getPendingSession,
  bumpAttempts, setSessionStatus, listRules,
} from './db.js';
import { matchRule, render, isConfirmation } from './engine.js';

const P = 'tiktok';
const api = () => `https://business-api.tiktok.com/open_api/${config.tiktok.apiVersion}`;
const SCOPES = () => config.tiktok.scopes;

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
    client_key: config.tiktok.clientKey, response_type: 'code', scope: SCOPES().join(','),
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

const firstKeyword = (rule) => String(rule.keywords || '').split(',')[0].trim().toUpperCase();
const userKey = (username) => `user:${String(username || '').replace(/^@/, '').toLowerCase()}`;

/** DM con palabra clave (o de alguien que comentó): verifica follow y entrega o pide seguir. */
async function startDelivery(conversationId, rule, username) {
  upsertSession(P, conversationId, rule.id, username, 'awaiting_follow');
  const session = getPendingSession(P, conversationId);
  const vars = { username, nombre: username, palabra: firstKeyword(rule) };
  const follows = username ? await followsMe(username) : null;
  if (follows === false) {
    await sendText(conversationId, render(rule.ask_follow_msg, vars));
    logEvent(P, 'info', `@${username} escribió por DM pero aún no sigue la cuenta (regla #${rule.id})`);
    return;
  }
  await sendText(conversationId, render(rule.content_msg, vars));
  setSessionStatus(session.id, 'delivered');
  logEvent(P, 'info', `Contenido entregado a @${username}${follows === null ? ' (seguimiento no verificable)' : ''} (regla #${rule.id})`);
}

export async function handleMessage(content) {
  const conversationId = content.conversation_id;
  const fromId = content.from_user?.id;
  const username = String(content.from || '').replace(/^@/, '');
  if (!conversationId || !fromId || fromId === businessId()) return;
  if (content.message_id && !markSeen(P, `msg:${content.message_id}`)) return;
  if (content.type !== 'text') return;
  const text = content.text?.body || '';

  // 1) Escribió la palabra clave
  let rule = matchRule(P, text);
  // 2) O es alguien que comentó la palabra en un video y ahora escribe cualquier cosa
  if (!rule && username) {
    const lead = getPendingSession(P, userKey(username));
    if (lead && !getPendingSession(P, conversationId)) {
      rule = getRule(lead.rule_id);
      setSessionStatus(lead.id, 'delivered');
    }
  }
  if (rule && rule.active) {
    logEvent(P, 'info', `DM de @${username} (regla #${rule.id})`);
    await startDelivery(conversationId, rule, username);
    return;
  }
  // 3) Responde LISTO después de que se le pidió seguir
  const pending = getPendingSession(P, conversationId);
  if (pending && isConfirmation(text, config.tiktok.confirmWords)) {
    await checkAndDeliver(conversationId, pending, username || pending.username);
  }
}

// ---------- Comentarios en videos ----------
const pick = (obj, ...keys) => { for (const k of keys) if (obj?.[k] != null && obj[k] !== '') return obj[k]; return undefined; };

async function listVideos() {
  const d = await call('/business/video/list/', {
    query: { business_id: businessId(), fields: JSON.stringify(['item_id', 'create_time']), max_count: String(config.tiktok.videosToScan) },
  });
  return (d.videos || d.list || []).map((v) => String(pick(v, 'item_id', 'video_id', 'id'))).filter(Boolean);
}

async function listComments(videoId) {
  const d = await call('/business/comment/list/', {
    query: { business_id: businessId(), video_id: videoId, include_replies: 'false', sort_field: 'create_time', sort_order: 'desc', max_count: '30' }, // TikTok: máximo 30
  });
  return d.comments || d.list || [];
}

async function replyComment(videoId, commentId, text) {
  return call('/business/comment/reply/create/', {
    method: 'POST', body: { business_id: businessId(), video_id: videoId, comment_id: commentId, text },
  });
}

/** Procesa comentarios de un video. Exportado para pruebas. */
export async function processComments(videoId, comments, { initialize = false, reply = replyComment } = {}) {
  const me = myUsername();
  for (const c of comments) {
    const id = String(pick(c, 'comment_id', 'id') || '');
    if (!id) continue;
    const isNew = markSeen(P, `comment:${id}`);
    if (!isNew || initialize) continue;
    const parent = pick(c, 'parent_comment_id');
    if (parent && String(parent) !== id && String(parent) !== '0') continue; // es una respuesta
    const username = String(pick(c, 'username', 'unique_id') || '').replace(/^@/, '');
    if (c.owner === true || (username && username.toLowerCase() === me)) continue;
    const rule = matchRule(P, String(c.text || ''), videoId);
    if (!rule || !rule.public_reply) continue;
    const name = username || String(pick(c, 'display_name') || '');
    try {
      await reply(videoId, id, render(rule.public_reply, { username: name, nombre: pick(c, 'display_name') || name, palabra: firstKeyword(rule) }));
      if (username) upsertSession(P, userKey(username), rule.id, username, 'awaiting_follow');
      logEvent(P, 'info', `Respondido comentario de @${name} en video ${videoId} (regla #${rule.id})`);
    } catch (e) {
      logEvent(P, 'error', `No se pudo responder el comentario ${id}: ${e.message}`);
    }
  }
}

export async function pollComments() {
  if (!businessId() || !getSetting('tt_refresh_token')) return;
  if (!listRules(P).some((r) => r.active && r.public_reply)) return;
  const ids = new Set(await listVideos());
  for (const r of listRules(P)) if (r.active && r.media_id) ids.add(r.media_id);
  for (const videoId of ids) {
    try {
      const comments = await listComments(videoId);
      // Primera lectura exitosa de cada video: marcar lo existente como visto sin responder.
      // Por video y solo tras leer bien, para que un error no deje comentarios viejos pendientes.
      const initialize = markSeen(P, `video_init:${videoId}`);
      await processComments(videoId, comments, { initialize });
      if (initialize) logEvent(P, 'info', `Video ${videoId}: comentarios existentes marcados como vistos (no se responden)`);
    } catch (e) { logEvent(P, 'error', `Comentarios del video ${videoId}: ${e.message}`); }
  }
}

export async function handleWebhook(event) {
  if (event.event !== 'im_receive_msg') return;
  if (event.user_openid && businessId() && event.user_openid !== businessId()) return;
  const content = typeof event.content === 'string' ? JSON.parse(event.content) : event.content || {};
  await handleMessage(content);
}
