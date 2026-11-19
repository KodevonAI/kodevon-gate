// Lógica compartida para crear/editar reglas (panel y API).
import * as ig from './instagram.js';

export const PLATFORMS = ['instagram', 'tiktok', 'youtube'];

export const FIELDS = ['name', 'keywords', 'media_id', 'public_reply', 'ask_follow_msg', 'not_following_msg', 'content_msg', 'active'];

/** Textos por defecto cuando la API no los envía. */
export const DEFAULTS = {
  instagram: {
    public_reply: '¡Listo {username}! Te envié un mensaje directo 📩',
    ask_follow_msg: '¡Hola {nombre}! Para enviarte el contenido primero sígueme y luego toca el botón 👇',
    not_following_msg: 'Todavía no veo que me sigas 👀 Sígueme y vuelve a tocar el botón.',
  },
  tiktok: {
    public_reply: '¡Hola {nombre}! 📩 Escríbeme {palabra} por mensaje directo y te lo envío.',
    ask_follow_msg: '¡Hola {nombre}! Para enviarte el contenido primero sígueme y luego respóndeme LISTO 🙌',
    not_following_msg: 'Aún no veo que me sigas 👀 Sígueme y escribe LISTO de nuevo.',
  },
  youtube: {},
};

/** Campos obligatorios por plataforma (después de aplicar defaults). */
export const REQUIRED = {
  instagram: ['keywords', 'ask_follow_msg', 'content_msg'],
  tiktok: ['keywords', 'public_reply', 'ask_follow_msg', 'content_msg'],
  youtube: ['keywords', 'public_reply'],
};

export class RuleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'on', 'yes', 'si', 'sí'].includes(String(v).toLowerCase());
}

/** Convierte link del post/reel (IG) o del video (YouTube) en el ID que usa la regla. */
export async function resolveMedia(platform, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (platform === 'instagram') return ig.resolveMediaId(v);
  if (platform === 'youtube') {
    const m = v.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
    return m ? m[1] : v;
  }
  const m = v.match(/\/video\/(\d+)/) || v.match(/^(\d{10,})$/); // TikTok
  return m ? m[1] : v;
}

/**
 * Normaliza la entrada de la API/panel a una regla lista para guardar.
 * `existing` = regla actual (para PATCH). `applyDefaults` = rellenar textos faltantes.
 */
export async function buildRule(input, { existing = null, applyDefaults = false } = {}) {
  const b = input || {};
  const platform = String(b.platform ?? existing?.platform ?? '').toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new RuleError(`platform debe ser uno de: ${PLATFORMS.join(', ')}`);

  const rule = { ...(existing || {}), platform };
  for (const f of FIELDS) {
    if (f === 'active' || f === 'media_id') continue;
    if (b[f] !== undefined) rule[f] = b[f] == null ? '' : b[f];
  }
  if (Array.isArray(rule.keywords)) rule.keywords = rule.keywords.join(', ');
  rule.keywords = String(rule.keywords || '').split(',').map((k) => k.trim()).filter(Boolean).join(', ');

  const mediaInput = b.media_url ?? b.media_id;
  if (mediaInput !== undefined) {
    try { rule.media_id = await resolveMedia(platform, mediaInput); }
    catch (e) { throw new RuleError(`No se pudo resolver el post/video: ${e.message}`, 422); }
  }
  rule.media_id = rule.media_id || '';
  rule.active = toBool(b.active, existing ? Boolean(existing.active) : true);

  if (applyDefaults) {
    for (const [k, v] of Object.entries(DEFAULTS[platform])) if (!String(rule[k] || '').trim()) rule[k] = v;
  }
  const missing = REQUIRED[platform].filter((k) => !String(rule[k] || '').trim());
  if (missing.length) throw new RuleError(`Faltan campos para ${platform}: ${missing.join(', ')}`);
  return rule;
}

/** Representación pública de una regla. */
export function serializeRule(r) {
  if (!r) return null;
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    keywords: String(r.keywords || '').split(',').map((k) => k.trim()).filter(Boolean),
    media_id: r.media_id || null,
    public_reply: r.public_reply,
    ask_follow_msg: r.ask_follow_msg,
    not_following_msg: r.not_following_msg,
    content_msg: r.content_msg,
    active: Boolean(r.active),
    created_at: r.created_at,
  };
}
