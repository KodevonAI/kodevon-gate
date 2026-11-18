import { config } from './config.js';
import { getSetting, listRules, getDb } from './db.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PLATFORM_LABEL = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

const HELP = {
  instagram: 'Comentario con palabra clave → respuesta pública → DM pidiendo seguir con botón "Ya te sigo" → se verifica el follow → se envía el contenido. También funciona si la persona escribe la palabra por DM.',
  tiktok: 'La persona te escribe la palabra clave por DM → se le pide seguirte y responder LISTO → se verifica en su lista pública de "siguiendo" → se envía el contenido (si su lista es privada se entrega igual).',
  youtube: 'Comentario con palabra clave → se responde el comentario con el texto de "Respuesta pública" (pon ahí el link). YouTube no tiene DMs.',
};

function status() {
  return {
    instagram: getSetting('ig_user_id') ? `Conectado: @${getSetting('ig_username')}` : 'Sin conectar',
    tiktok: getSetting('tt_business_id') ? `Conectado: @${getSetting('tt_username') || config.tiktok.username}` : 'Sin conectar',
    youtube: getSetting('yt_channel_id') ? `Conectado: ${getSetting('yt_channel_title')}` : 'Sin conectar',
  };
}

function ruleForm(platform, r = {}) {
  const isYt = platform === 'youtube';
  const field = (name, label, hint, rows = 2) => `<label>${label}<small>${hint}</small>
    <textarea name="${name}" rows="${rows}">${esc(r[name])}</textarea></label>`;
  return `<form method="post" action="/admin/rules" class="rule">
    <input type="hidden" name="platform" value="${platform}">
    ${r.id ? `<input type="hidden" name="id" value="${r.id}">` : ''}
    <div class="row">
      <label>Nombre<input name="name" value="${esc(r.name)}" placeholder="Ej: Guía de automatización"></label>
      <label>Palabras clave<small>Separadas por coma. No importan mayúsculas ni tildes.</small><input name="keywords" required value="${esc(r.keywords)}" placeholder="GUIA, CALCULO"></label>
      <label>ID del ${isYt ? 'video' : 'post'} (opcional)<small>Vacío = aplica a todos</small><input name="media_id" value="${esc(r.media_id)}"></label>
    </div>
    ${platform !== 'tiktok' ? field('public_reply', 'Respuesta pública al comentario', isYt ? 'Incluye aquí el link al contenido.' : 'Ej: ¡Listo {username}! Te escribí por DM 📩') : ''}
    ${!isYt ? field('ask_follow_msg', 'DM: pedir que te siga', platform === 'tiktok' ? 'Pide que te siga y responda LISTO.' : 'Se envía con el botón "Ya te sigo".', 3) : ''}
    ${!isYt ? field('not_following_msg', 'DM: si todavía no te sigue', 'Se envía cuando la verificación dice que no te sigue.', 2) : ''}
    ${!isYt ? field('content_msg', 'DM: contenido prometido', 'El mensaje con el link/contenido.', 3) : ''}
    <div class="actions">
      <label class="check"><input type="checkbox" name="active" ${r.id ? (r.active ? 'checked' : '') : 'checked'}> Activa</label>
      <button>${r.id ? 'Guardar' : 'Crear regla'}</button>
      ${r.id ? `<button formaction="/admin/rules/${r.id}/delete" class="danger">Eliminar</button>` : ''}
    </div>
  </form>`;
}

