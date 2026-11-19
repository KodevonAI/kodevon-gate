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
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/c1\/replies$/);
  assert.equal(calls[0].body.message, 'Te escribí ana');
  assert.match(calls[1].url, /\/u1\?fields=/); // verifica follow antes del primer DM
  assert.deepEqual(calls[2].body.recipient, { comment_id: 'c1' });
  assert.equal(calls[2].body.message.text, 'Sígueme y toca el botón');
  assert.equal(calls[2].body.message.quick_replies[0].payload, `FOLLOW_CHECK:${ruleId}`);

  // Duplicado del webhook no repite nada
  await ig.handleWebhook(comment);
  assert.equal(calls.length, 3);

  // Toca el botón sin seguir
  const tap = (mid) => ({ object: 'instagram', entry: [{ id: '999', messaging: [{ sender: { id: 'IGSID1' }, recipient: { id: '999' }, message: { mid, text: 'Ya te sigo', quick_reply: { payload: `FOLLOW_CHECK:${ruleId}` } } }] }] });
  await ig.handleWebhook(tap('a'));
  assert.equal(calls.at(-1).body.message.text, 'Aún no me sigues');

  follows = true;
  await ig.handleWebhook(tap('b'));
  assert.equal(calls.at(-1).body.message.text, 'Aquí está: https://x.co');
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'delivered');
});

test('IG: si quien comenta ya sigue la cuenta, recibe el contenido directo sin el gate', async () => {
  igRule();
  mockFetch((url) => {
    if (url.includes('/replies')) return { id: 'r1' };
    if (url.includes('/u7?fields=')) return { username: 'leo', is_user_follow_business: true };
    if (url.endsWith('/999/messages')) return { recipient_id: 'IGSID7', message_id: 'm' };
    return {};
  });
  await ig.handleComment({ id: 'c7', text: 'guia', from: { id: 'u7', username: 'leo' } });
  const dm = calls.at(-1);
  assert.deepEqual(dm.body.recipient, { comment_id: 'c7' });
  assert.equal(dm.body.message.text, 'Aquí está: https://x.co');
  assert.equal(dm.body.message.quick_replies, undefined);
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'delivered');
});

test('IG: si no se puede verificar al comentar, envía el gate con botón', async () => {
  const ruleId = igRule();
  mockFetch((url) => {
    if (url.includes('/u8?fields=')) return { __status: 400, body: { error: { message: 'no consent' } } };
    if (url.endsWith('/999/messages')) return { recipient_id: 'IGSID8', message_id: 'm' };
    return {};
  });
  await ig.handleComment({ id: 'c8', text: 'guia', from: { id: 'u8', username: 'mia' } });
  assert.equal(calls.at(-1).body.message.text, 'Sígueme y toca el botón');
  assert.equal(calls.at(-1).body.message.quick_replies[0].payload, `FOLLOW_CHECK:${ruleId}`);
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'awaiting_follow');
});

