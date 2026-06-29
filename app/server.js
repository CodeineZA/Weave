// server.js — Weave SFU (mediasoup) + user auth
import http from 'http';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import * as mediasoup from 'mediasoup';
import { createUser, registerWithInvite, createInviteCode, loginUser, verifySecretPhrase, updatePassword, updateSecretPhrase, listTables, getTableRecords, updateRecord, deleteRecord, saveMessage, getChannelMessages, pruneOldMessages, createSession, getSession, deleteSession, deleteSessionsByUser, listAllUsers, getUserSoundConfig, setUserSoundConfig, getUserById, checkBugReportCooldown, saveBugReport, updateUserProfile, verifyUserPasswordById, recordLoginAttempt, checkLoginThrottle, getSetting, setSetting } from './db.js';

dotenv.config();

const PORT = parseInt(process.env.PORT) || 3000;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1';
// Optional second announced address (the Pi's LAN IP) so same-network clients get a working ICE
// candidate — the router doesn't hairpin packets sent to the public IP from inside the LAN.
const LOCAL_ANNOUNCED_IP = process.env.LOCAL_ANNOUNCED_IP || '';
// ICE candidates offered on every WebRtcTransport: public (WAN) + LAN (if set). Each peer's ICE
// agent uses whichever connects — remote peers the public one, same-WiFi peers the local one.
const WEBRTC_LISTEN_IPS = [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }];
if (LOCAL_ANNOUNCED_IP) WEBRTC_LISTEN_IPS.push({ ip: '0.0.0.0', announcedIp: LOCAL_ANNOUNCED_IP });
const RTC_MIN_PORT = parseInt(process.env.RTC_MIN_PORT) || 10000;
const RTC_MAX_PORT = parseInt(process.env.RTC_MAX_PORT) || 10100;

// New id per process start — the client shows the "What's New" board once per restart, per user.
const SERVER_BOOT_ID = randomUUID();

// ===== LOGGING =====
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const bugReportsDir = path.join(logsDir, 'bug_reports');
if (!fs.existsSync(bugReportsDir)) fs.mkdirSync(bugReportsDir, { recursive: true });
// User-uploaded chat images — under the persisted ./data mount, served at /uploads/.
const uploadsDir = path.join(process.cwd(), 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const logStream = fs.createWriteStream(path.join(logsDir, 'server.log'), { flags: 'a' });

function serverLog(username = 'SYSTEM', action, details = '') {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `[${ts}] ${username.padEnd(15)} | ${action.padEnd(25)} | ${details}`;
    console.log(line);
    logStream.write(line + '\n');
}

// ===== MEDIASOUP =====
const mediaCodecs = [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8',  clockRate: 90000,
      parameters: { 'x-google-start-bitrate': 1000 } },
];

let worker;
let router;

async function startSFU() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: RTC_MIN_PORT,
        rtcMaxPort: RTC_MAX_PORT,
    });
    worker.on('died', (err) => {
        serverLog('SYSTEM', 'WORKER_DIED', err.message);
        process.exit(1);
    });
    router = await worker.createRouter({ mediaCodecs });
    serverLog('SYSTEM', 'SFU_READY', `ports ${RTC_MIN_PORT}-${RTC_MAX_PORT} | announced: ${ANNOUNCED_IP}`);
}

// ===== AUTH TOKENS =====
// Join tokens are persisted in SQLite so they survive container restarts.
// reset_token → { user_id, expires }
const pendingResetTokens = new Map();

function issueJoinToken(nick_name, profile_picture, user_id, is_admin = false) {
    const token = randomUUID();
    const expires_at = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
    createSession({ token, nick_name, profile_picture, user_id, is_admin, expires_at });
    return token;
}

function requireAdmin(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const entry = token ? validateJoinToken(token) : null;
    return entry?.is_admin ? entry : null;
}

function validateJoinToken(token) {
    return getSession(token);
}

function issueResetToken(user_id) {
    const token = randomUUID();
    const expires = Date.now() + 15 * 60 * 1000; // 15 minutes
    pendingResetTokens.set(token, { user_id, expires });
    setTimeout(() => pendingResetTokens.delete(token), 15 * 60 * 1000);
    return token;
}

// ===== PEER STATE =====
const peers = new Map();

function formatRoom() {
    return Array.from(peers.values()).map(p => p.username).join(', ') || 'empty';
}

// ===== PRIVATE CHANNELS =====
// Ephemeral, user-created channels held only in memory. They self-destruct when the
// last occupant leaves, so a server restart (everyone disconnects → all empty) wipes
// them by design — nothing is persisted. Permanent channels (lobby/room:*) never touch
// any of this; the only test that branches the new logic is `isPrivateChannel(id)`.
// Record: { id, name, creatorId, allowedUserIds:Set<user_id>, occupiedOnce, createdAt }
const privateChannels = new Map();

const isPrivateChannel = id => typeof id === 'string' && id.startsWith('private:');

// How many live peers are currently standing in this channel.
function channelOccupancy(id) {
    let n = 0;
    for (const [, p] of peers) if ((p.mapPos?.channelId || 'lobby') === id) n++;
    return n;
}

function createPrivateChannel({ name, creatorId, allowedUserIds }) {
    const id = `private:${randomUUID()}`;
    const set = new Set(allowedUserIds);
    set.add(creatorId); // creator is always allowed
    const rec = { id, name, creatorId, allowedUserIds: set, occupiedOnce: false, createdAt: Date.now() };
    privateChannels.set(id, rec);
    return rec;
}

// The private channels a given user may see. Admins see all; canManage = admin or creator.
function visiblePrivateChannelsFor(userId, isAdmin = false) {
    const out = [];
    for (const [, r] of privateChannels) {
        if (isAdmin || r.allowedUserIds.has(userId)) {
            out.push({ channelId: r.id, label: r.name, canManage: isAdmin || r.creatorId === userId });
        }
    }
    return out;
}

// Mask a channelId for a given viewer. A private channel the viewer can't see collapses to a
// sentinel, so its id and membership never leak over the wire (peer_moved / mapPositions go to
// everyone). The client has no such channel in its list, so the masked peer simply isn't shown.
// Permanent channels always pass through unchanged.
const HIDDEN_CHANNEL = '__hidden__';
function channelIdFor(viewer, channelId) {
    if (!isPrivateChannel(channelId)) return channelId;
    const r = privateChannels.get(channelId);
    if (r && (r.allowedUserIds.has(viewer.user_id) || viewer.is_admin)) return channelId;
    return HIDDEN_CHANNEL;
}

// Flip occupiedOnce true the first time a peer is actually standing in the channel, so a
// brand-new channel can't be reaped in the window between create and the creator's move.
function markOccupied(id) {
    const r = privateChannels.get(id);
    if (r && channelOccupancy(id) > 0) r.occupiedOnce = true;
}

