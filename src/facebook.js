// Facebook Page: comentario con palabra clave → respuesta pública + contenido por Messenger (private reply).
// La API de Meta no permite comprobar si alguien sigue/le gusta una página, así que aquí no hay gate de follow:
// se entrega directo. También responde si la persona escribe la palabra por Messenger.
import { config } from './config.js';
import { request } from './http.js';
import { getSetting, setSetting, markSeen, unmarkSeen, logEvent, listRules, upsertSession } from './db.js';
import { matchRule, render } from './engine.js';
import * as ig from './instagram.js';

const P = 'facebook';
const api = () => `https://graph.facebook.com/${config.instagram.graphVersion}`;

/** Token y página propios; si no hay, se reutilizan los de Instagram en modo Facebook Login (EAA). */
export const pageToken = () => getSetting('fb_page_token') || (ig.isFbMode() ? getSetting('ig_page_token') : '');
export const pageId = () => getSetting('fb_page_id') || (ig.isFbMode() ? getSetting('ig_page_id') : '');
export const isConnected = () => Boolean(pageToken() && pageId());

/**
 * Guarda la conexión a partir de un token. Acepta token de usuario / usuario del sistema (lista sus páginas y
 * elige la que coincida con `hint` o la primera) o un token de página directamente.
 */
export async function connect(token, hint = '') {
  const t = String(token || '').trim();
  if (!t) throw new Error('Falta el token');
  let pages = [];
  try {
    const r = await request(`${api()}/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(t)}`);
    pages = r.data || [];
  } catch { /* un token de página no tiene /me/accounts */ }
  let page;
  if (pages.length) {
    const want = String(hint || '').toLowerCase();
    page = pages.find((p) => want && (p.name.toLowerCase().includes(want) || p.id === want)) || pages[0];
  } else {
    const me = await request(`${api()}/me?fields=id,name&access_token=${encodeURIComponent(t)}`);
    page = { id: me.id, name: me.name, access_token: t };
  }
  if (!page?.access_token) throw new Error('El token no da acceso a ninguna página de Facebook');
  setSetting('fb_page_id', page.id);
  setSetting('fb_page_token', page.access_token);
  setSetting('fb_page_name', page.name || '');
  return { id: page.id, name: page.name };
}

/** Suscribe la página a comentarios (feed) y Messenger (messages). Sin pages_messaging, solo feed. */
export async function subscribeWebhooks() {
  if (!isConnected()) throw new Error('Facebook no está conectado');
  const sub = (fields) => request(`${api()}/${pageId()}/subscribed_apps?subscribed_fields=${fields}&access_token=${encodeURIComponent(pageToken())}`, { method: 'POST' });
  try { return await sub('feed,messages'); } catch (e) {
    logEvent(P, 'warn', `No se pudo suscribir "messages" (¿falta pages_messaging?): ${e.message}`);
    return sub('feed');
  }
}

/**
 * Link de reel/video/post de Facebook → ID que guarda la regla. Para videos/reels intenta guardar el ID del post
 * asociado (lo que llega en el webhook); si no se puede, guarda el ID del video (el webhook también se compara con él).
 */
export async function resolveMediaId(input) {
  const v = String(input || '').trim();
  if (!v) return '';
  const m = v.match(/\/(?:reel|reels|videos|watch\/?\?v=|posts)\/?([0-9]{6,})/i)
    || v.match(/[?&](?:v|story_fbid|video_id)=([0-9]{6,})/i)
    || v.match(/^(?:[0-9]+_)?([0-9]{6,})$/);
  if (!m) throw new Error(`No reconozco el link de Facebook: ${v}`);
  const id = m[1];
  if (!isConnected()) return id;
  try {
    const r = await request(`${api()}/${id}?fields=post_id&access_token=${encodeURIComponent(pageToken())}`);
    if (r.post_id) return String(r.post_id).split('_').pop();
  } catch { /* no es un video o no hay permiso: se usa el ID tal cual */ }
  return id;
}

const videoOfPost = new Map(); // post_id -> id del video adjunto (caché)

