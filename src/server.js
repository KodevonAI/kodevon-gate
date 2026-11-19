import { config, applyPanelCredentials } from './config.js';
import { openDb, logEvent, getSetting } from './db.js';
import { createApp } from './app.js';
import { ensureApiKey } from './api.js';
import * as ig from './instagram.js';
import * as yt from './youtube.js';
import * as tt from './tiktok.js';

openDb(config.dbPath);
applyPanelCredentials(getSetting);
ensureApiKey();
const app = createApp();

app.listen(config.port, () => {
  console.log(`Kodevon Gate escuchando en :${config.port} (${config.baseUrl})`);
});

// Instagram: cargar cuenta y renovar token periódicamente
(async () => {
  try { if (ig.token() && !getSetting('ig_user_id')) await ig.loadAccount(); } catch (e) { logEvent('instagram', 'error', e.message); }
  await ig.refreshTokenIfNeeded();
})();
setInterval(() => ig.refreshTokenIfNeeded(), 12 * 3600 * 1000);

// YouTube: revisar comentarios
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try { await yt.poll(); } catch (e) { logEvent('youtube', 'error', e.message); } finally { polling = false; }
}, config.youtube.pollSeconds * 1000);

// TikTok: revisar comentarios en los videos
let ttPolling = false;
setInterval(async () => {
  if (ttPolling) return;
  ttPolling = true;
  try { await tt.pollComments(); } catch (e) { logEvent('tiktok', 'error', e.message); } finally { ttPolling = false; }
}, config.tiktok.pollSeconds * 1000);