test('IG: procesa la confirmación cuando Meta la envía en entry.changes.messages', async () => {
  const ruleId = igRule();
  mockFetch((url) => {
    if (url.endsWith('/999/messages')) return { recipient_id: 'IGSID1', message_id: 'sent' };
    if (url.includes('/IGSID1?fields=')) return { username: 'ana', is_user_follow_business: true };
    return {};
  });
  await ig.handleComment({ id: 'c6', text: 'guia', from: { id: 'u6', username: 'ana' } });

  await ig.handleWebhook({ object: 'instagram', entry: [{ id: '999', changes: [{
    field: 'messages', value: {
      sender: { id: 'IGSID1' }, recipient: { id: '999' }, timestamp: Date.now(),
      message: { mid: 'changes-mid-1', text: '✅ Ya te sigo', quick_reply: { payload: `FOLLOW_CHECK:${ruleId}` } },
    },
  }] }] });

  assert.ok(calls.some((call) => call.url.includes('/IGSID1?fields=')));
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

test('IG: si falla la verificación, avisa y permite reintentar hasta entregar el contenido', async () => {
  const ruleId = igRule();
  let checks = 0;
  mockFetch((url, body) => {
    if (url.endsWith('/999/messages')) return { recipient_id: 'IGSID1', message_id: 'sent' };
    if (url.includes('/IGSID1?fields=')) {
      checks++;
      if (checks === 1) return { __status: 503, body: { error: { message: 'temporarily unavailable' } } };
      return { username: 'ana', is_user_follow_business: true };
    }
    return {};
  });
  await ig.handleComment({ id: 'c4', text: 'guia', from: { id: 'u4', username: 'ana' } });
  const tap = (mid) => ({ object: 'instagram', entry: [{ id: '999', messaging: [{
    sender: { id: 'IGSID1' }, recipient: { id: '999' },
    message: { mid, text: '✅ Ya te sigo', quick_reply: { payload: `FOLLOW_CHECK:${ruleId}` } },
  }] }] });

  await ig.handleWebhook(tap('retry-1'));
  assert.match(calls.at(-1).body.message.text, /no me dejó verificar/);
  assert.equal(calls.at(-1).body.message.quick_replies[0].payload, `FOLLOW_CHECK:${ruleId}`);

  await ig.handleWebhook(tap('retry-2'));
  assert.equal(calls.at(-1).body.message.text, 'Aquí está: https://x.co');
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'delivered');
});

test('IG: si falla el envío del contenido después de confirmar el follow, ofrece reintentar', async () => {
  const ruleId = igRule();
  let sends = 0;
  mockFetch((url, body) => {
    if (url.includes('/IGSID1?fields=')) return { username: 'ana', is_user_follow_business: true };
    if (url.endsWith('/999/messages')) {
      sends++;
      if (sends === 2) return { __status: 503, body: { error: { message: 'temporarily unavailable' } } };
      return { recipient_id: 'IGSID1', message_id: `sent-${sends}` };
    }
    return {};
  });
  await ig.handleComment({ id: 'c5', text: 'guia', from: { id: 'u5', username: 'ana' } });
  const tap = (mid) => ({ object: 'instagram', entry: [{ id: '999', messaging: [{
    sender: { id: 'IGSID1' }, recipient: { id: '999' },
    message: { mid, text: '✅ Ya te sigo', quick_reply: { payload: `FOLLOW_CHECK:${ruleId}` } },
  }] }] });

  await ig.handleWebhook(tap('content-retry-1'));
  assert.match(calls.at(-1).body.message.text, /Confirmé que sigues/);
  assert.equal(calls.at(-1).body.message.quick_replies[0].payload, `FOLLOW_CHECK:${ruleId}`);
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'awaiting_follow');

  await ig.handleWebhook(tap('content-retry-2'));
  assert.equal(calls.at(-1).body.message.text, 'Aquí está: https://x.co');
  assert.equal(getDb().prepare('SELECT status FROM sessions').get().status, 'delivered');
});

test('TikTok: firma', () => {
  const body = '{"x":1}'; const t = Math.floor(Date.now() / 1000);
  const s = crypto.createHmac('sha256', 'ttsecret').update(`${t}.${body}`).digest('hex');
  assert.ok(tt.verifySignature(body, `t=${t},s=${s}`));
  assert.ok(!tt.verifySignature(body, `t=${t},s=abc`));
});

