// db.js — SQLite user store for Weave
import Database from 'better-sqlite3';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'weave.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS weave_users (
    id              TEXT PRIMARY KEY,
    full_name       TEXT NOT NULL,
    nick_name       TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    profile_picture TEXT NOT NULL DEFAULT '🎭',
    is_admin        INTEGER NOT NULL DEFAULT 0,
    secret_phrase   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    try {
        const hashBuf = Buffer.from(hash, 'hex');
        const inputHash = scryptSync(password, salt, 64);
        return timingSafeEqual(hashBuf, inputHash);
    } catch {
        return false;
    }
}

export function createUser({ full_name, nick_name, password, profile_picture, secret_phrase }) {
    const id = randomUUID();
    const password_hash = hashPassword(password);
    try {
        db.prepare(`
            INSERT INTO weave_users (id, full_name, nick_name, password_hash, profile_picture, secret_phrase)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, full_name.trim(), nick_name.trim(), password_hash, profile_picture || '🎭', secret_phrase);
        db.prepare(`INSERT OR IGNORE INTO user_sound_configs (user_id) VALUES (?)`).run(id);
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export function loginUser(full_name, password) {
    const user = db.prepare('SELECT * FROM weave_users WHERE full_name = ?').get(full_name.trim());
    if (!user) return { ok: false, reason: 'not_found' };
    if (!verifyPassword(password, user.password_hash)) return { ok: false, reason: 'wrong_password' };
    return {
        ok: true,
        user: {
            id: user.id,
            nick_name: user.nick_name,
            profile_picture: user.profile_picture,
            is_admin: user.is_admin === 1,
        },
    };
}

export function verifySecretPhrase(full_name, secret_phrase) {
    const user = db.prepare('SELECT * FROM weave_users WHERE full_name = ?').get(full_name.trim());
    if (!user) return { ok: false };
    // Case-sensitive comparison as required
    if (user.secret_phrase !== secret_phrase) return { ok: false };
    return { ok: true, user_id: user.id };
}

export function updatePassword(user_id, new_password, new_secret_phrase = null) {
    const password_hash = hashPassword(new_password);
    if (new_secret_phrase) {
        db.prepare('UPDATE weave_users SET password_hash = ?, secret_phrase = ? WHERE id = ?')
          .run(password_hash, new_secret_phrase, user_id);
    } else {
        db.prepare('UPDATE weave_users SET password_hash = ? WHERE id = ?')
          .run(password_hash, user_id);
    }
    return { ok: true };
}

// Update only the recovery secret phrase (used when a password change isn't requested).
export function updateSecretPhrase(user_id, new_secret_phrase) {
    db.prepare('UPDATE weave_users SET secret_phrase = ? WHERE id = ?')
      .run(new_secret_phrase, user_id);
    return { ok: true };
}

// Look up an account (and its Full Name) from a user_id — sensitive cols excluded.
export function getUserById(user_id) {
    return db.prepare('SELECT id, full_name, nick_name, profile_picture, is_admin FROM weave_users WHERE id = ?').get(user_id) || null;
}

export function updateUserProfile(user_id, { nick_name, profile_picture }) {
    db.prepare('UPDATE weave_users SET nick_name = ?, profile_picture = ? WHERE id = ?')
      .run(nick_name, profile_picture, user_id);
    return { ok: true };
}

// verifyPassword() is module-private; expose a by-id check for the current-password gate.
export function verifyUserPasswordById(user_id, password) {
    const row = db.prepare('SELECT password_hash FROM weave_users WHERE id = ?').get(user_id);
    return !!row && verifyPassword(password, row.password_hash);
}

// ===== INVITE CODES =====
// Registration is invite-only: a logged-in member mints a one-time code, and a new account can
// only be created by redeeming a valid, unused code (consumed atomically on registration).
db.exec(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    code            TEXT PRIMARY KEY,
    created_by      TEXT NOT NULL,
    created_by_nick TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    used_by         TEXT,
    used_at         TEXT
  )
`);

// Unambiguous alphabet — no 0/O/1/I/L so a code is easy to read aloud and retype.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// 16 chars from the safe alphabet, grouped XXXX-XXXX-XXXX-XXXX for legibility.
function generateInviteCode() {
    const bytes = randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) out += '-';
        out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
    }
    return out;
}

