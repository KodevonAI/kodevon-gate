import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_PASSWORD = 'pw';
process.env.API_KEY = 'testkey';

const { openDb, setSetting } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

const realFetch = globalThis.fetch;
let server;
let base;

before(async () => {
  openDb(':memory:');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  // Graph API simulada para resolver links de Instagram
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.includes('/media')) return new Response(JSON.stringify({ data: [{ id: '1789', shortcode: 'ABC123', permalink: 'https://www.instagram.com/reel/ABC123/' }] }));
    return new Response('{}');
  };
});
after(() => { server.close(); globalThis.fetch = realFetch; });
beforeEach(() => {
  openDb(':memory:');
  setSetting('ig_access_token', 'tok');
  setSetting('ig_user_id', '999');
});

const call = (method, path, body, key = 'testkey') => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('API: exige API key', async () => {
  assert.equal((await call('GET', '/rules', undefined, null)).status, 401);
  assert.equal((await call('GET', '/rules', undefined, 'mala')).status, 401);
  const r = await fetch(`${base}/rules`, { headers: { 'x-api-key': 'testkey' } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(base)).status, 200); // docs públicas
});

test('API: crear regla de Instagram con link y defaults', async () => {
  const r = await call('POST', '/instagram/rules', { keywords: ['Claude', ' guia '], media_url: 'https://www.instagram.com/reel/ABC123/', content_msg: 'Aquí: https://x.co' });
  assert.equal(r.status, 201);
  const rule = await r.json();
  assert.equal(rule.platform, 'instagram');
  assert.deepEqual(rule.keywords, ['Claude', 'guia']);
  assert.equal(rule.media_id, '1789');
  assert.ok(rule.ask_follow_msg.length > 0);
  assert.ok(rule.public_reply.length > 0);
  assert.equal(rule.active, true);
  assert.equal(r.headers.get('location'), `/api/v1/rules/${rule.id}`);
});

test('API: validaciones', async () => {
  assert.equal((await call('POST', '/rules', { platform: 'x', keywords: 'a' })).status, 400);
  const yt = await call('POST', '/youtube/rules', { keywords: 'a' });
  assert.equal(yt.status, 400);
  assert.match((await yt.json()).error, /public_reply/);
  assert.equal((await call('POST', '/tiktok/rules', { content_msg: 'x' })).status, 400);
  const bad = await call('POST', '/rules', '{mal json');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'JSON inválido');
  assert.equal((await call('GET', '/facebook/rules')).status, 404);
});

test('API: YouTube extrae ID del link y TikTok usa defaults', async () => {
  const yt = await (await call('POST', '/rules', { platform: 'youtube', keywords: 'claude', media_url: 'https://youtube.com/shorts/abcdefghijk', public_reply: 'Link: https://x.co' })).json();
  assert.equal(yt.media_id, 'abcdefghijk');
  const tt = await (await call('POST', '/tiktok/rules', { keywords: 'claude', content_msg: 'https://x.co' })).json();
  assert.match(tt.ask_follow_msg, /LISTO/);
});

test('API: listar, editar, filtrar y borrar', async () => {
  const bulk = await call('POST', '/rules', [
    { platform: 'tiktok', keywords: 'a', content_msg: 'c' },
    { platform: 'youtube', keywords: 'b', public_reply: 'r' },
    { platform: 'youtube', keywords: 'c' },
  ]);
  assert.equal(bulk.status, 207);
  const { results } = await bulk.json();
  assert.deepEqual(results.map((x) => x.ok), [true, true, false]);

  const id = results[1].rule.id;
  const list = await (await call('GET', '/rules?platform=youtube')).json();
  assert.equal(list.count, 1);

  const upd = await (await call('PATCH', `/rules/${id}`, { keywords: 'nueva, otra', active: false })).json();
  assert.deepEqual(upd.keywords, ['nueva', 'otra']);
  assert.equal(upd.active, false);
  assert.equal(upd.public_reply, 'r'); // se conserva

  assert.equal((await (await call('GET', '/rules?active=true')).json()).count, 1);
  assert.equal((await call('GET', `/instagram/rules/${id}`)).status, 404); // otra plataforma
  assert.equal((await call('DELETE', `/youtube/rules/${id}`)).status, 204);
  assert.equal((await call('GET', `/rules/${id}`)).status, 404);
});

test('API: status', async () => {
  const s = await (await call('GET', '/status')).json();
  assert.equal(s.instagram.connected, true);
  assert.equal(s.youtube.connected, false);
});
