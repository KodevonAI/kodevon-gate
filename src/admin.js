import { config } from './config.js';
import { getSetting, listRules, getDb } from './db.js';
import { apiKey } from './api.js';
import * as fb from './facebook.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PLATFORM_LABEL = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook' };
const ALL = ['instagram', 'facebook', 'tiktok', 'youtube'];

const HELP = {
  instagram: 'Comentario con palabra clave → respuesta pública → DM pidiendo seguir con botón "Ya te sigo" → se verifica el follow → se envía el contenido. También funciona si la persona escribe la palabra por DM.',
  tiktok: 'Comentario con palabra clave → se responde el comentario pidiéndole que te escriba por DM → cuando escribe (la palabra o cualquier cosa) se verifica si te sigue → si te sigue recibe el contenido; si no, se le pide seguirte y responder LISTO. Si su lista de seguidos es privada, se entrega igual. Escribir la palabra directo por DM también funciona.',
  youtube: 'Comentario con palabra clave → se responde el comentario con el texto de "Respuesta pública" (pon ahí el link). YouTube no tiene DMs.',
  facebook: 'Comentario con palabra clave en la página → respuesta pública → el contenido llega directo por Messenger (Meta no deja verificar si alguien sigue la página). También si escriben la palabra por Messenger.',
};

function status() {
  return {
    instagram: getSetting('ig_user_id') ? `Conectado: @${getSetting('ig_username')}` : 'Sin conectar',
    tiktok: getSetting('tt_business_id') ? `Conectado: @${getSetting('tt_username') || config.tiktok.username}` : 'Sin conectar',
    youtube: getSetting('yt_channel_id') ? `Conectado: ${getSetting('yt_channel_title')}` : 'Sin conectar',
    facebook: fb.isConnected() ? `Conectado: ${getSetting('fb_page_name') || (getSetting('fb_page_id') ? fb.pageId() : 'página de Instagram')}` : 'Sin conectar',
  };
}

function ruleForm(platform, r = {}) {
  const isYt = platform === 'youtube';
  const isFb = platform === 'facebook';
  const isPost = platform === 'instagram' || isFb;
  const field = (name, label, hint, rows = 2) => `<label>${label}<small>${hint}</small>
    <textarea name="${name}" rows="${rows}">${esc(r[name])}</textarea></label>`;
  return `<form method="post" action="/admin/rules" class="rule">
    <input type="hidden" name="platform" value="${platform}">
    ${r.id ? `<input type="hidden" name="id" value="${r.id}">` : ''}
    <div class="row">
      <label>Nombre<input name="name" value="${esc(r.name)}" placeholder="Ej: Guía de automatización"></label>
      <label>Palabras clave<small>Separadas por coma. No importan mayúsculas ni tildes.</small><input name="keywords" required value="${esc(r.keywords)}" placeholder="GUIA, CALCULO"></label>
      <label>Link o ID del ${isPost ? 'post' : 'video'} (opcional)<small>Pega el link del ${isPost ? 'post/reel' : 'video'}. Vacío = aplica a todos</small><input name="media_id" value="${esc(r.media_id)}"></label>
    </div>
    ${field('public_reply', 'Respuesta pública al comentario', isYt ? 'Incluye aquí el link al contenido.' : platform === 'tiktok' ? 'Pídele que te escriba por DM. {palabra} = la palabra clave. Ej: ¡Hola {nombre}! Escríbeme {palabra} por DM 📩' : 'Ej: ¡Listo {username}! Te escribí por DM 📩')}
    ${!isYt && !isFb ? field('ask_follow_msg', 'DM: pedir que te siga', platform === 'tiktok' ? 'Se envía si escribe por DM y aún no te sigue. Pide que te siga y responda LISTO.' : 'Se envía con el botón "Ya te sigo".', 3) : ''}
    ${!isYt && !isFb ? field('not_following_msg', 'DM: si todavía no te sigue', 'Se envía cuando la verificación dice que no te sigue.', 2) : ''}
    ${!isYt ? field('content_msg', isFb ? 'Messenger: contenido prometido' : 'DM: contenido prometido', 'El mensaje con el link/contenido.', 3) : ''}
    <div class="actions">
      <label class="check"><input type="checkbox" name="active" ${r.id ? (r.active ? 'checked' : '') : 'checked'}> Activa</label>
      <button>${r.id ? 'Guardar' : 'Crear regla'}</button>
      ${r.id ? `<button formaction="/admin/rules/${r.id}/delete" class="danger" onclick="return confirm('¿Eliminar esta regla? No se puede deshacer.')">Eliminar</button>` : ''}
    </div>
  </form>`;
}

