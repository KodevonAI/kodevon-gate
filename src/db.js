import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,              -- instagram | tiktok | youtube
      name TEXT NOT NULL DEFAULT '',
      keywords TEXT NOT NULL,              -- separadas por coma
      media_id TEXT NOT NULL DEFAULT '',   -- opcional: solo ese post/video
      public_reply TEXT NOT NULL DEFAULT '',
      ask_follow_msg TEXT NOT NULL DEFAULT '',
      not_following_msg TEXT NOT NULL DEFAULT '',
      content_msg TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_key TEXT NOT NULL,              -- IGSID / conversation_id TikTok
      username TEXT NOT NULL DEFAULT '',
      rule_id INTEGER NOT NULL,
      status TEXT NOT NULL,                -- awaiting_follow | delivered
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, user_key, rule_id)
    );
    CREATE TABLE IF NOT EXISTS seen (
      platform TEXT NOT NULL, item_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(platform, item_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB no abierta');
  return db;
}

export function getSetting(key, fallback = '') {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
}

/** Devuelve true si es la primera vez que se ve este item (y lo marca). */
export function markSeen(platform, itemId) {
  const r = getDb().prepare('INSERT OR IGNORE INTO seen(platform, item_id) VALUES(?, ?)').run(platform, String(itemId));
  return r.changes === 1;
}

/** Permite reintentar un evento cuyo procesamiento no terminó correctamente. */
export function unmarkSeen(platform, itemId) {
  getDb().prepare('DELETE FROM seen WHERE platform = ? AND item_id = ?').run(platform, String(itemId));
}

export function logEvent(platform, level, message) {
  const line = `[${platform}] ${level.toUpperCase()}: ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
  try {
    const d = getDb();
    d.prepare('INSERT INTO events(platform, level, message) VALUES(?, ?, ?)').run(platform, level, String(message).slice(0, 2000));
    d.prepare('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id), 0) - 1000 FROM events)').run();
  } catch { /* ignore */ }
}

export function listRules(platform) {
  const d = getDb();
  return platform
    ? d.prepare('SELECT * FROM rules WHERE platform = ? ORDER BY id').all(platform)
    : d.prepare('SELECT * FROM rules ORDER BY platform, id').all();
}

export function getRule(id) {
  return getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id);
}

export function saveRule(r) {
  const d = getDb();
  const fields = {
    platform: r.platform,
    name: r.name || '',
    keywords: r.keywords || '',
    media_id: (r.media_id || '').trim(),
    public_reply: r.public_reply || '',
    ask_follow_msg: r.ask_follow_msg || '',
    not_following_msg: r.not_following_msg || '',
    content_msg: r.content_msg || '',
    active: r.active ? 1 : 0,
  };
  if (r.id) {
    d.prepare(`UPDATE rules SET platform=@platform, name=@name, keywords=@keywords, media_id=@media_id,
      public_reply=@public_reply, ask_follow_msg=@ask_follow_msg, not_following_msg=@not_following_msg,
      content_msg=@content_msg, active=@active WHERE id=@id`).run({ ...fields, id: Number(r.id) });
    return Number(r.id);
  }
  return Number(d.prepare(`INSERT INTO rules(platform, name, keywords, media_id, public_reply, ask_follow_msg,
    not_following_msg, content_msg, active) VALUES(@platform, @name, @keywords, @media_id, @public_reply,
    @ask_follow_msg, @not_following_msg, @content_msg, @active)`).run(fields).lastInsertRowid);
}

export function deleteRule(id) {
  getDb().prepare('DELETE FROM rules WHERE id = ?').run(id);
}

export function upsertSession(platform, userKey, ruleId, username, status) {
  getDb().prepare(`INSERT INTO sessions(platform, user_key, rule_id, username, status) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(platform, user_key, rule_id) DO UPDATE SET status = excluded.status,
    username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE sessions.username END,
    updated_at = datetime('now')`).run(platform, String(userKey), ruleId, username || '', status);
}

export function getSession(platform, userKey, ruleId) {
  return getDb().prepare('SELECT * FROM sessions WHERE platform = ? AND user_key = ? AND rule_id = ?')
    .get(platform, String(userKey), ruleId);
}

/** Sesión pendiente más reciente para un usuario. */
export function getPendingSession(platform, userKey) {
  return getDb().prepare(`SELECT * FROM sessions WHERE platform = ? AND user_key = ? AND status = 'awaiting_follow'
    ORDER BY updated_at DESC, id DESC LIMIT 1`).get(platform, String(userKey));
}

export function bumpAttempts(id) {
  getDb().prepare("UPDATE sessions SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function setSessionStatus(id, status) {
  getDb().prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}
