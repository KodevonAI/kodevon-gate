import { listRules } from './db.js';

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes: CÁLCULO == calculo
    .trim();
}

/**
 * Busca la primera regla activa de la plataforma cuya palabra clave aparezca en el texto
 * como palabra completa. Si la regla tiene media_id, solo aplica a ese post/video.
 */
export function matchRule(platform, text, mediaId = '') {
  const t = ` ${normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  if (!t.trim()) return null;
  for (const rule of listRules(platform)) {
    if (!rule.active) continue;
    if (rule.media_id && mediaId && rule.media_id !== String(mediaId)) continue;
    if (rule.media_id && !mediaId) continue;
    const kws = rule.keywords.split(',').map((k) => normalize(k).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).filter(Boolean);
    if (kws.some((k) => t.includes(` ${k} `))) return rule;
  }
  return null;
}

/** Reemplaza {username} y {nombre} en los textos. */
export function render(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : ''))
    .replace(/ +([!?,.])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(); // conserva saltos de línea
}

export function isConfirmation(text, words) {
  const t = normalize(text).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return words.some((w) => t === w || t.startsWith(`${w} `));
}
