import crypto from 'node:crypto';
import { config } from './config.js';
import { request } from './http.js';
import {
  getSetting, setSetting, markSeen, logEvent, getRule, upsertSession, getPendingSession,
  bumpAttempts, setSessionStatus,
} from './db.js';
import { matchRule, render } from './engine.js';

const P = 'instagram';
const PAYLOAD_PREFIX = 'FOLLOW_CHECK:';

export const token = () => getSetting('ig_access_token') || config.instagram.accessToken;
/**
 * Dos modos según el token:
 *  - Facebook Login / usuario del sistema (empieza por "EAA"): graph.facebook.com + token de la página.
 *  - Instagram Login (empieza por "IG"): graph.instagram.com + token de Instagram.
 */
export const isFbMode = () => /^EAA/.test(token());
const api = () => `https://graph.${isFbMode() ? 'facebook' : 'instagram'}.com/${config.instagram.graphVersion}`;
const callToken = () => (isFbMode() ? getSetting('ig_page_token') || token() : token());
const myId = () => getSetting('ig_user_id');
const senderId = () => (isFbMode() ? getSetting('ig_page_id') : myId());

export function verifySignature(rawBody, header) {
  if (!config.instagram.appSecret) return false;
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.instagram.appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Lee el perfil de la cuenta conectada y guarda su ID. */
export async function loadAccount() {
  if (!token()) return null;
  if (isFbMode()) {
    const r = await request(`${api()}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(token())}`);
    const pages = (r.data || []).filter((p) => p.instagram_business_account);
    if (!pages.length) throw new Error('El token no tiene ninguna página con cuenta de Instagram asignada');
    const want = (getSetting('ig_username_hint') || '').toLowerCase();
    const page = pages.find((p) => p.instagram_business_account.username?.toLowerCase() === want) || pages[0];
    setSetting('ig_page_id', page.id);
    setSetting('ig_page_token', page.access_token || '');
    setSetting('ig_user_id', page.instagram_business_account.id);
    setSetting('ig_username', page.instagram_business_account.username || '');
    return { id: page.instagram_business_account.id, username: page.instagram_business_account.username, page: page.name };
  }
  const me = await request(`${api()}/me?fields=user_id,username&access_token=${encodeURIComponent(token())}`);
  setSetting('ig_user_id', me.user_id || me.id);
  setSetting('ig_username', me.username || '');
  return me;
}

/** Suscribe la cuenta a los webhooks de comentarios y mensajes. */
export async function subscribeWebhooks() {
  if (isFbMode()) {
    const fields = 'messages,messaging_postbacks,feed';
    return request(`${api()}/${getSetting('ig_page_id')}/subscribed_apps?subscribed_fields=${fields}&access_token=${encodeURIComponent(callToken())}`, { method: 'POST' });
  }
  const fields = 'comments,messages,messaging_postbacks';
  return request(`${api()}/me/subscribed_apps?subscribed_fields=${fields}&access_token=${encodeURIComponent(token())}`, { method: 'POST' });
}

/** Los tokens de larga duración de Instagram duran 60 días: se renuevan cada 7. */
export async function refreshTokenIfNeeded() {
  if (!token() || isFbMode()) return; // el token de usuario del sistema no caduca
  const last = Number(getSetting('ig_token_refreshed_at', '0'));
  if (Date.now() - last < 7 * 24 * 3600 * 1000) return;
  try {
    const r = await request(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token())}`);
    if (r.access_token) {
      setSetting('ig_access_token', r.access_token);
      setSetting('ig_token_refreshed_at', String(Date.now()));
      logEvent(P, 'info', 'Token de Instagram renovado');
    }
  } catch (e) {
    logEvent(P, 'error', `No se pudo renovar el token: ${e.message}`);
  }
}

async function sendMessage(recipient, message) {
  return request(`${api()}/${senderId()}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${callToken()}` },
    body: { recipient, message },
  });
}

/** Envía texto con botón de respuesta rápida; si Instagram lo rechaza, manda solo texto. */
async function sendWithButton(recipient, text, ruleId) {
  try {
    return await sendMessage(recipient, {
      text,
      quick_replies: [{ content_type: 'text', title: config.instagram.followButton.slice(0, 20), payload: `${PAYLOAD_PREFIX}${ruleId}` }],
    });
  } catch (e) {
    logEvent(P, 'warn', `Botón rechazado, se envía solo texto: ${e.message}`);
    return sendMessage(recipient, { text });
  }
}

export async function isFollower(igsid) {
  const r = await request(`${api()}/${igsid}?fields=username,is_user_follow_business&access_token=${encodeURIComponent(callToken())}`);
  return { follows: r.is_user_follow_business === true, username: r.username || '' };
}

async function replyToComment(commentId, text) {
  return request(`${api()}/${commentId}/replies`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${callToken()}` },
    body: { message: text },
  });
}