function setupSection() {
  const b = esc(config.baseUrl);
  const ok = (v) => (v ? '<span class="okc">✔ configurado</span>' : '<span class="no">✗ falta</span>');
  const cred = (key, label, isSet, secret = true, hint = '') => `<label>${label} ${ok(isSet)}${hint ? `<small>${hint}</small>` : ''}
    <input name="${key}" type="${secret ? 'password' : 'text'}" autocomplete="off" placeholder="${isSet ? 'Dejar vacío para no cambiar' : 'Pegar aquí'}"></label>`;
  const copy = (v) => `<code class="cp" onclick="navigator.clipboard.writeText(this.innerText);this.classList.add('copied')">${v}</code>`;
  return `<section><h2>⚡ Configuración rápida</h2>
  <p class="muted">Pega aquí las credenciales (se guardan en el servidor, no hace falta redesplegar). Haz clic en cualquier valor <code>así</code> para copiarlo.</p>
  <form method="post" action="/admin/credentials">
    <div class="row">
      ${cred('cred_ig_app_secret', 'Instagram · App Secret', config.instagram.appSecret, true, 'Meta → tu app → Configuración de la app → Información básica → Clave secreta de la aplicación')}
      ${cred('cred_tt_app_id', 'TikTok · App ID (client key)', config.tiktok.appId, false)}
      ${cred('cred_tt_app_secret', 'TikTok · App Secret', config.tiktok.appSecret)}
    </div>
    <div class="row">
      ${cred('cred_tt_username', 'TikTok · tu usuario (sin @)', config.tiktok.username, false)}
      ${cred('cred_apify_token', 'Apify · API token', config.tiktok.apifyToken, true, 'console.apify.com → Settings → API & Integrations')}
      ${cred('cred_yt_client_id', 'YouTube · OAuth Client ID', config.youtube.clientId, false)}
    </div>
    <div class="row">${cred('cred_yt_client_secret', 'YouTube · OAuth Client Secret', config.youtube.clientSecret)}</div>
    <button>Guardar credenciales</button>
  </form>
  <details open><summary>Valores para pegar en Meta / TikTok / Google</summary>
  <table>
    <tr><td>Meta · Callback URL del webhook</td><td>${copy(`${b}/webhooks/instagram`)}</td></tr>
    <tr><td>Meta · Verify token</td><td>${config.instagram.verifyToken ? copy(esc(config.instagram.verifyToken)) : '<span class="no">define IG_VERIFY_TOKEN</span>'}</td></tr>
    <tr><td>Meta · Campos a suscribir</td><td>${copy('comments')} ${copy('messages')} ${copy('messaging_postbacks')}</td></tr>
    <tr><td>Meta (Página) · Callback URL</td><td>${copy(`${b}/webhooks/facebook`)}</td></tr>
    <tr><td>Meta (Página) · Campos a suscribir</td><td>${copy('feed')} ${copy('messages')}</td></tr>
    <tr><td>TikTok · Redirect URI</td><td>${copy(`${b}/tiktok/callback`)}</td></tr>
    <tr><td>Google · Redirect URI autorizado</td><td>${copy(`${b}/youtube/callback`)}</td></tr>
    <tr><td>Google · Scope</td><td>${copy('https://www.googleapis.com/auth/youtube.force-ssl')}</td></tr>
  </table></details></section>
  <section><h2>🔌 API para automatizar reglas</h2>
  <p class="muted">Crea, edita y borra reglas desde n8n, scripts u otras apps. Envía la clave en el header <code>Authorization: Bearer &lt;clave&gt;</code>. Documentación: <a href="${b}/api/v1" target="_blank">${b}/api/v1</a></p>
  <table>
    <tr><td>Base URL</td><td>${copy(`${b}/api/v1`)}</td></tr>
    <tr><td>API key</td><td>${apiKey() ? copy(esc(apiKey())) : '<span class="no">sin generar</span>'}</td></tr>
  </table>
  <form method="post" action="/admin/api-key/rotate" onsubmit="return confirm('La clave actual dejará de funcionar. ¿Continuar?')"><button class="sec">Generar nueva clave</button></form>
  <details><summary>Ejemplo (curl)</summary><pre>curl -X POST ${b}/api/v1/instagram/rules \\
  -H "Authorization: Bearer $KGATE_API_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"Guía Claude","keywords":["claude"],"media_url":"https://www.instagram.com/reel/XXXX/","content_msg":"Aquí tienes: https://..."}'</pre></details>
  </section>`;
}

