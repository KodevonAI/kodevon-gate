import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.IG_APP_SECRET = 'igsecret';
process.env.IG_VERIFY_TOKEN = 'verify123';
process.env.TIKTOK_APP_SECRET = 'ttsecret';
process.env.TIKTOK_USERNAME = 'kodevon';
process.env.APIFY_TOKEN = 'apify';
process.env.ADMIN_PASSWORD = 'pw';

const { openDb, setSetting, saveRule, getDb } = await import('../src/db.js');
const { matchRule, isConfirmation } = await import('../src/engine.js');
const ig = await import('../src/instagram.js');
const tt = await import('../src/tiktok.js');
const yt = await import('../src/youtube.js');

let calls;
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), method: opts.method || 'GET', body });
    const out = handler(String(url), body) ?? {};
    return new Response(JSON.stringify(out.__status ? out.body : out), { status: out.__status || 200 });
  };
}

beforeEach(() => {
  openDb(':memory:');
  setSetting('ig_access_token', 'tok');
  setSetting('ig_user_id', '999');
  setSetting('ig_username', 'kodevon');
  setSetting('tt_business_id', 'biz');
  setSetting('tt_access_token', 'ttok');
  setSetting('tt_expires_at', String(Date.now() + 3600e3));
});

const igRule = () => saveRule({
  platform: 'instagram', keywords: 'Cálculo, GUIA', public_reply: 'Te escribí {username}', active: true,
  ask_follow_msg: 'Sígueme y toca el botón', not_following_msg: 'Aún no me sigues', content_msg: 'Aquí está: https://x.co',
});

test('match: ignora mayúsculas/tildes y exige palabra completa', () => {
  igRule();
  assert.ok(matchRule('instagram', 'quiero el CALCULO porfa'));
  assert.ok(matchRule('instagram', 'guía!'));
  assert.equal(matchRule('instagram', 'guiaz'), null);
  assert.equal(matchRule('tiktok', 'guia'), null);
  assert.ok(isConfirmation('Listo!!', ['listo']));
  assert.ok(!isConfirmation('no estoy listo', ['listo']));
});

test('IG: firma del webhook', () => {
  const body = '{"a":1}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 'igsecret').update(body).digest('hex');
  assert.ok(ig.verifySignature(body, sig));
  assert.ok(!ig.verifySignature(body, 'sha256=00'));
});

test('IG: comentario → respuesta pública + DM con botón; botón → no sigue → sigue → contenido', async () => {
  const ruleId = igRule();
  let follows = false;
  mockFetch((url) => {
    if (url.includes('/replies')) return { id: 'r1' };
    if (url.endsWith('/999/messages')) return { recipient_id: 'IGSID1', message_id: 'm' };
    if (url.includes('/IGSID1?fields=')) return { username: 'ana', is_user_follow_business: follows };
    return {};
  });
  const comment = { object: 'instagram', entry: [{ id: '999', changes: [{ field: 'comments', value: { id: 'c1', text: 'GUIA', from: { id: 'u1', username: 'ana' }, media: { id: 'm1' } } }] }] };
  await ig.handleWebhook(comment);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/c1\/replies$/);
  assert.equal(calls[0].body.message, 'Te escribí ana');
  assert.deepEqual(calls[1].body.recipient, { comment_id: 'c1' });
  assert.equal(calls[1].body.message.quick_replies[0].payload, `FOLLOW_CHECK:${ruleId}`);

  // Duplicado del webhook no repite nada
  await ig.handleWebhook(comment);
  assert.equal(calls.length, 2);

  // Toca el botón sin seguir
  const tap = (mid) => ({ object: 'instagram', entry: [{ id: '999', messaging: [{ sender: { id: 'IGSID1' }, recipient: { id: '999' }, message: { mid, text: 'Ya te sigo', quick_reply: { payload: `FOLLOW_CHECK:${ruleId}` } } }] }] });
  await ig.handleWebhook(tap('a'));
  assert.equal(calls.at(-1).body.message.text, 'Aún no me sigues');

  follows = true;
  await ig.handleWebhook(tap('b'));
  assert.equal(calls.at(-1).body.message.text, 'Aquí está: https://x.co');
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'delivered');
});

test('IG: ignora mis propios comentarios', async () => {
  igRule();
  mockFetch(() => ({}));
  await ig.handleWebhook({ object: 'instagram', entry: [{ changes: [{ field: 'comments', value: { id: 'c2', text: 'guia', from: { id: '999', username: 'kodevon' } } }] }] });
  assert.equal(calls.length, 0);
});

test('IG: si el botón es rechazado, reenvía solo texto', async () => {
  igRule();
  let n = 0;
  mockFetch((url, body) => {
    if (url.endsWith('/999/messages')) { n++; if (body.message.quick_replies) return { __status: 400, body: { error: { message: 'no' } } }; return { recipient_id: 'X' }; }
    return {};
  });
  await ig.handleComment({ id: 'c3', text: 'guia', from: { id: 'u3', username: 'b' } });
  assert.equal(n, 2);
});