// Tell everyone who could see the channel that it's gone.
function broadcastChannelDestroyed(rec) {
    for (const [ws, p] of peers) {
        if (rec.allowedUserIds.has(p.user_id) || p.is_admin) send(ws, { type: 'channelDestroyed', channelId: rec.id });
    }
}

// Destroy a private channel iff it has been occupied at least once and is now empty.
function destroyIfEmpty(id) {
    const r = privateChannels.get(id);
    if (!r || !r.occupiedOnce || channelOccupancy(id) > 0) return;
    privateChannels.delete(id);
    serverLog('SYSTEM', 'PRIV_CHANNEL_DESTROY', `${id} (${r.name})`);
    broadcastChannelDestroyed(r);
}

// Send a message to every live connection (tab) belonging to a user.
function sendToUser(userId, msg) {
    for (const [ws, p] of peers) if (p.user_id === userId) send(ws, msg);
}

// Push a user their current visible-channel list (full replace — idempotent, self-healing).
function pushVisibleChannels(userId) {
    let isAdmin = false;
    for (const [, p] of peers) if (p.user_id === userId) { isAdmin = p.is_admin; break; }
    sendToUser(userId, { type: 'privateChannels', channels: visiblePrivateChannelsFor(userId, isAdmin) });
}

// Safety net: reap an orphan channel created but never entered (only reachable from a
// non-WS client). Runs every 30 s; a 60 s grace covers the normal create→join handoff.
function sweepStalePrivateChannels() {
    const now = Date.now();
    for (const [id, r] of privateChannels) {
        if (channelOccupancy(id) !== 0) continue;
        if (r.occupiedOnce || now - r.createdAt > 60_000) {
            privateChannels.delete(id);
            serverLog('SYSTEM', 'PRIV_CHANNEL_SWEEP', id);
            broadcastChannelDestroyed(r);
        }
    }
}
setInterval(sweepStalePrivateChannels, 30_000);

// ===== EVENT LISTENER =====
// General dispatcher: handle a named event for a given user. Add more event
// types as additional if-blocks below.
const BIRTHDAY_SOUND = 'Dozi_Lekker_Verjaar_Frikkie.ogg';
// Join tokens that have already fired the birthday event — once per login session.
// (Reconnects reuse the same token; a fresh login issues a new token and fires again.)
const birthdayFiredSessions = new Set();

function eventListener(user, eventType) {
    if (eventType === 'birthdayEvent') {
        // Find the live peer for this user_id
        let targetWs = null, targetPeer = null;
        for (const [cws, p] of peers) {
            if (p.user_id === user) { targetWs = cws; targetPeer = p; break; }
        }
        if (!targetPeer) return;

        // Give them ~5s to fully connect, then play the birthday sound for
        // everyone in their channel — including the birthday user themselves.
        setTimeout(() => {
            if (!peers.has(targetWs)) return;            // they disconnected
            const channel = peers.get(targetWs).mapPos?.channelId || 'lobby';
            for (const [cws, cpeer] of peers) {
                if ((cpeer.mapPos?.channelId || 'lobby') === channel) {
                    send(cws, { type: 'persona_sound', sound: BIRTHDAY_SOUND });
                }
            }
            serverLog(targetPeer.username, 'BIRTHDAY_EVENT', `channel=${channel}`);
        }, 5000);
    }
}

// ===== HTTP HELPERS =====
function sendJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
}