function connectBlock(p) {
  if (p === 'instagram') {
    return `<form method="post" action="/admin/instagram/token" class="inline">
        <input name="token" placeholder="Pega aquí el token del usuario del sistema (EAA...) o de Instagram (IG...)" autocomplete="off">
        <button>Guardar token</button></form>
      <form method="post" action="/admin/instagram/subscribe" class="inline"><button class="sec">Activar webhooks de la cuenta</button></form>`;
  }
  if (p === 'facebook') {
    return `<form method="post" action="/admin/facebook/token" class="inline">
        <input name="token" placeholder="Token de usuario del sistema / de la página (EAA...)" autocomplete="off">
        <input name="page" placeholder="Nombre de la página (opcional)" style="max-width:220px">
        <button>Guardar token</button></form>
      <form method="post" action="/admin/facebook/subscribe" class="inline"><button class="sec">Activar webhooks de la página</button></form>
      <p class="muted">Permisos: <code>pages_manage_engagement</code> <code>pages_read_engagement</code> <code>pages_messaging</code> <code>pages_manage_metadata</code>. Sin token propio usa la página del token de Instagram (modo EAA).</p>`;
  }
  if (p === 'tiktok') {
    return `<div class="inline"><a class="btn" href="/admin/tiktok/connect">Conectar cuenta de TikTok</a>
      <form method="post" action="/admin/tiktok/webhook"><button class="sec">Registrar webhook en TikTok</button></form></div>
      <p class="muted">Verificación de seguidor: <b>${config.tiktok.followCheck === 'apify' && config.tiktok.apifyToken ? 'Apify (lista pública)' : 'desactivada'}</b></p>`;
  }
  return `<a class="btn" href="/admin/youtube/connect">Conectar canal de YouTube</a>
    <p class="muted">Revisa comentarios cada ${config.youtube.pollSeconds}s</p>`;
}

function mediaLabel(p, id) {
  if (!id) return '<span class="muted">Todas las publicaciones</span>';
  if (p === 'youtube') return `<a href="https://youtu.be/${esc(id)}" target="_blank" onclick="event.stopPropagation()">Video ${esc(id)}</a>`;
  if (p === 'facebook') return `<a href="https://www.facebook.com/${esc(id)}" target="_blank" onclick="event.stopPropagation()">Post ${esc(id)}</a>`;
  return `<span>Post ${esc(id)}</span>`;
}