export function createInviteCode(created_by, created_by_nick) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateInviteCode();
        try {
            db.prepare(`INSERT INTO invite_codes (code, created_by, created_by_nick) VALUES (?, ?, ?)`)
              .run(code, created_by, created_by_nick || null);
            return { ok: true, code };
        } catch (e) {
            // Retry only on the (astronomically rare) PK collision; otherwise bail.
            if (!/UNIQUE/i.test(e.message)) return { ok: false, error: e.message };
        }
    }
    return { ok: false, error: 'Could not generate a unique code.' };
}

// Atomically redeem an invite code AND create the user in one transaction: if either step fails,
// the code stays unused. The `UPDATE … WHERE used_at IS NULL` is the atomic claim, so two
// simultaneous registrations can never both consume the same code. Returns { ok:false,
// error:'INVALID_CODE' } when the code is missing or already used.
export function registerWithInvite({ full_name, nick_name, password, profile_picture, secret_phrase, invite_code }) {
    const tx = db.transaction(() => {
        const id = randomUUID();
        const claimed = db.prepare(
            `UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE code = ? AND used_at IS NULL`
        ).run(id, invite_code);
        if (claimed.changes === 0) throw new Error('INVALID_CODE');

        const password_hash = hashPassword(password);
        db.prepare(`
            INSERT INTO weave_users (id, full_name, nick_name, password_hash, profile_picture, secret_phrase)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, full_name.trim(), nick_name.trim(), password_hash, profile_picture || '🎭', secret_phrase);
        db.prepare(`INSERT OR IGNORE INTO user_sound_configs (user_id) VALUES (?)`).run(id);
        return id;
    });
    try {
        return { ok: true, id: tx() };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ===== LOGIN ATTEMPTS =====
// Every /api/auth/login outcome (success + failure) is recorded for tracking/audit. The full_name
// is stored exactly as submitted (so browser-autofill quirks are visible); the password never is.
db.exec(`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name  TEXT,
    ip         TEXT,
    success    INTEGER NOT NULL,
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function recordLoginAttempt(full_name, ip, success, reason) {
    db.prepare('INSERT INTO login_attempts (full_name, ip, success, reason) VALUES (?, ?, ?, ?)')
      .run(full_name ?? '', ip ?? '', success ? 1 : 0, reason || '');
}

// Persisted brute-force throttle: blocks once there are >= maxFails failed attempts within the
// window for EITHER the same Full Name OR the same IP. Shared by /login and /forgot so secret-
// phrase guessing counts too. created_at is SQLite UTC ('YYYY-MM-DD HH:MM:SS').
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILS = 10;
export function checkLoginThrottle(full_name, ip, windowMs = LOGIN_WINDOW_MS, maxFails = LOGIN_MAX_FAILS) {
    const mins = Math.max(1, Math.round(windowMs / 60000));
    const row = db.prepare(
        `SELECT COUNT(*) AS n, MIN(created_at) AS first FROM login_attempts
         WHERE success = 0 AND created_at > datetime('now', ?) AND (full_name = ? OR ip = ?)`
    ).get(`-${mins} minutes`, full_name ?? '', ip ?? '');
    if (!row || row.n < maxFails) return { allowed: true, retryAfterMs: 0 };
    const firstMs = Date.parse(String(row.first).replace(' ', 'T') + 'Z');
    return { allowed: false, retryAfterMs: Math.max(0, windowMs - (Date.now() - firstMs)) };
}

// ===== BUG REPORTS =====

db.exec(`
  CREATE TABLE IF NOT EXISTS bug_reports (
    id             TEXT PRIMARY KEY,
    full_name      TEXT NOT NULL,
    nick_name      TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    session_token  TEXT,
    filename       TEXT NOT NULL,
    browser_bytes  INTEGER NOT NULL DEFAULT 0,
    server_bytes   INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_br_fullname ON bug_reports(full_name, created_at);
`);

export const BUG_REPORT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // hard 2-hour timer

// Allowed only if this Full Name has no report newer than the cooldown window.
export function checkBugReportCooldown(full_name, windowMs = BUG_REPORT_COOLDOWN_MS) {
    const row = db.prepare('SELECT created_at FROM bug_reports WHERE full_name = ? ORDER BY created_at DESC LIMIT 1').get(full_name);
    if (!row) return { allowed: true, retryAfterMs: 0 };
    const elapsed = Date.now() - Date.parse(row.created_at);
    if (elapsed >= windowMs) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: windowMs - elapsed };
}

export function saveBugReport({ full_name, nick_name, user_id, session_token, filename, browser_bytes, server_bytes }) {
    const id = randomUUID();
    try {
        db.prepare(`INSERT INTO bug_reports (id, full_name, nick_name, user_id, session_token, filename, browser_bytes, server_bytes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, full_name, nick_name, user_id, session_token || null, filename, browser_bytes, server_bytes, new Date().toISOString());
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ===== MESSAGES =====

db.exec(`
  CREATE TABLE IF NOT EXISTS channel_messages (
    id              TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    nick_name       TEXT NOT NULL,
    profile_picture TEXT NOT NULL DEFAULT '🎭',
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cm_channel ON channel_messages(channel_id, created_at);
`);

export function saveMessage({ channel_id, user_id, nick_name, profile_picture, content }) {
    const id = randomUUID();
    try {
        db.prepare(`
            INSERT INTO channel_messages (id, channel_id, user_id, nick_name, profile_picture, content)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, channel_id, user_id, nick_name, profile_picture || '🎭', content);
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Returns the newest `limit` messages (optionally older than the `before` rowid cursor),
// reversed to ascending order for display. `rowid` on each row is the pagination cursor.
export function getChannelMessages(channel_id, { limit = 15, before } = {}) {
    const lim = Math.max(1, Math.min(Number(limit) || 15, 50));
    const rows = before
        ? db.prepare(
            'SELECT rowid AS rowid, * FROM channel_messages WHERE channel_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?'
          ).all(channel_id, Number(before), lim)
        : db.prepare(
            'SELECT rowid AS rowid, * FROM channel_messages WHERE channel_id = ? ORDER BY rowid DESC LIMIT ?'
          ).all(channel_id, lim);
    return rows.reverse();
}

export function updateMessage(id, content) {
    db.prepare(`UPDATE channel_messages SET content = ?, edited_at = datetime('now') WHERE id = ?`).run(content, id);
    return { ok: true };
}

export function deleteMessage(id) {
    db.prepare('DELETE FROM channel_messages WHERE id = ?').run(id);
    return { ok: true };
}

// Delete messages older than `days`. Returns the count plus any /uploads/ files that are
// no longer referenced by a surviving message, so the caller can unlink them from disk.
export function pruneOldMessages(days = 7) {
    const cutoff = `-${Number(days) || 7} days`;
    const expiring = db.prepare(
        `SELECT content FROM channel_messages WHERE created_at < datetime('now', ?)`
    ).all(cutoff);
    const info = db.prepare(
        `DELETE FROM channel_messages WHERE created_at < datetime('now', ?)`
    ).run(cutoff);

    const urlRe = /\/uploads\/[A-Za-z0-9._-]+/g;
    const candidates = new Set();
    for (const row of expiring) {
        const matches = String(row.content || '').match(urlRe);
        if (matches) for (const m of matches) candidates.add(m);
    }
    const stillRef = db.prepare(`SELECT 1 FROM channel_messages WHERE content LIKE ? LIMIT 1`);
    const orphanUrls = [];
    for (const url of candidates) {
        if (!stillRef.get(`%${url}%`)) orphanUrls.push(url);
    }
    return { deleted: info.changes, orphanUrls };
}

// ===== SESSIONS =====

db.exec(`
  CREATE TABLE IF NOT EXISTS weave_sessions (
    token           TEXT PRIMARY KEY,
    nick_name       TEXT NOT NULL,
    profile_picture TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER NOT NULL
  )
`);

// Remove expired sessions on startup
db.prepare('DELETE FROM weave_sessions WHERE expires_at < ?').run(Date.now());

export function createSession({ token, nick_name, profile_picture, user_id, is_admin, expires_at }) {
    db.prepare(`
        INSERT OR REPLACE INTO weave_sessions (token, nick_name, profile_picture, user_id, is_admin, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, nick_name, profile_picture || '🎭', user_id, is_admin ? 1 : 0, expires_at);
}

export function getSession(token) {
    const row = db.prepare('SELECT * FROM weave_sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (Date.now() > row.expires_at) {
        db.prepare('DELETE FROM weave_sessions WHERE token = ?').run(token);
        return null;
    }
    return { nick_name: row.nick_name, profile_picture: row.profile_picture, user_id: row.user_id, is_admin: row.is_admin === 1, expires: row.expires_at };
}

export function deleteSession(token) {
    db.prepare('DELETE FROM weave_sessions WHERE token = ?').run(token);
}

// Invalidate ALL active sessions for a user (e.g. after an admin password reset) so old join
// tokens stop working and the user must log in again.
export function deleteSessionsByUser(user_id) {
    db.prepare('DELETE FROM weave_sessions WHERE user_id = ?').run(user_id);
}

// ===== USER SOUND CONFIGS =====

db.exec(`
  CREATE TABLE IF NOT EXISTS user_sound_configs (
    user_id      TEXT PRIMARY KEY,
    join_sounds  TEXT NOT NULL DEFAULT '["join_channel.ogg"]',
    leave_sounds TEXT NOT NULL DEFAULT '["leave_channel.ogg"]'
  )
`);

// Seed existing users with defaults on startup
db.exec(`
  INSERT OR IGNORE INTO user_sound_configs (user_id, join_sounds, leave_sounds)
  SELECT id, '["join_channel.ogg"]', '["leave_channel.ogg"]' FROM weave_users
`);

export function listAllUsers() {
    return db.prepare('SELECT id, full_name, nick_name, profile_picture FROM weave_users ORDER BY nick_name ASC').all();
}

export function getUserSoundConfig(user_id) {
    const row = db.prepare('SELECT * FROM user_sound_configs WHERE user_id = ?').get(user_id);
    if (!row) return { join_sounds: ['join_channel.ogg'], leave_sounds: ['leave_channel.ogg'] };
    return {
        join_sounds: JSON.parse(row.join_sounds),
        leave_sounds: JSON.parse(row.leave_sounds),
    };
}

export function setUserSoundConfig(user_id, join_sounds, leave_sounds) {
    db.prepare(`
        INSERT OR REPLACE INTO user_sound_configs (user_id, join_sounds, leave_sounds)
        VALUES (?, ?, ?)
    `).run(user_id, JSON.stringify(join_sounds), JSON.stringify(leave_sounds));
    return { ok: true };
}

// ===== SETTINGS (key/value singletons) =====

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

export function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
}

export function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
    return { ok: true };
}

// ===== ADMIN HELPERS =====

const SENSITIVE_COLS = new Set(['password_hash', 'secret_phrase', 'session_token']);

function validatedTable(tableName) {
    const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);
    if (!tables.includes(tableName)) throw new Error(`Unknown table: ${tableName}`);
    return tableName;
}

export function listTables() {
    return db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(r => r.name);
}

export function getTableRecords(tableName, limit = 1000) {
    validatedTable(tableName);
    let rows;
    try {
        // rowid DESC = newest-by-insertion first (universal across rowid tables)
        rows = db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid DESC LIMIT ?`).all(limit);
    } catch {
        // Fallback for any WITHOUT ROWID table
        rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ?`).all(limit);
    }
    // Strip sensitive values for display
    return rows.map(row => {
        const safe = { ...row };
        for (const col of SENSITIVE_COLS) if (col in safe) safe[col] = null;
        return safe;
    });
}

export function updateRecord(tableName, id, fields) {
    validatedTable(tableName);
    const schema = db.prepare(`PRAGMA table_info("${tableName}")`).all().map(c => c.name);
    const allowed = Object.keys(fields).filter(k => schema.includes(k) && k !== 'id' && !SENSITIVE_COLS.has(k));
    if (allowed.length === 0) return { ok: false, error: 'No editable fields provided.' };
    const set  = allowed.map(k => `"${k}" = ?`).join(', ');
    const vals = allowed.map(k => fields[k]);
    db.prepare(`UPDATE "${tableName}" SET ${set} WHERE id = ?`).run(...vals, id);
    return { ok: true };
}

export function deleteRecord(tableName, id) {
    validatedTable(tableName);
    db.prepare(`DELETE FROM "${tableName}" WHERE id = ?`).run(id);
    return { ok: true };
}
