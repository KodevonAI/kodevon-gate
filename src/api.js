// API REST para automatizar reglas: /api/v1/...
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { getSetting, setSetting, listRules, getRule, saveRule, deleteRule, logEvent } from './db.js';
import { PLATFORMS, DEFAULTS, REQUIRED, RuleError, buildRule, serializeRule } from './rules.js';

/** Clave activa: API_KEY del entorno o la generada/guardada en la BD. */
export function apiKey() {
  return config.apiKey || getSetting('api_key');
}

export function ensureApiKey() {
  if (!apiKey()) setSetting('api_key', `kg_${crypto.randomBytes(24).toString('hex')}`);
  return apiKey();
}

export function rotateApiKey() {
  const k = `kg_${crypto.randomBytes(24).toString('hex')}`;
  setSetting('api_key', k);
  return k;
}

function auth(req, res, next) {
  const key = apiKey();
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.get('x-api-key') || '').trim();
  const ok = key && given && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) return res.status(401).json({ error: 'API key inválida. Usa el header Authorization: Bearer <clave>' });
  next();
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (e instanceof RuleError) return res.status(e.status).json({ error: e.message });
  logEvent('api', 'error', e.message);
  res.status(500).json({ error: e.message });
});

async function createOne(input, platform) {
  const rule = await buildRule(platform ? { ...input, platform } : input, { applyDefaults: true });
  return serializeRule(getRule(saveRule(rule)));
}

async function createMany(body, platform, res) {
  if (Array.isArray(body)) {
    const results = [];
    for (const [i, item] of body.entries()) {
      try { results.push({ index: i, ok: true, rule: await createOne(item, platform) }); }
      catch (e) { results.push({ index: i, ok: false, error: e.message }); }
    }
    const allOk = results.every((r) => r.ok);
    return res.status(allOk ? 201 : 207).json({ results });
  }
  const rule = await createOne(body, platform);
  logEvent(rule.platform, 'info', `API: regla #${rule.id} creada (${rule.keywords.join(', ')})`);
  res.status(201).location(`/api/v1/rules/${rule.id}`).json(rule);
}

function findRule(req, res) {
  const r = getRule(Number(req.params.id));
  if (!r || (req.params.platform && r.platform !== req.params.platform)) {
    res.status(404).json({ error: 'Regla no encontrada' });
    return null;
  }
  return r;
}

export function createApiRouter() {
  const api = express.Router();

  api.get('/', (_req, res) => res.json({
    name: 'Kodevon Gate API',
    version: 'v1',
    auth: 'Authorization: Bearer <API_KEY>  (o header X-API-Key)',
    platforms: PLATFORMS,
    required_fields: REQUIRED,
    defaults: DEFAULTS,
    template_vars: ['{username}', '{nombre}'],
    endpoints: {
      'GET /api/v1/status': 'Estado de conexión de cada plataforma',
      'GET /api/v1/rules?platform=': 'Listar reglas',
      'POST /api/v1/rules': 'Crear regla (objeto) o varias (arreglo)',
      'GET /api/v1/rules/:id': 'Ver regla',
      'PATCH /api/v1/rules/:id': 'Editar campos de una regla',
      'DELETE /api/v1/rules/:id': 'Eliminar regla',
      'GET|POST /api/v1/{instagram|tiktok|youtube}/rules': 'Igual que /rules pero fijando la plataforma',
      'GET|PATCH|DELETE /api/v1/{plataforma}/rules/:id': 'Igual que /rules/:id',
    },
    example: {
      platform: 'instagram',
      name: 'Guía Claude',
      keywords: ['claude'],
      media_url: 'https://www.instagram.com/reel/XXXXXXXXX/',
      content_msg: 'Aquí tienes la guía: https://...',
    },
  }));

  api.use(auth);

  api.get('/status', (_req, res) => res.json({
    instagram: { connected: Boolean(getSetting('ig_user_id')), username: getSetting('ig_username') || null },
    tiktok: { connected: Boolean(getSetting('tt_access_token')), username: config.tiktok.username || null, follow_check: Boolean(config.tiktok.apifyToken) },
    youtube: { connected: Boolean(getSetting('yt_refresh_token')) },
    rules: Object.fromEntries(PLATFORMS.map((p) => [p, listRules(p).length])),
  }));

  // Rutas genéricas (/rules) y por plataforma (/:platform/rules)
  for (const prefix of ['', '/:platform']) {
    const checkPlatform = (req, res, next) => {
      if (req.params.platform && !PLATFORMS.includes(req.params.platform)) return res.status(404).json({ error: 'Plataforma desconocida' });
      next();
    };

    api.get(`${prefix}/rules`, checkPlatform, (req, res) => {
      const platform = req.params.platform || (req.query.platform ? String(req.query.platform) : undefined);
      if (platform && !PLATFORMS.includes(platform)) return res.status(400).json({ error: 'platform inválida' });
      let rules = listRules(platform).map(serializeRule);
      if (req.query.active !== undefined) rules = rules.filter((r) => r.active === ['1', 'true'].includes(String(req.query.active)));
      res.json({ data: rules, count: rules.length });
    });

    api.post(`${prefix}/rules`, checkPlatform, wrap((req, res) => createMany(req.body, req.params.platform, res)));

    api.get(`${prefix}/rules/:id`, checkPlatform, (req, res) => {
      const r = findRule(req, res);
      if (r) res.json(serializeRule(r));
    });

    const update = wrap(async (req, res) => {
      const r = findRule(req, res);
      if (!r) return;
      const body = { ...req.body };
      delete body.id;
      const rule = await buildRule(body, { existing: r });
      saveRule({ ...rule, id: r.id });
      res.json(serializeRule(getRule(r.id)));
    });
    api.patch(`${prefix}/rules/:id`, checkPlatform, update);
    api.put(`${prefix}/rules/:id`, checkPlatform, update);

    api.delete(`${prefix}/rules/:id`, checkPlatform, (req, res) => {
      const r = findRule(req, res);
      if (!r) return;
      deleteRule(r.id);
      logEvent(r.platform, 'info', `API: regla #${r.id} eliminada`);
      res.status(204).end();
    });
  }

  api.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, _req, res, _next) => res.status(err.status || 400).json({ error: err.type === 'entity.parse.failed' ? 'JSON inválido' : err.message }));
  return api;
}