function modal(id, title, content) {
  return `<dialog id="${id}" class="modal" onclick="if(event.target===this)this.close()">
    <div class="modal-box"><div class="modal-head"><h3>${title}</h3>
      <button type="button" class="x" onclick="this.closest('dialog').close()" aria-label="Cerrar">✕</button></div>
    ${content}</div></dialog>`;
}

function ruleCard(p, r) {
  const kws = r.keywords.split(',').map((k) => k.trim()).filter(Boolean).map((k) => `<span class="chip">${esc(k)}</span>`).join(' ');
  const id = `rule-${r.id}`;
  return `<div class="card" role="button" tabindex="0" onclick="document.getElementById('${id}').showModal()"
      onkeydown="if(event.key==='Enter')document.getElementById('${id}').showModal()">
    <div class="card-top"><b>${esc(r.name || `Regla #${r.id}`)}</b><span class="badge ${r.active ? 'on' : 'off'}">${r.active ? 'Activa' : 'Pausada'}</span></div>
    <div class="meta">${kws}</div>
    <div class="meta">${mediaLabel(p, r.media_id)} · #${r.id}</div>
  </div>
  ${modal(id, `${esc(PLATFORM_LABEL[p])} · ${esc(r.name || `Regla #${r.id}`)}`, ruleForm(p, r))}`;
}

const TABS = [...ALL.map((p) => [p, PLATFORM_LABEL[p]]), ['conexiones', 'Conexiones'], ['actividad', 'Actividad']];

export function renderAdmin({ flash = '', tab = 'instagram' } = {}) {
  if (tab === 'reglas') tab = 'instagram';
  if (!TABS.some(([k]) => k === tab)) tab = 'instagram';
  const st = status();
  let body = '';

  if (ALL.includes(tab)) {
    const p = tab;
    const rules = listRules(p);
    body = `<section>
      <div class="sec-head"><div><h2>${PLATFORM_LABEL[p]} <span class="pill">${esc(st[p])}</span></h2>
        <p class="muted">${HELP[p]}</p></div>
        <button type="button" onclick="document.getElementById('new-${p}').showModal()">＋ Crear regla de ${PLATFORM_LABEL[p]}</button></div>
      <h3>Reglas (${rules.length})</h3>
      ${rules.length ? `<div class="grid">${rules.map((r) => ruleCard(p, r)).join('')}</div>` : '<p class="muted">Todavía no hay reglas en esta plataforma.</p>'}
      ${modal(`new-${p}`, `Nueva regla de ${PLATFORM_LABEL[p]}`, ruleForm(p))}
    </section>`;
  } else if (tab === 'conexiones') {
    body = setupSection() + ALL.map((p) => `<section><h2>${PLATFORM_LABEL[p]} <span class="pill">${esc(st[p])}</span></h2>${connectBlock(p)}</section>`).join('');
  } else {
    const events = getDb().prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all();
    body = `<section><h2>Actividad reciente</h2><table>${events.map((e) => `<tr><td class="muted">${esc(e.created_at)}</td><td>${esc(e.platform)}</td><td class="${esc(e.level)}">${esc(e.message)}</td></tr>`).join('') || '<tr><td class="muted">Sin actividad todavía</td></tr>'}</table></section>`;
  }

  const count = (k) => (ALL.includes(k) ? ` <span class="n">${listRules(k).length}</span>` : '');
  const nav = TABS.map(([k, l]) => `<a href="/admin?tab=${k}" class="${k === tab ? 'act' : ''}">${l}${count(k)}</a>`).join('');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kodevon Gate</title>
<style>
:root{--o:#FF5F1F;--bg:#1A1A1A;--card:#242424;--t:#F5F5F7;--g:#8C8C8C}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 Inter,system-ui,sans-serif}
main{max-width:1000px;margin:auto;padding:24px}h1{font-family:Outfit,Inter,sans-serif;margin:0 0 4px}h1 b{color:var(--o)}
nav{display:flex;gap:4px;border-bottom:1px solid #333;margin:16px 0 0}nav a{color:var(--g);text-decoration:none;padding:10px 16px;font-weight:600;border-bottom:2px solid transparent}
nav a.act{color:var(--t);border-color:var(--o)}
section{background:var(--card);border-radius:10px;padding:20px;margin:20px 0}h2{margin:0 0 6px;font-size:20px}h3{font-size:14px;color:var(--g);margin:18px 0 8px;text-transform:uppercase;letter-spacing:.04em}
.pill{font-size:12px;background:#333;border-radius:20px;padding:3px 10px;margin-left:8px;vertical-align:middle;color:var(--g)}
.muted{color:var(--g);font-size:13px}code{background:#111;padding:2px 6px;border-radius:4px;color:var(--t)}a{color:var(--o)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{background:#1d1d1d;border:1px solid #333;border-radius:10px;padding:14px;cursor:pointer;transition:border-color .15s,transform .15s}
.card:hover,.card:focus-visible{border-color:var(--o);transform:translateY(-1px);outline:none}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.sec-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.sec-head button{white-space:nowrap}
nav{flex-wrap:wrap}nav .n{font-size:11px;background:#333;border-radius:20px;padding:1px 7px;margin-left:4px;color:var(--g)}
dialog.modal{background:var(--card);color:var(--t);border:1px solid #3a3a3a;border-radius:12px;padding:0;width:min(760px,94vw);max-height:90vh}
dialog.modal::backdrop{background:rgba(0,0,0,.65)}.modal-box{padding:20px;overflow:auto;max-height:90vh}
.modal-head{display:flex;justify-content:space-between;align-items:center}.modal-head h3{margin:0;color:var(--t);text-transform:none;letter-spacing:0;font-size:18px}
.x{background:transparent;color:var(--g);font-size:18px;padding:4px 8px}.x:hover{color:var(--t)}
.meta{font-size:13px;color:var(--g);margin-top:4px}.chip{background:#333;border-radius:4px;padding:1px 8px;color:var(--t);font-size:12px}
.badge{font-size:11px;border-radius:20px;padding:2px 8px;margin-left:6px}.badge.on{background:#21402a;color:#9be59b}.badge.off{background:#402121;color:#ff8a80}
.new{margin-top:16px;border-top:1px dashed #444;padding-top:4px}
label{display:block;margin:8px 0;font-weight:600;font-size:13px}label small{display:block;font-weight:400;color:var(--g)}
input,textarea{width:100%;background:#111;color:var(--t);border:1px solid #3a3a3a;border-radius:6px;padding:8px;font:inherit;margin-top:4px}
.row{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:12px}.rule{padding-top:8px}
button,.btn{background:var(--o);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;font-size:14px}
.sec{background:#3a3a3a}.danger{background:#5a2a2a}.actions{display:flex;gap:12px;align-items:center}.check{display:flex;gap:6px;align-items:center;margin:0}.check input{width:auto;margin:0}
.inline{display:flex;gap:8px;margin:8px 0;align-items:center}.inline input{margin:0}.flash{background:#2d3a22;padding:10px 14px;border-radius:6px;margin-top:16px}
summary{cursor:pointer;color:var(--o);margin-top:8px;font-weight:600}table{width:100%;font-size:12px;border-collapse:collapse}td{padding:4px;border-bottom:1px solid #333;vertical-align:top}
.okc{color:#9be59b;font-weight:400}.no{color:#ff8a80;font-weight:400}.cp{cursor:pointer}.cp.copied{outline:1px solid var(--o)}
.error{color:#ff8a80}.warn{color:#ffd180}@media(max-width:700px){.row{grid-template-columns:1fr}.sec-head{flex-direction:column}}
</style></head><body><main>
<h1><b>Kodevon</b> Gate</h1><p class="muted">Palabras clave → verificación de seguidor → contenido. Variable disponible en los textos: <code>{username}</code></p>
<nav>${nav}</nav>
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
${body}
</main></body></html>`;
}
