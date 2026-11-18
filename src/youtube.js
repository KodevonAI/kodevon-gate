import { config } from './config.js';
import { request } from './http.js';
import { getSetting, setSetting, markSeen, logEvent } from './db.js';
import { matchRule, render } from './engine.js';

const P = 'youtube';
const YT = 'https://www.googleapis.com/youtube/v3';
export const redirectUri = () => `${config.baseUrl}/youtube/callback`;

export function authorizeUrl(state) {
  const q = new URLSearchParams({
    client_id: config.youtube.clientId, redirect_uri: redirectUri(), response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.force-ssl', access_type: 'offline', prompt: 'consent', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  return request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.youtube.clientId, client_secret: config.youtube.clientSecret, ...params }),
  });
}

export async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (t.refresh_token) setSetting('yt_refresh_token', t.refresh_token);
  setSetting('yt_access_token', t.access_token);
  setSetting('yt_expires_at', String(Date.now() + t.expires_in * 1000));
  const ch = await request(`${YT}/channels?part=id,snippet&mine=true`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  const c = ch.items?.[0];
  if (c) { setSetting('yt_channel_id', c.id); setSetting('yt_channel_title', c.snippet?.title || ''); }
  setSetting('yt_initialized', '0');
  logEvent(P, 'info', `Canal conectado: ${getSetting('yt_channel_title')}`);
}

async function accessToken() {
  if (Date.now() < Number(getSetting('yt_expires_at', '0')) - 60000) return getSetting('yt_access_token');
  const refresh = getSetting('yt_refresh_token');
  if (!refresh) throw new Error('YouTube no conectado');
  const t = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
  setSetting('yt_access_token', t.access_token);
  setSetting('yt_expires_at', String(Date.now() + t.expires_in * 1000));
  return t.access_token;
}

/** Procesa una página de hilos de comentarios. Exportado para pruebas. */
export async function processThreads(items, { initialize = false, reply }) {
  const channelId = getSetting('yt_channel_id');
  for (const th of items) {
    const top = th.snippet?.topLevelComment?.snippet || {};
    const isNew = markSeen(P, `thread:${th.id}`);
    if (!isNew || initialize) continue;
    if (top.authorChannelId?.value === channelId) continue;
    const rule = matchRule(P, top.textOriginal || top.textDisplay || '', th.snippet?.videoId || '');
    if (!rule || !rule.public_reply) continue;
    const name = String(top.authorDisplayName || '').replace(/^@/, '');
    try {
      await reply(th.id, render(rule.public_reply, { username: name, nombre: name }));
      logEvent(P, 'info', `Respondido comentario de ${name} (regla #${rule.id})`);
    } catch (e) {
      logEvent(P, 'error', `No se pudo responder: ${e.message}`);
    }
  }
}

export async function poll() {
  const channelId = getSetting('yt_channel_id');
  if (!channelId || !getSetting('yt_refresh_token')) return;
  const tok = await accessToken();
  const r = await request(`${YT}/commentThreads?part=snippet&allThreadsRelatedToChannelId=${channelId}&order=time&maxResults=50&textFormat=plainText`,
    { headers: { Authorization: `Bearer ${tok}` } });
  const initialize = getSetting('yt_initialized') !== '1';
  await processThreads(r.items || [], {
    initialize,
    reply: (parentId, text) => request(`${YT}/comments?part=snippet`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: { snippet: { parentId, textOriginal: text } },
    }),
  });
  if (initialize) { setSetting('yt_initialized', '1'); logEvent(P, 'info', 'Comentarios existentes marcados como vistos (no se responden)'); }
}