test('TikTok: firma', () => {
  const body = '{"x":1}'; const t = Math.floor(Date.now() / 1000);
  const s = crypto.createHmac('sha256', 'ttsecret').update(`${t}.${body}`).digest('hex');
  assert.ok(tt.verifySignature(body, `t=${t},s=${s}`));
  assert.ok(!tt.verifySignature(body, `t=${t},s=abc`));
});

test('TikTok: palabra clave → pedir follow; LISTO → verifica con Apify → contenido', async () => {
  saveRule({ platform: 'tiktok', keywords: 'guia', ask_follow_msg: 'Sígueme y escribe LISTO', not_following_msg: 'Aún no', content_msg: 'Toma: link', active: true });
  let following = [{ list_type: 'following', unique_id: 'otro' }];
  mockFetch((url) => {
    if (url.includes('api.apify.com')) return following;
    if (url.includes('/business/message/send/')) return { code: 0, data: { message: { message_id: 'x' } } };
    return { code: 0, data: {} };
  });
  const ev = (id, body) => ({ event: 'im_receive_msg', user_openid: 'biz', content: JSON.stringify({ conversation_id: 'conv1', message_id: id, type: 'text', text: { body }, from: 'pepe', from_user: { id: 'u9' }, to_user: { id: 'biz' } }) });
  await tt.handleWebhook(ev('1', 'Quiero la GUIA'));
  assert.equal(calls.at(-1).body.text.body, 'Sígueme y escribe LISTO');
  await tt.handleWebhook(ev('2', 'hola'));
  assert.equal(calls.length, 1); // texto cualquiera no dispara
  await tt.handleWebhook(ev('3', 'listo'));
  assert.equal(calls.at(-1).body.text.body, 'Aún no');
  assert.deepEqual(calls.at(-2).body.handles, ['pepe']);
  following = [{ list_type: 'following', unique_id: 'Kodevon' }];
  await tt.handleWebhook(ev('4', 'listo!'));
  assert.equal(calls.at(-1).body.text.body, 'Toma: link');
});

test('TikTok: lista privada → se entrega igual', async () => {
  saveRule({ platform: 'tiktok', keywords: 'guia', ask_follow_msg: 'a', content_msg: 'Toma', active: true });
  mockFetch((url) => (url.includes('apify') ? [] : { code: 0, data: { message: { message_id: 'x' } } }));
  const ev = (id, body) => ({ event: 'im_receive_msg', content: { conversation_id: 'c', message_id: id, type: 'text', text: { body }, from: 'p', from_user: { id: 'u' } } });
  await tt.handleWebhook(ev('1', 'guia'));
  await tt.handleWebhook(ev('2', 'listo'));
  assert.equal(calls.at(-1).body.text.body, 'Toma');
});

test('YouTube: primera pasada no responde; luego responde con link y omite mis comentarios', async () => {
  saveRule({ platform: 'youtube', keywords: 'guia', public_reply: 'Aquí {username}: https://kodevon.com/guia', active: true });
  setSetting('yt_channel_id', 'MYCH');
  const th = (id, text, author = 'OTHER', name = '@juan') => ({ id, snippet: { videoId: 'v1', topLevelComment: { snippet: { textOriginal: text, authorChannelId: { value: author }, authorDisplayName: name } } } });
  const replies = [];
  const reply = async (pid, text) => replies.push([pid, text]);
  await yt.processThreads([th('t0', 'guia')], { initialize: true, reply });
  assert.equal(replies.length, 0);
  await yt.processThreads([th('t0', 'guia'), th('t1', 'GUIA porfa'), th('t2', 'guia', 'MYCH'), th('t3', 'gracias')], { reply });
  assert.deepEqual(replies, [['t1', 'Aquí juan: https://kodevon.com/guia']]);
});

test('IG modo Facebook (token EAA): carga página, usa graph.facebook.com y token de página', async () => {
  setSetting('ig_access_token', 'EAAsystem');
  mockFetch((url) => {
    if (url.includes('/me/accounts')) return { data: [{ id: 'PAGE1', name: 'Kodevon', access_token: 'PAGETOK', instagram_business_account: { id: '777', username: 'kodevon' } }] };
    if (url.endsWith('/PAGE1/messages')) return { recipient_id: 'S1' };
    return {};
  });
  const acc = await ig.loadAccount();
  assert.equal(acc.id, '777');
  saveRule({ platform: 'instagram', keywords: 'guia', public_reply: 'ok', ask_follow_msg: 'sigue', content_msg: 'x', active: true });
  await ig.handleComment({ id: 'c9', text: 'guia', from: { id: 'u9', username: 'z' } });
  assert.match(calls.at(-2).url, /^https:\/\/graph\.facebook\.com\/v[\d.]+\/c9\/replies$/);
  assert.match(calls.at(-1).url, /graph\.facebook\.com\/v[\d.]+\/PAGE1\/messages$/);
  await ig.subscribeWebhooks();
  assert.match(calls.at(-1).url, /PAGE1\/subscribed_apps\?subscribed_fields=feed&access_token=PAGETOK/);
});