test('TikTok: DM con palabra clave → verifica con Apify; no sigue → pedir follow; LISTO → contenido', async () => {
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
  assert.deepEqual(calls.at(-2).body.handles, ['pepe']); // verificó antes de pedir follow
  const n = calls.length;
  await tt.handleWebhook(ev('2', 'hola'));
  assert.equal(calls.length, n); // texto cualquiera no dispara
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

test('TikTok: comentario → responde pidiendo DM; DM cualquiera de esa persona → verifica y entrega', async () => {
  saveRule({ platform: 'tiktok', keywords: 'claude', public_reply: 'Hola {nombre}, escríbeme {palabra} por DM', ask_follow_msg: 'Sígueme y escribe LISTO', content_msg: 'Toma: link', active: true });
  const replies = [];
  const reply = async (v, c, text) => replies.push([v, c, text]);
  const cm = (id, text, extra = {}) => ({ comment_id: id, text, username: 'ana', display_name: 'Ana', ...extra });
  await tt.processComments('V1', [cm('c0', 'claude')], { initialize: true, reply });
  assert.equal(replies.length, 0); // primera pasada: solo marca como vistos
  await tt.processComments('V1', [cm('c0', 'claude'), cm('c1', 'quiero CLAUDE'), cm('c2', 'claude', { owner: true }), cm('c3', 'claude', { parent_comment_id: 'c1' }), cm('c4', 'genial')], { reply });
  assert.deepEqual(replies, [['V1', 'c1', 'Hola Ana, escríbeme CLAUDE por DM']]);

  mockFetch((url) => {
    if (url.includes('api.apify.com')) return [{ list_type: 'following', unique_id: 'kodevon' }];
    return { code: 0, data: { message: { message_id: 'x' } } };
  });
  await tt.handleWebhook({ event: 'im_receive_msg', content: { conversation_id: 'cv', message_id: 'm1', type: 'text', text: { body: 'hola!' }, from: 'ana', from_user: { id: 'u1' } } });
  assert.equal(calls.at(-1).body.text.body, 'Toma: link');
  // un segundo DM cualquiera ya no vuelve a entregar
  const n = calls.length;
  await tt.handleWebhook({ event: 'im_receive_msg', content: { conversation_id: 'cv', message_id: 'm2', type: 'text', text: { body: 'gracias' }, from: 'ana', from_user: { id: 'u1' } } });
  assert.equal(calls.length, n);
});

test('TikTok: link del video → ID', async () => {
  const { resolveMedia } = await import('../src/rules.js');
  assert.equal(await resolveMedia('tiktok', 'https://www.tiktok.com/@kodevon/video/7441234567890123456?is_from_webapp=1'), '7441234567890123456');
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
  assert.match(calls.at(-3).url, /^https:\/\/graph\.facebook\.com\/v[\d.]+\/c9\/replies$/);
  assert.match(calls.at(-2).url, /graph\.facebook\.com\/v[\d.]+\/u9\?fields=.*access_token=PAGETOK/);
  assert.match(calls.at(-1).url, /graph\.facebook\.com\/v[\d.]+\/PAGE1\/messages$/);
  await ig.subscribeWebhooks();
  assert.match(calls.at(-1).url, /PAGE1\/subscribed_apps\?subscribed_fields=feed&access_token=PAGETOK/);
});

test('render conserva saltos de línea y limpia {username} vacío', async () => {
  const { render } = await import('../src/engine.js');
  assert.equal(render('¡Hola {username}!\n\n1️⃣ Paso', { username: '' }), '¡Hola!\n\n1️⃣ Paso');
  assert.equal(render('¡Listo {username}! Ok', { username: 'ana' }), '¡Listo ana! Ok');
});

test('IG: resuelve link de reel a ID numérico', async () => {
  setSetting('ig_access_token', 'EAAx'); setSetting('ig_page_token', 'P'); setSetting('ig_user_id', '777');
  mockFetch((url) => (url.includes('/777/media') ? { data: [{ id: '111', shortcode: 'AAA' }, { id: '222', shortcode: 'Df5BvgckR9p' }] } : {}));
  assert.equal(await ig.resolveMediaId('https://www.instagram.com/p/Df5BvgckR9p/'), '222');
  assert.equal(await ig.resolveMediaId('https://www.instagram.com/kodevon.ai/reel/Df5BvgckR9p/?igsh=x'), '222');
  assert.equal(await ig.resolveMediaId('123'), '123');
  await assert.rejects(ig.resolveMediaId('ZZZ'));
});

// ---------- Facebook ----------
const fbMod = await import('../src/facebook.js');

const fbSetup = () => {
  setSetting('fb_page_id', '555');
  setSetting('fb_page_token', 'ptok');
  return saveRule({
    platform: 'facebook', keywords: 'NOVEDADES', media_id: '777', active: true,
    public_reply: '¡Listo {nombre}! Te escribí por Messenger', content_msg: 'Aquí van {nombre}: https://x.co',
  });
};
const fbComment = (over = {}) => ({
  object: 'page',
  entry: [{ id: '555', changes: [{ field: 'feed', value: {
    item: 'comment', verb: 'add', comment_id: '777_c1', post_id: '555_777', parent_id: '555_777',
    message: 'quiero las novedades!', from: { id: 'u1', name: 'Ana Pérez' }, ...over,
  } }] }],
});

test('FB: comentario con palabra en el post → respuesta pública + private reply por Messenger', async () => {
  fbSetup();
  mockFetch(() => ({ recipient_id: 'psid1' }));
  await fbMod.handleWebhook(fbComment());
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /graph\.facebook\.com\/v[\d.]+\/777_c1\/comments$/);
  assert.equal(calls[0].body.message, '¡Listo Ana! Te escribí por Messenger');
  assert.match(calls[1].url, /\/555\/messages$/);
  assert.deepEqual(calls[1].body.recipient, { comment_id: '777_c1' });
  assert.equal(calls[1].body.message.text, 'Aquí van Ana: https://x.co');
  // el mismo comentario repetido no vuelve a disparar
  await fbMod.handleWebhook(fbComment());
  assert.equal(calls.length, 2);
});

test('FB: ignora otro post, respuestas a comentarios y mis propios comentarios', async () => {
  fbSetup();
  mockFetch((url) => (url.includes('attachments') ? { attachments: { data: [{ target: { id: '888' } }] } } : {}));
  await fbMod.handleWebhook(fbComment({ comment_id: 'x1', post_id: '555_999', parent_id: '555_999' }));
  await fbMod.handleWebhook(fbComment({ comment_id: 'x2', parent_id: '777_c0' }));
  await fbMod.handleWebhook(fbComment({ comment_id: 'x3', from: { id: '555', name: 'Kodevon' } }));
  assert.ok(calls.every((c) => !/comments$|messages$/.test(c.url)));
});

test('FB: regla con ID de video casa con el post vía attachments', async () => {
  fbSetup();
  mockFetch((url) => (url.includes('attachments') ? { attachments: { data: [{ target: { id: '777' } }] } } : {}));
  await fbMod.handleWebhook(fbComment({ comment_id: 'v1', post_id: '555_123', parent_id: '555_123' }));
  assert.ok(calls.some((c) => c.url.endsWith('/v1/comments')));
  assert.ok(calls.some((c) => c.url.endsWith('/555/messages')));
});

test('FB: palabra por Messenger → contenido', async () => {
  fbSetup();
  saveRule({ platform: 'facebook', keywords: 'guia', active: true, content_msg: 'Guía: https://g.co' });
  mockFetch(() => ({}));
  await fbMod.handleWebhook({ object: 'page', entry: [{ messaging: [{ sender: { id: 'u9' }, message: { mid: 'm1', text: 'GUÍA' } }] }] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.recipient, { id: 'u9' });
  assert.equal(calls[0].body.message.text, 'Guía: https://g.co');
});

test('FB: link de reel → ID del post; sin conexión propia reutiliza la página de IG (EAA)', async () => {
  setSetting('fb_page_id', '555');
  setSetting('fb_page_token', 'ptok');
  mockFetch(() => ({ post_id: '555_4242' }));
  assert.equal(await fbMod.resolveMediaId('https://www.facebook.com/reel/1234567890'), '4242');
  openDb(':memory:');
  setSetting('ig_access_token', 'EAAxyz');
  setSetting('ig_page_id', '321');
  setSetting('ig_page_token', 'igpage');
  assert.equal(fbMod.pageId(), '321');
  assert.equal(fbMod.pageToken(), 'igpage');
});