async function attachedVideoId(postId) {
  if (!postId) return '';
  if (videoOfPost.has(postId)) return videoOfPost.get(postId);
  let vid = '';
  try {
    const r = await request(`${api()}/${postId}?fields=attachments{target{id}}&access_token=${encodeURIComponent(pageToken())}`);
    vid = r.attachments?.data?.[0]?.target?.id || '';
  } catch (e) { logEvent(P, 'warn', `No se pudo leer el video del post ${postId}: ${e.message}`); }
  videoOfPost.set(postId, vid);
  return vid;
}

/** Busca regla comparando el media_id con el post (completo o sin prefijo de página) y el video del post. */
async function findRule(text, postId, videoId) {
  const suffix = String(postId || '').split('_').pop();
  const ids = [...new Set([postId, suffix, videoId].filter(Boolean).map(String))];
  for (const id of ids) {
    const r = matchRule(P, text, id);
    if (r) return r;
  }
  const needsLookup = listRules(P).some((r) => r.active && r.media_id && !ids.includes(r.media_id));
  if (!videoId && postId && needsLookup) {
    const vid = await attachedVideoId(postId);
    if (vid && !ids.includes(vid)) return matchRule(P, text, vid);
  }
  return ids.length ? null : matchRule(P, text);
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

async function replyToComment(commentId, text) {
  return request(`${api()}/${commentId}/comments`, {
    method: 'POST', headers: { Authorization: `Bearer ${pageToken()}` }, body: { message: text },
  });
}

async function sendMessage(recipient, text) {
  return request(`${api()}/${pageId()}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${pageToken()}` },
    body: { recipient, message: { text }, messaging_type: 'RESPONSE' },
  });
}

// ---------- Eventos ----------

export async function handleComment(value) {
  if (value.item !== 'comment' || value.verb !== 'add') return;
  const commentId = value.comment_id;
  const from = value.from || {};
  if (!commentId || !from.id || from.id === pageId()) return; // mis propios comentarios
  if (value.parent_id && value.parent_id !== value.post_id) return; // respuestas a comentarios no disparan
  const rule = await findRule(value.message || '', value.post_id, value.video_id);
  if (!rule) return;
  if (!markSeen(P, `comment:${commentId}`)) return;

  const vars = { username: from.name || '', nombre: firstName(from.name) };
  logEvent(P, 'info', `Comentario de ${from.name || from.id} con palabra clave (regla #${rule.id})`);
  if (rule.public_reply) {
    try { await replyToComment(commentId, render(rule.public_reply, vars)); } catch (e) { logEvent(P, 'error', `Respuesta pública falló: ${e.message}`); }
  }
  try {
    const r = await sendMessage({ comment_id: commentId }, render(rule.content_msg, vars));
    upsertSession(P, r.recipient_id || from.id, rule.id, from.name || '', 'delivered');
    logEvent(P, 'info', `Contenido enviado por Messenger a ${from.name || from.id} (regla #${rule.id})`);
  } catch (e) {
    logEvent(P, 'error', `Mensaje privado falló: ${e.message}`);
  }
}

export async function handleMessaging(m) {
  const sender = m.sender?.id;
  if (!sender || sender === pageId() || m.message?.is_echo) return;
  const text = m.message?.text || '';
  const rule = text ? matchRule(P, text) : null;
  if (!rule) return;
  const mid = m.message?.mid;
  if (mid && !markSeen(P, `msg:${mid}`)) return;
  try {
    await sendMessage({ id: sender }, render(rule.content_msg, { username: '', nombre: '' }));
    upsertSession(P, sender, rule.id, '', 'delivered');
    logEvent(P, 'info', `Messenger con palabra clave: contenido enviado (regla #${rule.id})`);
  } catch (e) {
    if (mid) unmarkSeen(P, `msg:${mid}`);
    throw e;
  }
}

export async function handleWebhook(body) {
  if (body.object !== 'page') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'feed') await handleComment(change.value || {});
    }
    for (const m of entry.messaging || []) await handleMessaging(m);
  }
}