// ---------- Manejo de eventos ----------

export async function handleComment(value) {
  const commentId = value.id;
  const from = value.from || {};
  const text = value.text || '';
  const mediaId = value.media?.id || '';
  if (!commentId || !from.id) return;
  if (from.id === myId() || (from.username && from.username === getSetting('ig_username'))) return; // mis propios comentarios
  if (value.parent_id) return; // respuestas a comentarios no disparan
  const rule = matchRule(P, text, mediaId);
  if (!rule) return;
  if (!markSeen(P, `comment:${commentId}`)) return;

  const vars = { username: from.username || '', nombre: from.username || '' };
  logEvent(P, 'info', `Comentario de @${from.username} con palabra clave (regla #${rule.id})`);

  if (rule.public_reply) {
    try { await replyToComment(commentId, render(rule.public_reply, vars)); } catch (e) { logEvent(P, 'error', `Respuesta pública falló: ${e.message}`); }
  }
  try {
    const r = await sendWithButton({ comment_id: commentId }, render(rule.ask_follow_msg, vars), rule.id);
    const userKey = r.recipient_id || from.id;
    upsertSession(P, userKey, rule.id, from.username || '', 'awaiting_follow');
  } catch (e) {
    logEvent(P, 'error', `DM privado falló: ${e.message}`);
  }
}

async function checkAndDeliver(igsid, session) {
  const rule = getRule(session.rule_id);
  if (!rule) return;
  let res;
  try {
    res = await isFollower(igsid);
  } catch (e) {
    logEvent(P, 'error', `No se pudo verificar seguidor: ${e.message}`);
    return;
  }
  const vars = { username: res.username || session.username, nombre: res.username || session.username };
  if (res.follows) {
    await sendMessage({ id: igsid }, { text: render(rule.content_msg, vars) });
    setSessionStatus(session.id, 'delivered');
    logEvent(P, 'info', `Contenido entregado a @${vars.username} (regla #${rule.id})`);
  } else {
    bumpAttempts(session.id);
    await sendWithButton({ id: igsid }, render(rule.not_following_msg || rule.ask_follow_msg, vars), rule.id);
    logEvent(P, 'info', `@${vars.username} aún no sigue la cuenta`);
  }
}

export async function handleMessaging(m) {
  const sender = m.sender?.id;
  if (!sender || sender === myId()) return;
  if (m.message?.is_echo) return;
  const mid = m.message?.mid || (m.postback ? `pb:${m.postback.mid || ''}:${m.timestamp}` : null);
  if (mid && !markSeen(P, `msg:${mid}`)) return;

  const payload = m.message?.quick_reply?.payload || m.postback?.payload || '';
  const text = m.message?.text || '';

  if (payload.startsWith(PAYLOAD_PREFIX)) {
    const ruleId = Number(payload.slice(PAYLOAD_PREFIX.length));
    upsertSession(P, sender, ruleId, '', 'awaiting_follow');
    const s = getPendingSession(P, sender);
    if (s) await checkAndDeliver(sender, s);
    return;
  }

  // ¿Escribió la palabra clave por DM?
  const rule = text ? matchRule(P, text) : null;
  if (rule) {
    upsertSession(P, sender, rule.id, '', 'awaiting_follow');
    await sendWithButton({ id: sender }, render(rule.ask_follow_msg, {}), rule.id);
    logEvent(P, 'info', `DM con palabra clave (regla #${rule.id})`);
    return;
  }

  // Cualquier respuesta con una sesión pendiente = volver a verificar
  const pending = getPendingSession(P, sender);
  if (pending) await checkAndDeliver(sender, pending);
}

export async function handleWebhook(body) {
  if (body.object !== 'instagram') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments') await handleComment(change.value || {});
    }
    for (const m of entry.messaging || []) await handleMessaging(m);
  }
}