export function renderAdmin({ flash = '' } = {}) {
  const st = status();
  const events = getDb().prepare('SELECT * FROM events ORDER BY id DESC LIMIT 60').all();
  const sections = ['instagram', 'tiktok', 'youtube'].map((p) => {
    const rules = listRules(p);
    let connect = '';
    if (p === 'instagram') {
      connect = `<form method="post" action="/admin/instagram/token" class="inline">
          <input name="token" placeholder="Pega aquí el token de acceso de Instagram" autocomplete="off">
          <button>Guardar token</button></form>
        <form method="post" action="/admin/instagram/subscribe" class="inline"><button>Activar webhooks de la cuenta</button></form>
        <p class="muted">Webhook para Meta: <code>${esc(config.baseUrl)}/webhooks/instagram</code></p>`;
    } else if (p === 'tiktok') {
      connect = `<a class="btn" href="/admin/tiktok/connect">Conectar cuenta de TikTok</a>
        <form method="post" action="/admin/tiktok/webhook" class="inline"><button>Registrar webhook en TikTok</button></form>
        <p class="muted">Redirect URI: <code>${esc(config.baseUrl)}/tiktok/callback</code> · Verificación de seguidor: <b>${config.tiktok.followCheck === 'apify' && config.tiktok.apifyToken ? 'Apify (lista pública)' : 'desactivada'}</b></p>`;
    } else {
      connect = `<a class="btn" href="/admin/youtube/connect">Conectar canal de YouTube</a>
        <p class="muted">Redirect URI: <code>${esc(config.baseUrl)}/youtube/callback</code> · Revisa comentarios cada ${config.youtube.pollSeconds}s</p>`;
    }
    return `<section><h2>${PLATFORM_LABEL[p]} <span class="pill">${esc(st[p])}</span></h2>
      <p class="muted">${HELP[p]}</p>${connect}
      ${rules.map((r) => ruleForm(p, r)).join('')}
      <details><summary>+ Nueva regla de ${PLATFORM_LABEL[p]}</summary>${ruleForm(p)}</details></section>`;
  }).join('');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kodevon Gate</title>
<style>
:root{--o:#FF5F1F;--bg:#1A1A1A;--card:#242424;--t:#F5F5F7;--g:#8C8C8C}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:15px/1.5 Inter,system-ui,sans-serif}
main{max-width:1000px;margin:auto;padding:24px}h1{font-family:Outfit,Inter,sans-serif;margin:0 0 4px}h1 b{color:var(--o)}
section{background:var(--card);border-radius:10px;padding:20px;margin:20px 0}h2{margin:0 0 6px;font-size:20px}
.pill{font-size:12px;background:#333;border-radius:20px;padding:3px 10px;margin-left:8px;vertical-align:middle;color:var(--g)}
.muted{color:var(--g);font-size:13px}code{background:#111;padding:2px 6px;border-radius:4px;color:var(--t)}
label{display:block;margin:8px 0;font-weight:600;font-size:13px}label small{display:block;font-weight:400;color:var(--g)}
input,textarea{width:100%;background:#111;color:var(--t);border:1px solid #3a3a3a;border-radius:6px;padding:8px;font:inherit;margin-top:4px}
.row{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:12px}.rule{border-top:1px solid #333;padding-top:12px;margin-top:12px}
button,.btn{background:var(--o);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;font-size:14px}
.danger{background:#5a2a2a}.actions{display:flex;gap:12px;align-items:center}.check{display:flex;gap:6px;align-items:center;margin:0}.check input{width:auto;margin:0}
.inline{display:flex;gap:8px;margin:8px 0}.inline input{margin:0}.flash{background:#2d3a22;padding:10px 14px;border-radius:6px}
summary{cursor:pointer;color:var(--o);margin-top:12px;font-weight:600}table{width:100%;font-size:12px;border-collapse:collapse}td{padding:4px;border-bottom:1px solid #333;vertical-align:top}
.error{color:#ff8a80}.warn{color:#ffd180}@media(max-width:700px){.row{grid-template-columns:1fr}}
</style></head><body><main>
<h1><b>Kodevon</b> Gate</h1><p class="muted">Palabras clave → verificación de seguidor → contenido. Variables disponibles en los textos: <code>{username}</code></p>
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
${sections}
<section><h2>Actividad reciente</h2><table>${events.map((e) => `<tr><td class="muted">${esc(e.created_at)}</td><td>${esc(e.platform)}</td><td class="${esc(e.level)}">${esc(e.message)}</td></tr>`).join('') || '<tr><td class="muted">Sin actividad todavía</td></tr>'}</table></section>
</main></body></html>`;
}