const MAX_BODY_BYTES = 2_000_000;
function parseBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve) => {
        let body = '', size = 0, over = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) { over = true; return; }   // stop buffering; bounds memory
            body += chunk.toString();
        });
        req.on('end', () => {
            if (over) return resolve({});
            try { resolve(JSON.parse(body)); }
            catch { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

// ── Link-preview (Open Graph) — in-memory cache, never persisted to the DB ────
const linkPreviewCache = new Map();           // url -> { exp, data }
const LINK_PREVIEW_TTL = 60 * 60 * 1000;      // 1 hour

function isPrivateIp(addr) {
    if (!addr) return true;
    if (addr === '::1' || addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true;
    const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = +m[1], b = +m[2];
    return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) ||
           (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

async function getLinkPreview(rawUrl) {
    const cached = linkPreviewCache.get(rawUrl);
    if (cached && cached.exp > Date.now()) return cached.data;

    let result = { ok: false };
    try {
        // Follow redirects manually, re-validating the host/IP at EACH hop so a public URL can't
        // 302 us into the LAN (localhost / metadata / internal admin UIs). Cap at 4 hops.
        let current = rawUrl, resp = null, u = null;
        for (let hop = 0; hop < 4; hop++) {
            u = new URL(current);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
            const host = u.hostname.toLowerCase();
            if (host === 'localhost' || host.endsWith('.local')) throw new Error('host');
            const { address } = await dns.promises.lookup(host);   // SSRF guard (per hop)
            if (isPrivateIp(address)) throw new Error('private');
            resp = await fetch(current, {
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeaveBot/1.0)', 'Accept': 'text/html' },
            });
            if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
                current = new URL(resp.headers.get('location'), current).href;
                continue;
            }
            break;
        }
        if (!resp) throw new Error('no-response');
        const ctype = String(resp.headers.get('content-type') || '');
        if (!resp.ok || !ctype.includes('text/html') || !resp.body) throw new Error('not-html');

        // Read at most ~512 KB (or stop once </head> is in — OG tags live there).
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let html = '', received = 0;
        while (received < 512 * 1024) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            html += dec.decode(value, { stream: true });
            if (/<\/head>/i.test(html)) break;
        }
        try { await reader.cancel(); } catch {}

        const og = (prop) => {
            const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
            const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
            const m = html.match(re1) || html.match(re2);
            return m ? m[1] : '';
        };
        const ent = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'");
        const title = og('og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '');
        const description = og('og:description') || og('description');
        let image = og('og:image') || og('og:image:url');
        if (image) { try { image = new URL(image, rawUrl).href; } catch { image = ''; } }
        const siteName = og('og:site_name') || u.hostname;

        if (title || description || image) {
            result = {
                ok: true,
                title: ent(title).trim().slice(0, 200),
                description: ent(description).trim().slice(0, 300),
                image: image.slice(0, 600),
                siteName: ent(siteName).trim().slice(0, 100),
                url: rawUrl,
            };
        }
    } catch { result = { ok: false }; }

    linkPreviewCache.set(rawUrl, { exp: Date.now() + LINK_PREVIEW_TTL, data: result });
    return result;
}

// ── Changelog — parses CLAUDE.md Recent Changes table ────────────────────────
let changelogCache = null;

function parseChangelog() {
    if (changelogCache) return changelogCache;
    try {
        const md = fs.readFileSync('./CLAUDE.md', 'utf8');
        const lines = md.split('\n');
        let inSection = false;
        const tableLines = [];
        for (const line of lines) {
            if (line.startsWith('## 1. Recent Changes')) { inSection = true; continue; }
            if (inSection && line.startsWith('## ')) break;
            if (inSection && line.startsWith('|')) tableLines.push(line);
        }
        const dataRows = tableLines.filter(l => !l.includes('Date') && !l.includes('---'));
        changelogCache = dataRows.slice(0, 3).map(row => {
            const cells = row.split('|').map(c => c.trim()).filter(Boolean);
            const date  = cells[0] || '';
            const raw   = cells[1] || '';
            const titleMatch = raw.match(/\*\*([^*]+)\*\*/);
            const title = titleMatch ? titleMatch[1] : raw.slice(0, 60);
            const plain = raw.replace(/\*\*[^*]+\*\*:?\s*/g, '').replace(/`[^`]*`/g, '').trim();
            const summary = plain.length > 150 ? plain.slice(0, 147) + '…' : plain;
            return { date, title, summary };
        });
    } catch (e) {
        serverLog('SYSTEM', 'CHANGELOG_PARSE_ERROR', e.message);
        changelogCache = [];
    }
    return changelogCache;
}

// ===== HTTP =====
const httpServer = http.createServer(async (req, res) => {

    // ── Auth routes ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/auth/register') {
        const body = await parseBody(req);
        const { full_name, nick_name, password, profile_picture, secret_phrase, invite_code, website } = body;
        // Honeypot: `website` is a hidden field real users never see. Bots that auto-fill every
        // input trip it — reject with a generic message so the trap isn't revealed.
        if (website) {
            serverLog(full_name || 'unknown', 'REGISTER_BOT', 'honeypot filled');
            return sendJSON(res, 400, { ok: false, error: 'Registration failed. Try again.' });
        }
        // profile_picture is optional — registerWithInvite()/createUser() default it to 🎭 when empty.
        if (!full_name?.trim() || !nick_name?.trim() || !password || !secret_phrase) {
            return sendJSON(res, 400, { ok: false, error: 'Name, display name, password and secret phrase are required.' });
        }
        if (password.length < 8) {
            return sendJSON(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
        }
        if (!invite_code?.trim()) {
            return sendJSON(res, 400, { ok: false, error: 'An invite code is required to register.' });
        }
        const result = registerWithInvite({ full_name, nick_name, password, profile_picture, secret_phrase, invite_code: invite_code.trim() });
        if (!result.ok) {
            if (result.error === 'INVALID_CODE') {
                serverLog(full_name, 'REGISTER_REJECT', 'bad invite code');
                return sendJSON(res, 403, { ok: false, error: 'That invite code is invalid or has already been used.' });
            }
            serverLog(full_name, 'REGISTER_FAIL', result.error);
            return sendJSON(res, 500, { ok: false, error: 'Registration failed. Try again.' });
        }
        serverLog(full_name, 'REGISTER_OK', `nick=${nick_name}`);
        return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/auth/login') {
        const body = await parseBody(req);
        const { full_name, password } = body;
        // Real client IP — Cloudflare sets cf-connecting-ip; the tunnel hides the socket address.
        const ip = req.headers['cf-connecting-ip']
            || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket.remoteAddress || '';
        if (!full_name?.trim() || !password) {
            recordLoginAttempt(full_name, ip, false, 'missing_fields');
            return sendJSON(res, 400, { ok: false, error: 'Name and password are required.' });
        }
        const thr = checkLoginThrottle(full_name, ip);
        if (!thr.allowed) {
            serverLog(full_name, 'LOGIN_THROTTLED', `ip=${ip}`);
            return sendJSON(res, 429, { ok: false, error: 'Too many attempts — try again later.', retryAfterMs: thr.retryAfterMs });
        }
        const result = loginUser(full_name, password);
        if (!result.ok) {
            recordLoginAttempt(full_name, ip, false, result.reason);
            serverLog(full_name, 'LOGIN_FAIL', result.reason);
            return sendJSON(res, 401, { ok: false });
        }
        const { id, nick_name, profile_picture, is_admin } = result.user;
        const token = issueJoinToken(nick_name, profile_picture, id, is_admin);
        recordLoginAttempt(full_name, ip, true, 'ok');
        serverLog(full_name, 'LOGIN_OK', `nick=${nick_name} admin=${is_admin}`);
        return sendJSON(res, 200, { ok: true, token, nick_name, profile_picture, is_admin });
    }

    if (req.method === 'POST' && req.url === '/api/auth/forgot') {
        const body = await parseBody(req);
        const { full_name, secret_phrase } = body;
        const ip = req.headers['cf-connecting-ip']
            || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
            || req.socket.remoteAddress || '';
        if (!full_name?.trim() || !secret_phrase) {
            return sendJSON(res, 400, { ok: false });
        }
        const thr = checkLoginThrottle(full_name, ip);
        if (!thr.allowed) {
            serverLog(full_name, 'FORGOT_THROTTLED', `ip=${ip}`);
            return sendJSON(res, 429, { ok: false, error: 'Too many attempts — try again later.', retryAfterMs: thr.retryAfterMs });
        }
        const result = verifySecretPhrase(full_name, secret_phrase);
        if (!result.ok) {
            recordLoginAttempt(full_name, ip, false, 'forgot_fail');
            serverLog(full_name, 'FORGOT_FAIL', 'bad secret phrase');
            return sendJSON(res, 401, { ok: false });
        }
        const reset_token = issueResetToken(result.user_id);
        serverLog(full_name, 'FORGOT_OK', 'reset token issued');
        return sendJSON(res, 200, { ok: true, reset_token });
    }

    if (req.method === 'POST' && req.url === '/api/auth/reset') {
        const body = await parseBody(req);
        const { reset_token, new_password, new_secret_phrase } = body;
        if (!reset_token || !new_password || !new_secret_phrase?.trim()) {
            return sendJSON(res, 400, { ok: false, error: 'Missing fields.' });
        }
        if (new_password.length < 8) {
            return sendJSON(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
        }
        const entry = pendingResetTokens.get(reset_token);
        if (!entry || Date.now() > entry.expires) {
            pendingResetTokens.delete(reset_token);
            return sendJSON(res, 401, { ok: false, error: 'Reset session expired. Try again.' });
        }
        pendingResetTokens.delete(reset_token);
        updatePassword(entry.user_id, new_password, new_secret_phrase.trim());
        deleteSessionsByUser(entry.user_id);   // kill old 2-h tokens on recovery
        serverLog('SYSTEM', 'PASSWORD_RESET', `user_id=${entry.user_id}`);
        return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/api/auth/logout') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (token) deleteSession(token);
        return sendJSON(res, 200, { ok: true });
    }

    // ── Admin API ────────────────────────────────────────────────────────────
    if (req.url.startsWith('/api/admin/')) {
        if (!requireAdmin(req)) return sendJSON(res, 403, { ok: false, error: 'Forbidden' });

        const parts = req.url.split('?')[0].split('/').filter(Boolean);
        // parts: ['api', 'admin', 'tables', <name?>, <id?>]

        if (parts[2] === 'tables' && req.method === 'GET' && !parts[3]) {
            return sendJSON(res, 200, { ok: true, tables: listTables() });
        }

        if (parts[2] === 'tables' && parts[3] && req.method === 'GET' && !parts[4]) {
            try {
                const records = getTableRecords(decodeURIComponent(parts[3]));
                return sendJSON(res, 200, { ok: true, records });
            } catch (e) {
                return sendJSON(res, 400, { ok: false, error: e.message });
            }
        }

        if (parts[2] === 'tables' && parts[3] && parts[4] && req.method === 'PUT') {
            const body = await parseBody(req);
            try {
                const result = updateRecord(decodeURIComponent(parts[3]), decodeURIComponent(parts[4]), body);
                return sendJSON(res, result.ok ? 200 : 400, result);
            } catch (e) {
                return sendJSON(res, 400, { ok: false, error: e.message });
            }
        }

        if (parts[2] === 'tables' && parts[3] && parts[4] && req.method === 'DELETE') {
            try {
                const result = deleteRecord(decodeURIComponent(parts[3]), decodeURIComponent(parts[4]));
                return sendJSON(res, 200, result);
            } catch (e) {
                return sendJSON(res, 400, { ok: false, error: e.message });
            }
        }

        if (parts[2] === 'users' && req.method === 'GET') {
            return sendJSON(res, 200, listAllUsers());
        }

        // Admin sets any user's password to a value they choose. Invalidates the user's active
        // sessions so they must log in again. Leaves the secret phrase untouched.
        if (parts[2] === 'reset-password' && req.method === 'POST') {
            const admin = requireAdmin(req);
            const { user_id, new_password } = await parseBody(req);
            if (!user_id || !getUserById(user_id)) {
                return sendJSON(res, 404, { ok: false, error: 'User not found.' });
            }
            if (!new_password || String(new_password).length < 8) {
                return sendJSON(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });
            }
            updatePassword(user_id, new_password);
            deleteSessionsByUser(user_id);
            serverLog(admin?.nick_name || 'ADMIN', 'ADMIN_PASSWORD_RESET', `target=${user_id}`);
            return sendJSON(res, 200, { ok: true });
        }

        if (parts[2] === 'sounds' && parts[3] === 'list' && req.method === 'GET') {
            const soundsDir = path.join(process.cwd(), 'public', 'assets', 'sounds');
            const configDir = path.join(soundsDir, 'configurations');
            const standard = fs.readdirSync(soundsDir).filter(f => f.endsWith('.ogg'));
            const configurations = fs.existsSync(configDir)
                ? fs.readdirSync(configDir).filter(f => f.endsWith('.ogg'))
                : [];
            return sendJSON(res, 200, { standard, configurations });
        }

        if (parts[2] === 'sounds' && parts[3] === 'config' && req.method === 'GET') {
            const user_id = new URL(req.url, 'http://x').searchParams.get('user_id');
            if (!user_id) return sendJSON(res, 400, { ok: false, error: 'Missing user_id' });
            return sendJSON(res, 200, getUserSoundConfig(user_id));
        }

        if (parts[2] === 'sounds' && parts[3] === 'config' && req.method === 'POST') {
            const body = await parseBody(req);
            const { user_id, join_sounds, leave_sounds } = body;
            if (!user_id || !Array.isArray(join_sounds) || !Array.isArray(leave_sounds)) {
                return sendJSON(res, 400, { ok: false, error: 'Invalid payload' });
            }
            return sendJSON(res, 200, setUserSoundConfig(user_id, join_sounds, leave_sounds));
        }

        // Birthday event target — get/set the user the birthday_event_listener fires for
        if (parts[2] === 'birthday-user' && req.method === 'GET') {
            const cfg = getSetting('birthday_user');
            return sendJSON(res, 200, { ok: true, user_id: cfg?.user_id || null });
        }

        if (parts[2] === 'birthday-user' && req.method === 'POST') {
            const body = await parseBody(req);
            const user_id = body.user_id || null;
            if (user_id && !getUserById(user_id)) {
                return sendJSON(res, 400, { ok: false, error: 'Unknown user.' });
            }
            setSetting('birthday_user', { user_id });
            serverLog('SYSTEM', 'BIRTHDAY_USER_SET', user_id || '(cleared)');
            return sendJSON(res, 200, { ok: true, user_id });
        }

        return sendJSON(res, 404, { ok: false, error: 'Unknown admin route' });
    }

    // ── Message history (paginated: latest `limit`, older than `before` rowid) ─
    if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (!token || !validateJoinToken(token)) return sendJSON(res, 401, { ok: false });
        const u = new URL(req.url, 'http://x');
        const channelId = decodeURIComponent(u.pathname.split('/')[3] || '');
        // Private channels are ephemeral — they have no persisted history.
        if (isPrivateChannel(channelId)) return sendJSON(res, 200, { ok: true, messages: [] });
        const limit  = u.searchParams.get('limit');
        const before = u.searchParams.get('before');
        return sendJSON(res, 200, { ok: true, messages: getChannelMessages(channelId, { limit, before }) });
    }

    // ── Image upload (streamed to disk; only the URL is stored as message text) ─
    if (req.method === 'POST' && req.url === '/api/upload') {
        const auth    = req.headers['authorization'] || '';
        const token   = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false, error: 'Not logged in.' });
        const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[ctype];
        if (!ext) return sendJSON(res, 415, { ok: false, error: 'Only PNG, JPEG, GIF or WebP images are allowed.' });
        const MAX_UPLOAD = 250 * 1024 * 1024;
        if (Number(req.headers['content-length']) > MAX_UPLOAD)
            return sendJSON(res, 413, { ok: false, error: 'Image too large (max 250 MB).' });

        const filename = `${randomUUID()}.${ext}`;
        const dest = path.join(uploadsDir, filename);
        const out = fs.createWriteStream(dest);
        let failed = false;
        const fail = (code, errMsg) => {
            if (failed) return;
            failed = true;
            out.destroy();
            fs.promises.unlink(dest).catch(() => {});
            if (!res.headersSent) sendJSON(res, code, { ok: false, error: errMsg });
        };
        let received = 0;
        req.on('data', c => { received += c.length; if (received > MAX_UPLOAD) fail(413, 'Image too large (max 250 MB).'); });
        req.on('error', () => fail(400, 'Upload interrupted.'));
        out.on('error', () => fail(500, 'Could not save image.'));
        out.on('finish', () => {
            if (failed) return;
            serverLog(session.nick_name || 'user', 'IMAGE_UPLOAD', filename);
            sendJSON(res, 200, { ok: true, url: `/uploads/${filename}` });
        });
        req.pipe(out);
        return;
    }

    // ── Link preview (Open Graph; cached in memory, never persisted) ───────────
    if (req.url.startsWith('/api/link-preview') && req.method === 'GET') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (!token || !validateJoinToken(token)) return sendJSON(res, 401, { ok: false });
        const target = new URL(req.url, 'http://x').searchParams.get('url') || '';
        return sendJSON(res, 200, await getLinkPreview(target));
    }

    // ── Profile (self-service: nick / picture / password / sounds) ─────────────
    if (req.url === '/api/profile' && req.method === 'GET') {
        const auth = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false });
        const u = getUserById(session.user_id);
        if (!u) return sendJSON(res, 404, { ok: false });
        const cfg = getUserSoundConfig(session.user_id);
        const soundsDir = path.join(process.cwd(), 'public', 'assets', 'sounds');
        const configDir = path.join(soundsDir, 'configurations');
        const standard = fs.readdirSync(soundsDir).filter(f => f.endsWith('.ogg'));
        const configurations = fs.existsSync(configDir) ? fs.readdirSync(configDir).filter(f => f.endsWith('.ogg')) : [];
        return sendJSON(res, 200, {
            ok: true, nick_name: u.nick_name, profile_picture: u.profile_picture,
            join_sounds: cfg.join_sounds, leave_sounds: cfg.leave_sounds,
            sounds: { standard, configurations },
        });
    }

    if (req.url === '/api/profile' && req.method === 'POST') {
        const auth = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false, error: 'Not logged in.' });
        if (Number(req.headers['content-length']) > 1_000_000)
            return sendJSON(res, 413, { ok: false, error: 'Payload too large.' });

        const body = await parseBody(req);
        const uid = session.user_id;

        // nick + picture (modal pre-fills current values, so both are always present)
        const nick_name = String(body.nick_name || '').trim();
        if (nick_name.length < 2 || nick_name.length > 32)
            return sendJSON(res, 400, { ok: false, error: 'Display name must be 2–32 characters.' });
        const profile_picture = String(body.profile_picture || '🎭').slice(0, 300_000);
        updateUserProfile(uid, { nick_name, profile_picture });

        // optional password and/or secret-phrase change — both require the current password
        const new_secret_phrase = String(body.new_secret_phrase || '').trim();
        if (body.new_password || new_secret_phrase) {
            if (body.new_password && String(body.new_password).length < 8)
                return sendJSON(res, 400, { ok: false, error: 'New password must be at least 8 characters.' });
            if (!verifyUserPasswordById(uid, String(body.current_password || '')))
                return sendJSON(res, 403, { ok: false, error: 'Current password is incorrect.' });
            if (body.new_password) {
                // updatePassword writes both columns in one UPDATE when a secret phrase is supplied
                updatePassword(uid, String(body.new_password), new_secret_phrase || null);
            } else {
                updateSecretPhrase(uid, new_secret_phrase);
            }
        }

        // sounds — single value per slot, stored as 1-element arrays
        if (body.join_sound && body.leave_sound)
            setUserSoundConfig(uid, [String(body.join_sound)], [String(body.leave_sound)]);

        serverLog(session.nick_name, 'PROFILE_UPDATE', `nick=${nick_name}`);
        return sendJSON(res, 200, { ok: true });
    }

    // ── Bug report (browser console + server log → text file on the Pi) ────────
    if (req.method === 'POST' && req.url === '/api/bug-report') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false, error: 'Not logged in.' });
        if (Number(req.headers['content-length']) > 3_000_000)
            return sendJSON(res, 413, { ok: false, error: 'Report too large.' });

        // Full Name is the cooldown key — looked up from the account, not the session.
        const acct = getUserById(session.user_id);
        const full_name = acct?.full_name || session.nick_name;
        const cd = checkBugReportCooldown(full_name);   // hard 2-hour timer
        if (!cd.allowed) return sendJSON(res, 429, { ok: false, error: 'cooldown', retryAfterMs: cd.retryAfterMs });

        const body = await parseBody(req, 4_000_000);   // browser_log can be up to ~2 MB
        const browserLog = String(body.browser_log || '').slice(0, 2_000_000);

        // server.log tail (last ~256 KB) — named serverLogTail to avoid clashing with serverLog()
        let serverLogTail = '';
        try {
            serverLogTail = await fs.promises.readFile(path.join(logsDir, 'server.log'), 'utf8');
        } catch (e) { serverLogTail = `(could not read server log: ${e.message})`; }
        const MAXSRV = 262_144;
        if (serverLogTail.length > MAXSRV) serverLogTail = `(…truncated, last 256KB)\n` + serverLogTail.slice(-MAXSRV);

        const ts   = new Date().toISOString();
        const safe = (session.nick_name || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
        const filename = `bug_${ts.slice(0, 19).replace(/[:T]/g, '-')}_${safe}.txt`;
        const sep = '='.repeat(64);
        const content = [
            sep, 'WEAVE BUG REPORT', `Generated : ${ts}`,
            `Full Name : ${full_name}`, `Nick Name : ${session.nick_name}`, `User ID   : ${session.user_id}`, sep, '',
            sep, 'BROWSER CONSOLE LOG', sep, browserLog    || '(empty)', '',
            sep, 'SERVER LOG (tail)',  sep, serverLogTail || '(empty)', '',
            sep, 'END OF REPORT', sep,
        ].join('\n');

        try {
            await fs.promises.writeFile(path.join(bugReportsDir, filename), content, 'utf8');
        } catch (e) {
            serverLog(full_name, 'BUG_REPORT_FAIL', e.message);
            return sendJSON(res, 500, { ok: false, error: 'Could not save report.' });
        }
        const r = saveBugReport({ full_name, nick_name: session.nick_name, user_id: session.user_id, session_token: null,
            filename, browser_bytes: browserLog.length, server_bytes: serverLogTail.length });
        if (!r.ok) return sendJSON(res, 500, { ok: false, error: 'Could not record report.' });
        serverLog(full_name, 'BUG_REPORT', filename);
        return sendJSON(res, 200, { ok: true, filename });
    }

    // ── Invite codes (logged-in members mint one-time registration codes) ──────
    if (req.method === 'POST' && req.url === '/api/invite/generate') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false, error: 'Not logged in.' });
        const result = createInviteCode(session.user_id, session.nick_name);
        if (!result.ok) {
            serverLog(session.nick_name, 'INVITE_FAIL', result.error);
            return sendJSON(res, 500, { ok: false, error: 'Could not generate an invite code.' });
        }
        serverLog(session.nick_name, 'INVITE_CODE', result.code);
        return sendJSON(res, 200, { ok: true, code: result.code });
    }

    // ── Private channels (create / add member) ─────────────────────────────────
    if (req.url === '/api/channels/create' && req.method === 'POST') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false, error: 'Not logged in.' });

        const body = await parseBody(req);
        const name = String(body.name || '').trim();
        if (name.length < 1 || name.length > 40)
            return sendJSON(res, 400, { ok: false, error: 'Channel name must be 1–40 characters.' });

        // Resolve the requested allow-list to real accounts (drop unknown ids), cap the size.
        const requested = Array.isArray(body.allowed_user_ids) ? body.allowed_user_ids : [];
        const allowedUserIds = [...new Set(requested.map(String))]
            .filter(id => getUserById(id))
            .slice(0, 100);

        const rec = createPrivateChannel({ name, creatorId: session.user_id, allowedUserIds });

        // Notify the creator, every online admin, and every online allow-listed member so the
        // channel appears for them immediately. pushVisibleChannels no-ops for offline users.
        const notify = new Set([session.user_id, ...rec.allowedUserIds]);
        for (const [, p] of peers) if (p.is_admin) notify.add(p.user_id);
        for (const uid of notify) pushVisibleChannels(uid);

        serverLog(session.nick_name, 'PRIV_CHANNEL_CREATE', `${rec.id} "${name}" allow=${rec.allowedUserIds.size}`);
        return sendJSON(res, 200, { ok: true, channelId: rec.id, label: rec.name });
    }

    if (req.url === '/api/channels/add-member' && req.method === 'POST') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false, error: 'Not logged in.' });

        const body = await parseBody(req);
        const channelId = String(body.channelId || '');
        const targetId  = String(body.user_id || '');
        const rec = privateChannels.get(channelId);
        if (!rec || !isPrivateChannel(channelId))
            return sendJSON(res, 404, { ok: false, error: 'Channel not found.' });
        if (!(session.user_id === rec.creatorId || session.is_admin))
            return sendJSON(res, 403, { ok: false, error: 'Only the channel creator or an admin can add members.' });
        if (!getUserById(targetId))
            return sendJSON(res, 400, { ok: false, error: 'User not found.' });

        rec.allowedUserIds.add(targetId);
        pushVisibleChannels(targetId);   // appears live for the newly-added user, no reload
        serverLog(session.nick_name, 'PRIV_CHANNEL_ADD', `${channelId} += ${targetId}`);
        return sendJSON(res, 200, { ok: true });
    }

    // ── API ──────────────────────────────────────────────────────────────────
    if (req.url === '/api/users') {
        const users = [...peers.values()].map(p => ({ username: p.username, profile_picture: p.profile_picture }));
        return sendJSON(res, 200, { users });
    }

    // All registered users, for the private-channel allow-list picker. full_name is stripped so
    // real names never reach the client; the opaque id is the picker's selection value.
    if (req.url === '/api/users/all' && req.method === 'GET') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        const session = token ? validateJoinToken(token) : null;
        if (!session) return sendJSON(res, 401, { ok: false });
        const users = listAllUsers()
            .filter(u => u.id !== session.user_id)   // caller is auto-added on create
            .map(u => ({ id: u.id, nick_name: u.nick_name, profile_picture: u.profile_picture }));
        return sendJSON(res, 200, { ok: true, users });
    }

    if (req.url === '/api/changelog' && req.method === 'GET') {
        const auth  = req.headers['authorization'] || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (!token || !validateJoinToken(token)) return sendJSON(res, 401, { ok: false });
        return sendJSON(res, 200, { version: SERVER_BOOT_ID, entries: parseChangelog() });
    }

    // ── Static files ─────────────────────────────────────────────────────────
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.txt': 'text/plain' };

    // User-uploaded images live on the persisted ./data mount, not inside the image.
    if (urlPath.startsWith('/uploads/')) {
        const upPath = path.join(uploadsDir, path.basename(urlPath));   // basename strips traversal
        const upExt  = path.extname(upPath).toLowerCase();
        return fs.readFile(upPath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, {
                'Content-Type': types[upExt] || 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'public, max-age=31536000, immutable',
            });
            res.end(data);
        });
    }

    const publicRoot = path.resolve(process.cwd(), 'public');
    const filePath = path.resolve(publicRoot, '.' + (urlPath === '/' ? '/index.html' : urlPath));
    // Containment guard: never serve anything outside public/ (blocks ../ traversal to the DB, source, etc.)
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const headers = {
            'Content-Type': types[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'DENY',
        };
        if (ext === '.html') {
            headers['Content-Security-Policy'] =
                "default-src 'self'; " +
                "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                "font-src 'self' https://fonts.gstatic.com; " +
                "img-src 'self' data: blob: https:; " +
                "media-src 'self' blob: data:; " +
                "connect-src 'self' ws: wss: https:; " +
                "frame-ancestors 'none'";
        }
        res.writeHead(200, headers);
        res.end(data);
    });
});

// ===== WEBSOCKET =====
const wss = new WebSocketServer({ server: httpServer, clientTracking: true });

// Keep Cloudflare tunnel alive (drops idle WS after ~60s)
const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
wss.on('close', () => clearInterval(pingInterval));

function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const ip = req.socket.remoteAddress || 'unknown';
    serverLog('SYSTEM', 'WS_OPEN', `ip=${ip}`);

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const peer = peers.get(ws);

        switch (msg.type) {

            // ── JOIN ──────────────────────────────────────────────────
            case 'join': {
                const tokenEntry = validateJoinToken(msg.token);
                if (!tokenEntry) {
                    send(ws, { type: 'join_rejected', reason: 'Session expired — please log in again.' });
                    return;
                }

                const username = tokenEntry.nick_name;
                const profile_picture = tokenEntry.profile_picture;
                const user_id = tokenEntry.user_id;

                if ([...peers.values()].some(p => p.username === username)) {
                    send(ws, { type: 'join_rejected', reason: 'Your display name is already in the room — try joining with a different nick name.' });
                    return;
                }

                // Token consumed on first use; keep it valid for reconnects within 2h window
                // Validate the requested landing channel. For a private channel the user must be
                // allow-listed (or admin); a forged/stale private id silently falls back to lobby
                // (the channel may have self-destructed while the socket was down).
                let landingWant = (typeof msg.channelId === 'string' && msg.channelId) ? msg.channelId : 'lobby';
                if (isPrivateChannel(landingWant)) {
                    const r = privateChannels.get(landingWant);
                    if (!(r && (r.allowedUserIds.has(user_id) || tokenEntry.is_admin))) landingWant = 'lobby';
                }

                peers.set(ws, {
                    username,
                    profile_picture,
                    user_id,
                    is_admin: tokenEntry.is_admin,
                    joinedAt: Date.now(),
                    muted: false,
                    sendTransport: null,
                    recvTransport: null,
                    producers: new Map(),
                    consumers: new Map(),
                    mapPos: { x: 1000, y: 960, channelId: landingWant },
                });

                serverLog(username, 'JOIN_ATTEMPT', `auth=token`);

                // Client picks the landing channel; '__limbo__' (no real channel) = silent landing.
                const selfPeer = peers.get(ws);
                const joiningChannel = selfPeer.mapPos.channelId;
                const existingProducers = [];
                for (const [, other] of peers) {
                    if (other.username === username) continue;
                    if ((other.mapPos?.channelId || 'lobby') !== joiningChannel) continue;
                    for (const [kind, producer] of other.producers) {
                        existingProducers.push({ producerId: producer.id, username: other.username, kind, channelId: joiningChannel, appData: producer.appData || {} });
                    }
                }

                send(ws, {
                    type: 'join_ack',
                    users: [...peers.values()].map(p => ({ username: p.username, profile_picture: p.profile_picture, muted: p.muted })),
                    routerRtpCapabilities: router.rtpCapabilities,
                    existingProducers,
                    mapPositions: [...peers.values()].map(p => ({ username: p.username, x: p.mapPos.x, y: p.mapPos.y, channelId: channelIdFor(selfPeer, p.mapPos.channelId) })),
                    privateChannels: visiblePrivateChannelsFor(user_id, tokenEntry.is_admin),
                });

                serverLog(username, 'JOIN_SUCCESS', `room: ${formatRoom()}`);

                for (const [cws] of peers) {
                    if (cws !== ws) send(cws, { type: 'user_joined', username, profile_picture, muted: false });
                }

                // Dispatch persona join sound to all other peers
                const joinCfg = getUserSoundConfig(user_id);
                const joinSounds = joinCfg?.join_sounds?.length ? joinCfg.join_sounds : ['join_channel.ogg'];
                const joinSound = joinSounds[Math.floor(Math.random() * joinSounds.length)];
                for (const [cws] of peers) {
                    if (cws !== ws) send(cws, { type: 'persona_sound', sound: joinSound });
                }

                // Fire the configured event when the targeted user joins — once per
                // login session (token), so reconnects within the session don't replay it.
                const bday = getSetting('birthday_user');
                if (bday?.user_id && bday.user_id === user_id && !birthdayFiredSessions.has(msg.token)) {
                    birthdayFiredSessions.add(msg.token);
                    eventListener(bday.user_id, 'birthdayEvent');
                }
                break;
            }

            // ── CREATE TRANSPORT ──────────────────────────────────────
            case 'createTransport': {
                if (!peer) return;
                const { direction } = msg;

                const transport = await router.createWebRtcTransport({
                    listenIps: WEBRTC_LISTEN_IPS,
                    enableUdp: true,
                    enableTcp: true,
                    preferUdp: true,
                    initialAvailableOutgoingBitrate: 800000,
                });

                transport.on('dtlsstatechange', state => { if (state === 'closed') transport.close(); });

                if (direction === 'send') peer.sendTransport = transport;
                else peer.recvTransport = transport;

                serverLog(peer.username, 'TRANSPORT_CREATED', direction);

                send(ws, {
                    type: 'transportCreated',
                    direction,
                    params: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    },
                });
                break;
            }

            // ── CONNECT TRANSPORT ─────────────────────────────────────
            case 'connectTransport': {
                if (!peer) return;
                const transport = msg.direction === 'send' ? peer.sendTransport : peer.recvTransport;
                if (!transport) return;
                await transport.connect({ dtlsParameters: msg.dtlsParameters });
                serverLog(peer.username, 'TRANSPORT_CONNECTED', msg.direction);
                send(ws, { type: 'transportConnected', direction: msg.direction });
                break;
            }

            // ── PRODUCE ───────────────────────────────────────────────
            case 'produce': {
                if (!peer?.sendTransport) return;
                const { kind, rtpParameters, appData } = msg;

                const producer = await peer.sendTransport.produce({ kind, rtpParameters, appData: appData || {} });

                const slotKey = appData?.type === 'screen-audio' ? 'screen-audio' : kind;
                peer.producers.set(slotKey, producer);
                producer.on('transportclose', () => peer.producers.delete(slotKey));

                serverLog(peer.username, 'PRODUCED', `kind=${kind} slot=${slotKey} id=${producer.id}`);
                send(ws, { type: 'produced', id: producer.id, kind });

                const producerChannel = peer.mapPos?.channelId || 'lobby';
                for (const [cws, cpeer] of peers) {
                    if (cws === ws) continue;
                    if ((cpeer.mapPos?.channelId || 'lobby') === producerChannel) {
                        send(cws, { type: 'newProducer', producerId: producer.id, username: peer.username, kind, channelId: producerChannel, appData: appData || {} });
                    }
                }
                break;
            }

            // ── CONSUME ───────────────────────────────────────────────
            case 'consume': {
                if (!peer?.recvTransport) return;
                const { producerId, rtpCapabilities } = msg;

                let producerPeer = null;
                for (const [, p] of peers) {
                    if ([...p.producers.values()].some(pr => pr.id === producerId)) { producerPeer = p; break; }
                }
                if (producerPeer) {
                    const producerChannel = producerPeer.mapPos?.channelId || 'lobby';
                    const consumerChannel = peer.mapPos?.channelId || 'lobby';
                    if (producerChannel !== consumerChannel) return;
                }

                if (!router.canConsume({ producerId, rtpCapabilities })) {
                    serverLog(peer.username, 'CONSUME_REJECTED', producerId);
                    return;
                }

                const consumer = await peer.recvTransport.consume({ producerId, rtpCapabilities, paused: false });
                peer.consumers.set(producerId, consumer);

                consumer.on('transportclose', () => peer.consumers.delete(producerId));
                consumer.on('producerclose', () => {
                    peer.consumers.delete(producerId);
                    send(ws, { type: 'producerClosed', producerId });
                });

                serverLog(peer.username, 'CONSUMED', `producer=${producerId}`);
                send(ws, {
                    type: 'consumed',
                    producerId,
                    id: consumer.id,
                    kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters,
                });
                break;
            }

            // ── RESUME CONSUMER ───────────────────────────────────────
            case 'resumeConsumer': {
                if (!peer) return;
                const consumer = peer.consumers.get(msg.producerId);
                if (consumer && !consumer.closed) await consumer.resume();
                break;
            }

            // ── MAP POSITION ──────────────────────────────────────────
            case 'move': {
                if (!peer) return;
                const oldChannel = peer.mapPos?.channelId || 'lobby';
                const newChannel = msg.channelId || 'lobby';

                // Gate entry to private channels — must be allow-listed or admin. Reject without
                // touching mapPos so a forged id never routes audio/text into a channel.
                if (isPrivateChannel(newChannel)) {
                    const r = privateChannels.get(newChannel);
                    if (!(r && (r.allowedUserIds.has(peer.user_id) || peer.is_admin))) {
                        send(ws, { type: 'move_rejected', channelId: newChannel, reason: 'You no longer have access to that channel.' });
                        return;
                    }
                }

                peer.mapPos = { x: msg.x ?? 1000, y: msg.y ?? 960, channelId: newChannel };

                for (const [cws, cpeer] of peers) {
                    if (cws === ws) continue;
                    // Mask private channel ids for viewers who can't see them (privacy over the wire).
                    send(cws, { type: 'peer_moved', username: peer.username, x: peer.mapPos.x, y: peer.mapPos.y, channelId: channelIdFor(cpeer, newChannel) });
                }

                if (oldChannel !== newChannel) {
                    for (const [cws, cpeer] of peers) {
                        if (cws === ws) continue;
                        if ((cpeer.mapPos?.channelId || 'lobby') !== newChannel) {
                            for (const [, prod] of peer.producers) {
                                send(cws, { type: 'producerUnavailable', producerId: prod.id, username: peer.username });
                            }
                        }
                    }

                    for (const [cws, cpeer] of peers) {
                        if (cws === ws) continue;
                        if ((cpeer.mapPos?.channelId || 'lobby') === newChannel) {
                            for (const [kind, prod] of peer.producers) {
                                send(cws, { type: 'newProducer', producerId: prod.id, username: peer.username, kind, channelId: newChannel, appData: prod.appData || {} });
                            }
                        }
                    }

                    const channelProducers = [];
                    for (const [, cpeer] of peers) {
                        if (cpeer.username === peer.username) continue;
                        if ((cpeer.mapPos?.channelId || 'lobby') !== newChannel) continue;
                        for (const [kind, prod] of cpeer.producers) {
                            channelProducers.push({ producerId: prod.id, username: cpeer.username, kind, channelId: newChannel, appData: prod.appData || {} });
                        }
                    }
                    send(ws, { type: 'channelProducers', producers: channelProducers, channelId: newChannel });
                }

                // Private-channel lifecycle: the moving peer now occupies newChannel; if they left
                // a private channel empty, reap it.
                if (isPrivateChannel(newChannel)) markOccupied(newChannel);
                if (oldChannel !== newChannel && isPrivateChannel(oldChannel)) destroyIfEmpty(oldChannel);
                break;
            }

            // ── CLOSE PRODUCER ────────────────────────────────────────
            case 'closeProducer': {
                if (!peer) return;
                const producer = peer.producers.get(msg.kind);
                if (producer && !producer.closed) {
                    producer.close();
                    peer.producers.delete(msg.kind);
                    serverLog(peer.username, 'PRODUCER_CLOSED', msg.kind);
                }
                break;
            }

            // ── MUTE STATE ───────────────────────────────────────────
            case 'mute_changed': {
                if (!peer) return;
                peer.muted = !!msg.muted;
                serverLog(peer.username, 'MUTE_CHANGED', peer.muted ? 'MUTED' : 'UNMUTED');
                for (const [cws] of peers) {
                    if (cws !== ws) send(cws, { type: 'user_muted_changed', username: peer.username, muted: peer.muted });
                }
                break;
            }

            // ── TEXT CHAT ─────────────────────────────────────────────
            case 'text_message': {
                if (!peer) break;
                const text = String(msg.text ?? '').trim().slice(0, 2000);
                if (!text) break;
                const senderChannel = peer.mapPos?.channelId || 'lobby';
                // Private channels are ephemeral — never persist their messages; just mint a
                // transient id for the live broadcast. Permanent channels keep their DB history.
                const msgId = isPrivateChannel(senderChannel)
                    ? randomUUID()
                    : saveMessage({
                        channel_id:      senderChannel,
                        user_id:         peer.user_id,
                        nick_name:       peer.username,
                        profile_picture: peer.profile_picture || '🎭',
                        content:         text,
                    }).id;
                const outObj = {
                    type:     'text_message',
                    id:       msgId,
                    username: peer.username,
                    text,
                    channelId: senderChannel,
                    ts: Date.now(),
                };
                for (const [cws, cp] of peers) {
                    if ((cp.mapPos?.channelId || 'lobby') === senderChannel) send(cws, outObj);
                }
                break;
            }

        }
    });

    ws.on('close', (code) => {
        const peer = peers.get(ws);
        if (peer) {
            const { username, joinedAt, user_id } = peer;
            const lastChannel = peer.mapPos?.channelId;   // capture before delete for self-destruct
            const secs = Math.round((Date.now() - joinedAt) / 1000);
            if (peer.sendTransport && !peer.sendTransport.closed) peer.sendTransport.close();
            if (peer.recvTransport && !peer.recvTransport.closed) peer.recvTransport.close();
            peers.delete(ws);
            serverLog(username, 'DISCONNECT', `code=${code} dur=${secs}s room=${formatRoom()}`);
            for (const [cws] of peers) send(cws, { type: 'user_left', username });

            // If this peer was the last occupant of a private channel, reap it.
            if (isPrivateChannel(lastChannel)) destroyIfEmpty(lastChannel);

            // Dispatch persona leave sound to remaining peers
            const leaveCfg = getUserSoundConfig(user_id);
            const leaveSounds = leaveCfg?.leave_sounds?.length ? leaveCfg.leave_sounds : ['leave_channel.ogg'];
            const leaveSound = leaveSounds[Math.floor(Math.random() * leaveSounds.length)];
            for (const [cws] of peers) send(cws, { type: 'persona_sound', sound: leaveSound });
        }
    });

    ws.on('error', err => serverLog('SYSTEM', 'WS_ERROR', err.message));
});

// ===== START =====
await startSFU();
httpServer.listen(PORT, () => {
    serverLog('SYSTEM', 'SERVER_START', `port=${PORT} SFU mode`);
    console.log(`\n🚀 Weave SFU server running on port ${PORT}`);
    console.log(`📡 Announced IP: ${ANNOUNCED_IP}`);
    console.log(`🔌 RTC ports: ${RTC_MIN_PORT}-${RTC_MAX_PORT}\n`);
});

// ===== MESSAGE RETENTION (prune messages + orphaned uploads after 7 days) =====
function runPrune() {
    try {
        const { deleted, orphanUrls } = pruneOldMessages(7);
        let unlinked = 0;
        for (const url of orphanUrls) {
            try { fs.unlinkSync(path.join(uploadsDir, path.basename(url))); unlinked++; }
            catch (e) { if (e.code !== 'ENOENT') serverLog('SYSTEM', 'PRUNE_UNLINK_FAIL', `${url}: ${e.message}`); }
        }
        if (deleted || unlinked) serverLog('SYSTEM', 'PRUNE', `messages=${deleted} files=${unlinked}`);
    } catch (e) {
        serverLog('SYSTEM', 'PRUNE_FAIL', e.message);
    }
}
runPrune();
setInterval(runPrune, 24 * 60 * 60 * 1000);
