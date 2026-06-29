// public/app.js — Weave SFU Client (mediasoup-client)
// =====================================================
// Need to clean up logging - too many UI updates 
// ===== LOGGING =====
function clientLog(action, details = '') {
    const ts = new Date().toISOString().slice(11, 23);
    if (typeof details === 'object') {
        console.log(`%c[WEAVE ${ts}] ${action.padEnd(35)}`, 'color:#00ffcc;font-weight:600', details);
    } else {
        console.log(`%c[WEAVE ${ts}] ${action.padEnd(35)} ${details}`, 'color:#00ffcc;font-weight:600');
    }
}
function clientError(action, err) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`%c[WEAVE ${ts}] ❌ ${action}`, 'color:#ff4444;font-weight:bold', err);
}
//   
// ===== LOG BUFFER =====
const logBuffer = [];

(function () {
    const _log   = console.log.bind(console);
    const _warn  = console.warn.bind(console);
    const _error = console.error.bind(console);

    function capture(level, args) {
        const ts = new Date().toISOString().slice(11, 23);
        const text = args.map(a => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.stack || String(a);
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        logBuffer.push(`[${ts}] [${level}] ${text}`);
    }

    console.log   = (...a) => { capture('LOG',   a); _log(...a);   };
    console.warn  = (...a) => { capture('WARN',  a); _warn(...a);  };
    console.error = (...a) => { capture('ERROR', a); _error(...a); };
})();

window.addEventListener('error', e =>
    logBuffer.push(`[${new Date().toISOString().slice(11,23)}] [UNCAUGHT_ERROR] ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', e =>
    logBuffer.push(`[${new Date().toISOString().slice(11,23)}] [UNHANDLED_REJECTION] ${String(e.reason)}`));

// ===== STATE =====
let ws = null;
let myUsername = null;
Object.defineProperty(window, 'ws',         { get: () => ws });
Object.defineProperty(window, 'myUsername', { get: () => myUsername });
let joinToken = null;
let currentResetToken = null;
let localStream = null;
let micErrorName = '';        // last getUserMedia failure name (e.g. 'NotReadableError') for accurate messaging
let micUnavailable = false;   // true when joined in listen-only mode because the mic couldn't start
// Browser mic processing. Echo-cancel + noise-suppression default OFF (opt-in). Auto-Gain Control
// defaults ON — it's the browser default and the thing that keeps a mic at an audible, consistent
// level; with it off, moderate mics transmit quiet (listeners hear you dampened). Persisted
// per-DEVICE in localStorage (mic/room is a property of the machine), so it survives logout.
function loadMicConstraints() {
    const defaults = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, deviceId: '' };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('weave.micConstraints') || '{}') }; }
    catch { return defaults; }
}
function saveMicConstraints() {
    localStorage.setItem('weave.micConstraints', JSON.stringify(micConstraints));
}
// One-time correction: Auto-Gain Control was the browser default at project start but got turned OFF
// in the "everything off" pass, which made mics transmit quiet. Flip stored autoGainControl back ON
// once for existing devices (echo/noise/device choices preserved). Idempotent — a later opt-out sticks.
(function migrateMicAgcV3() {
    try {
        if (localStorage.getItem('weave.micDefaults.v3')) return;
        const c = JSON.parse(localStorage.getItem('weave.micConstraints') || 'null');
        if (c && typeof c === 'object') {
            c.autoGainControl = true;
            localStorage.setItem('weave.micConstraints', JSON.stringify(c));
        }
        localStorage.setItem('weave.micDefaults.v3', '1');
    } catch {}
})();
let micConstraints = loadMicConstraints();
// Mic noise gate (input-sensitivity threshold) — per-DEVICE, persisted in localStorage.
const MIC_LEVEL_MAX = 0.35;          // RMS that maps to a full meter / threshold slider = 1.0
function loadMicGate() {
    const defaults = { enabled: false, threshold: 0.05, inputGain: 1 };   // gate OFF by default (opt-in); inputGain: mic level multiplier (1 = 100%)
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('weave.micGate') || '{}') }; }
    catch { return defaults; }
}
function saveMicGate() {
    localStorage.setItem('weave.micGate', JSON.stringify(micGate));
}

// "Static background" — per-DEVICE display preference (Display panel checkbox). When true, the
// in-room canvas animations (loom voice-strings + chat-background weave) are stopped and their
// canvases cleared, leaving a calm static backdrop. Saves CPU/battery on low-end devices.
function loadStaticBg() {
    try { return localStorage.getItem('weave.staticBg') === '1'; }
    catch { return false; }
}
function saveStaticBg() {
    try { localStorage.setItem('weave.staticBg', staticBg ? '1' : '0'); } catch {}
}
let staticBg = loadStaticBg();   // true = animations OFF

// "Auto-join the Lobby on login" — per-DEVICE preference (login-screen checkbox). When off, the
// user lands in LIMBO: a sentinel "no channel" that matches no real channel, so they neither hear
// nor are heard, and their mic isn't produced until they pick a channel from the sidebar.
const LIMBO = '__limbo__';
let landingChannel = 'lobby';
function loadAutoJoinLobby() {
    return localStorage.getItem('weave.autoJoinLobby') !== 'false';   // default: true
}
function saveAutoJoinLobby(on) {
    localStorage.setItem('weave.autoJoinLobby', on ? 'true' : 'false');
}
function applyMicSettingsUI() {
    const enableEl = document.getElementById('micGateToggle');
    const markerEl = document.getElementById('micMeterThreshold');
    if (enableEl) enableEl.checked = micGate.enabled;
    if (markerEl) markerEl.style.left = `${micGate.threshold * 100}%`;
    const inputEl = document.getElementById('micInputGainSlider');
    if (inputEl) inputEl.value = String(Math.round(micGate.inputGain * 100));
    const echoEl  = document.getElementById('micEchoToggle');
    const noiseEl = document.getElementById('micNoiseToggle');
    const agcEl   = document.getElementById('micAgcToggle');
    if (echoEl)  echoEl.checked  = micConstraints.echoCancellation;
    if (noiseEl) noiseEl.checked = micConstraints.noiseSuppression;
    if (agcEl)   agcEl.checked   = micConstraints.autoGainControl;
    populateMicDevices();
}
// Fill the input-device dropdown from enumerateDevices(). Labels are blank until mic permission
// is granted — a non-issue here since the mic is acquired at login before the panel can open.
async function populateMicDevices() {
    const sel = document.getElementById('micDeviceSelect');
    if (!sel) return;
    if (!navigator.mediaDevices?.enumerateDevices) { sel.disabled = true; return; }
    let devices;
    try { devices = await navigator.mediaDevices.enumerateDevices(); }
    catch { sel.disabled = true; return; }
    const mics = devices.filter(d => d.kind === 'audioinput');
    // Reflect the truly-active mic when no explicit preference is stored.
    const activeId = localStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId || '';
    const wanted = micConstraints.deviceId || activeId || '';
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default (system)';
    sel.appendChild(def);
    mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        sel.appendChild(opt);
    });
    // Only select a specific device if it's actually in the list; otherwise leave on "Default".
    sel.value = mics.some(d => d.deviceId === wanted) ? wanted : '';
}
// One-time correction: the noise gate originally shipped enabled-by-default, which users persisted
// to localStorage and which would otherwise override the new gate-off default below. Flip the stored
// gate OFF once for existing devices; preserve their threshold / input-gain. The flag makes it
// idempotent so a later deliberate re-enable sticks. (Browser-processing keys are left untouched.)
(function migrateMicDefaultsV2() {
    try {
        if (localStorage.getItem('weave.micDefaults.v2')) return;
        const g = JSON.parse(localStorage.getItem('weave.micGate') || 'null');
        if (g && typeof g === 'object') {
            g.enabled = false;
            localStorage.setItem('weave.micGate', JSON.stringify(g));
        }
        localStorage.setItem('weave.micDefaults.v2', '1');
    } catch {}
})();
let micGate = loadMicGate();         // { enabled, threshold } — threshold normalized 0..1
// Gate and AGC are mutually exclusive; if a saved state has both on, the gate wins (AGC off).
if (micGate.enabled && micConstraints.autoGainControl) {
    micConstraints.autoGainControl = false;
    saveMicConstraints();
}
let micGateGraph = null;             // Web Audio nodes once built
let micCtx = null;                   // ONE reused AudioContext for the mic (never leak a new one per rebuild)
let micLevel = 0;                    // latest input level 0..1 (for the meter)
let screenStream = null;
let webcamStream = null;
let isMuted = false;
let isScreenSharing = false;
let isWebcamOn = false;
let camFacingMode = 'user';   // 'user' (front) | 'environment' (back)
let joined = false;
let isAdminUser = false;
let adminPanelOpen = false;
let chatLastAuthor = null;
let chatLastTs = 0;
let chatLastDay = null;
// Text-chat pagination + media state
let chatChannelId    = null;   // channel currently shown in the text panel
let chatOldestRowid  = null;   // oldest message rowid shown (cursor for "show older")
let chatHasMore      = false;
let chatLoadingOlder = false;
const linkPreviewClientCache = new Map();  // url -> preview JSON (per session)
const CHAT_TOKEN_RE   = /(https?:\/\/[^\s<]+[^\s<.,;:!?)'"\]]|\/uploads\/[A-Za-z0-9._-]+)/gi;
const CHAT_IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)(\?[^\s]*)?$/i;
let adminCurrentTable = null;
let adminSelectedId = null;
let adminCheckedIds = new Set(); // ids of checkbox-selected rows
let adminEditMode = false;
let adminRecords = [];
let adminSchema = [];
let adminKeyBuf = [], adminKeyTimer = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let onlinePollTimer = null;
let bugReportSubmitted = false; // soft client lock; server enforces the 2h cooldown
const MAX_RECONNECT = 5;

// mediasoup-client objects
let device = null;
let sendTransport = null;
let recvTransport = null;
let audioProducer = null;
let videoProducer = null;
let screenAudioProducer = null;

// producerId → { consumer, username, kind }
const consumers = new Map();

// username → profile_picture (data URL or emoji, kept for legacy)
const userProfiles = new Map();

// UI state
let connectedUsers = [];
const voiceMeters = new Map();              // username → VoiceMeter (level/pluck); active channel only
// ── Loom (channel user-list voice strings) ──
let loomCanvasEl = null, loomRenderer = null;
let loomParticipants = [];                  // active-channel usernames, display order (top→bottom)
const ringEls = new Map();                  // username → avatar element, for onRing glow
let loomMode = localStorage.getItem('weave.loomMode') || 'cloth';
let _prevMicLevel = 0, _localPluck = 0;     // local mic onset → synthesized pluck
// ── Channel background weave (one strand per person, behind the chat) ──
let channelWeave = null;
const chanMsgTimes = [];                     // recent message timestamps (active channel) → noise

// Map / spatial UI state
const streamRegistry = new Map();
const userChannels = new Map();
const streamingUsers = new Set();
// username → { producerId, channelId, appData } — screen-audio waiting for explicit watch
const screenAudioRegistry = new Map();
let activeStreamWatch = null; // { producerId, username, screenAudioProducerId? }

// Volume state — purely client-side, in-memory per session
const userVolumes        = new Map(); // username → 0.0–2.0 gain
const streamVolumes      = new Map(); // username → 0.0–2.0 gain
const volExpandedUsers   = new Set(); // usernames with vol row open in sidebar
const userMuteStates     = new Map(); // username → boolean (muted)
// Web Audio gain nodes for >100% boost
let voiceAudioCtx = null;
const voiceGainNodes = new Map(); // username → GainNode
let streamGainNode = null;
function getVoiceAudioCtx() {
    if (!voiceAudioCtx || voiceAudioCtx.state === 'closed')
        voiceAudioCtx = new AudioContext();
    return voiceAudioCtx;
}

const CHANNEL_LABELS = Object.fromEntries((window.CHANNELS || []).map(c => [c.channelId, c.label]));
const CHANNEL_ORDER  = (window.CHANNELS || []).map(c => c.channelId);

// Server-advertised private channels visible to this user, layered on top of the static
// permanent channels above. id -> { label, canManage }. Populated from join_ack and live pushes.
const privateChannelMap = new Map();
const isPrivateChannel = id => typeof id === 'string' && id.startsWith('private:');
const channelLabel = id => CHANNEL_LABELS[id] ?? privateChannelMap.get(id)?.label ?? id;
const channelOrder = () => [...CHANNEL_ORDER, ...privateChannelMap.keys()];   // permanent first
function setPrivateChannels(list) {
    privateChannelMap.clear();
    for (const c of (list || [])) privateChannelMap.set(c.channelId, { label: c.label, canManage: !!c.canManage });
}

// ===== SOUNDS =====
const _sounds = {};
function initSounds() {
    for (const name of ['error', 'join_channel', 'leave_channel', 'new_text', 'stream_start', 'stream_end']) {
        const a = new Audio(`/assets/sounds/${name}.ogg`);
        a.load();
        _sounds[name] = a;
    }
}
function playSound(name) {
    const src = _sounds[name];
    if (!src) return;
    src.cloneNode().play().catch(() => {});
}

// ── "Fuck Discord" degrading moan — Web Audio, session-only ──
// Each click sounds worse: lower pitch, more distortion, more muffled. Resets on reload.
const FD_MOAN_URL = '/assets/sounds/configurations/anime_moan_ahh.ogg';
let fdAudioCtx = null, fdMoanBuffer = null, fdMoanLoading = false, fdPlayWhenReady = false;
let fdClickCount = 0;

function ensureFdAudio() {
    if (!fdAudioCtx) {
        try { fdAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { clientError('FD_AUDIO_CTX', e); return null; }
    }
    if (fdAudioCtx.state === 'suspended') fdAudioCtx.resume().catch(() => {});
    return fdAudioCtx;
}

function fdLoadBuffer(ctx) {
    if (fdMoanBuffer || fdMoanLoading) return;
    fdMoanLoading = true;
    fetch(FD_MOAN_URL)
        .then(r => r.arrayBuffer())
        .then(buf => ctx.decodeAudioData(buf))
        .then(decoded => {
            fdMoanBuffer = decoded;
            if (fdPlayWhenReady) { fdPlayWhenReady = false; fdEmitMoan(); } // play the deferred first click
        })
        .catch(e => clientError('FD_MOAN_LOAD', e))
        .finally(() => { fdMoanLoading = false; });
}

// Distortion curve whose harshness grows with `amount`
function fdDistortionCurve(amount) {
    const n = 44100, curve = new Float32Array(n), deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
}

function playDegradingMoan() {
    const ctx = ensureFdAudio();
    if (!ctx) return;
    fdLoadBuffer(ctx);
    if (!fdMoanBuffer) { fdPlayWhenReady = true; return; } // first click still decoding → defer once
    fdEmitMoan();
}

function fdEmitMoan() {
    const ctx = fdAudioCtx;
    fdClickCount++;
    const k = fdClickCount;

    const src = ctx.createBufferSource();
    src.buffer = fdMoanBuffer;
    src.playbackRate.value = Math.max(0.25, 1 - k * 0.06);      // slower + lower, clamped so it never fully dies
    if (src.detune) src.detune.value = -Math.min(2400, k * 90); // extra pitch sag

    const shaper = ctx.createWaveShaper();
    shaper.curve = fdDistortionCurve(Math.min(100, k * 6));     // grows harsher
    shaper.oversample = '4x';

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(500, 8000 - k * 600);         // progressively muffled

    const gain = ctx.createGain();
    gain.gain.value = 0.85;                                     // tame distortion makeup

    src.connect(shaper); shaper.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
    src.start();
    src.onended = () => { try { src.disconnect(); shaper.disconnect(); lp.disconnect(); gain.disconnect(); } catch (_) {} };
}

// ===== DOM REFS =====
const joinScreen      = document.getElementById('joinScreen');
const roomScreen      = document.getElementById('roomScreen');
const authTitle       = document.getElementById('authTitle');
const authSubtitle    = document.getElementById('authSubtitle');

// Login panel
const loginPanel      = document.getElementById('loginPanel');
const loginForm       = document.getElementById('loginForm');
const loginFullName   = document.getElementById('loginFullName');
const loginPassword   = document.getElementById('loginPassword');
const loginError      = document.getElementById('loginError');
const loginBtn        = document.getElementById('loginBtn');
const toRegisterLink  = document.getElementById('toRegisterLink');
const toForgotLink    = document.getElementById('toForgotLink');

// Register panel
const registerPanel   = document.getElementById('registerPanel');
const registerForm    = document.getElementById('registerForm');
const regFullName     = document.getElementById('regFullName');
const regNickName     = document.getElementById('regNickName');
const regPassword     = document.getElementById('regPassword');
const regAvatar       = document.getElementById('regAvatar');
const regSecretPhrase = document.getElementById('regSecretPhrase');
const regInviteCode   = document.getElementById('regInviteCode');
const regWebsite      = document.getElementById('regWebsite');   // honeypot
const registerBtn     = document.getElementById('registerBtn');
const registerError   = document.getElementById('registerError');
const toLoginLink1    = document.getElementById('toLoginLink1');

// Forgot / reset panel
const forgotPanel       = document.getElementById('forgotPanel');
const forgotVerifyStep  = document.getElementById('forgotVerifyStep');
const forgotResetStep   = document.getElementById('forgotResetStep');
const forgotForm        = document.getElementById('forgotForm');
const forgotFullName    = document.getElementById('forgotFullName');
const forgotSecretPhrase = document.getElementById('forgotSecretPhrase');
const forgotVerifyBtn   = document.getElementById('forgotVerifyBtn');
const forgotError       = document.getElementById('forgotError');
const resetForm         = document.getElementById('resetForm');
const newPasswordInput    = document.getElementById('newPasswordInput');
const newSecretPhraseInput = document.getElementById('newSecretPhraseInput');
const resetBtn            = document.getElementById('resetBtn');
const resetError          = document.getElementById('resetError');
const toLoginLink2      = document.getElementById('toLoginLink2');

// Room
const usersList           = document.getElementById('usersList');
const userCount           = document.getElementById('userCount');
const muteBtn             = document.getElementById('muteBtn');
const screenShareBtn      = document.getElementById('screenShareBtn');
const webcamBtn           = document.getElementById('webcamBtn');
const selfView            = document.getElementById('selfView');
const selfViewVideo       = document.getElementById('selfViewVideo');
const leaveBtn            = document.getElementById('leaveBtn');
const audioContainer        = document.getElementById('audioContainer');
const streamAudioContainer  = document.getElementById('streamAudioContainer');
const mainContent           = document.querySelector('.main-content');
const streamView            = document.getElementById('streamView');
const streamVideo           = document.getElementById('streamVideo');
const streamFullscreenBtn   = document.getElementById('streamFullscreenBtn');
const fsIconEnter           = document.getElementById('fsIconEnter');
const fsIconExit            = document.getElementById('fsIconExit');
const streamVolSlider       = document.getElementById('streamVolSlider');

function toggleStreamFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (streamView) {
        (streamView.requestFullscreen || streamView.webkitRequestFullscreen).call(streamView);
    }
}

function _onFullscreenChange() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (fsIconEnter) fsIconEnter.style.display = isFs ? 'none' : '';
    if (fsIconExit)  fsIconExit.style.display  = isFs ? ''     : 'none';
    if (streamFullscreenBtn) streamFullscreenBtn.title = isFs ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)';
}
document.addEventListener('fullscreenchange',       _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);
const textChatMessages    = document.getElementById('textChatMessages');
const textChatInput       = document.getElementById('textChatInput');
const textChatSend        = document.getElementById('textChatSend');
const textChatChannelName = document.getElementById('textChatChannelName');

// Admin panel
const adminPanel = document.getElementById('adminPanel');

// ===== MESSAGE WAITING =====
const pendingCallbacks = new Map();

function waitForMessage(key) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCallbacks.delete(key);
            reject(new Error(`Timeout waiting for: ${key}`));
        }, 15000);
        pendingCallbacks.set(key, (data) => {
            clearTimeout(timeout);
            resolve(data);
        });
    });
}

function resolveMessage(key, data) {
    if (pendingCallbacks.has(key)) {
        pendingCallbacks.get(key)(data);
        pendingCallbacks.delete(key);
    }
}

// ===== UI HELPERS =====
function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const colors = ['#00d4ff', '#ff00aa', '#00ff88', '#ffaa00', '#aa88ff'];
    return colors[Math.abs(hash) % colors.length];
}

function renderAvatar(username) {
    const pic = userProfiles.get(username);
    if (pic && pic.startsWith('data:image')) {
        return `<div class="avatar avatar-img"><img src="${pic}" alt="${username[0].toUpperCase()}" /></div>`;
    }
    if (pic) {
        return `<div class="avatar avatar-emoji">${pic}</div>`;
    }
    return `<div class="avatar" style="background:${getAvatarColor(username)}">${username[0].toUpperCase()}</div>`;
}

// Returns the video type ('webcam' | 'screen') a user is currently broadcasting, or null.
function getStreamType(username) {
    for (const [, info] of streamRegistry) {
        if (info.username === username && info.kind === 'video') return info.type || 'screen';
    }
    return null;
}

function getVoiceAudioEl(username) {
    for (const [pid, info] of consumers) {
        if (info.username === username && info.kind === 'audio' && !info.isScreenAudio)
            return audioContainer.querySelector(`audio[data-pid="${pid}"]`);
    }
    return null;
}

function userHue(u) {
    let h = 0;
    for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) & 0xffff;
    return h % 360;
}

const _SVG_SPEAKER = `<svg viewBox="0 0 24 24" fill="none" width="14" height="14" style="display:inline-block;vertical-align:middle"><path d="M11 5L6 9H3v6h3l5 4V5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const _SVG_MIC_OFF = `<svg viewBox="0 0 24 24" fill="none" width="13" height="13" style="display:inline-block;vertical-align:middle"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const _SVG_MONITOR = `<svg viewBox="0 0 24 24" fill="none" width="13" height="13" style="display:inline-block;vertical-align:middle"><rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const _SVG_CAMERA  = `<svg viewBox="0 0 24 24" fill="none" width="13" height="13" style="display:inline-block;vertical-align:middle"><rect x="2" y="6" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M16 10l6-3v10l-6-3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
const _SVG_VOL_SM  = `<svg viewBox="0 0 24 24" fill="none" width="13" height="13" style="display:inline-block;vertical-align:middle"><path d="M11 5L6 9H3v6h3l5 4V5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

// Perceptual sensitivity curve for the LOCAL mic's visualisation — matches VoiceMeter's curve so
// your own soft mic bounces like everyone else's. Visualisation-only: does NOT touch micLevel or
// the noise gate. (mirrors gain/curve in voice-levels.js)
const VOICE_VIS_GAIN = 1.6, VOICE_VIS_CURVE = 0.6;
function visualLevel(x) { return Math.min(1, Math.pow((x || 0) * VOICE_VIS_GAIN, VOICE_VIS_CURVE)); }

// ===== LOOM (channel user-list voice strings) =====
// Per-frame voice state for the active channel's strings. Local level comes from the existing mic
// meter (micLevel, sensitivity-curved); remote level/pluck from each user's VoiceMeter. Muted = flat.
function loomGetVoices() {
    const localLvl = isMuted ? 0 : visualLevel(micLevel);
    const rise = localLvl - _prevMicLevel;
    if (rise > 0.05 && localLvl > 0.08) _localPluck = Math.min(1, _localPluck + rise * 3.2);
    _localPluck *= 0.9;
    _prevMicLevel = localLvl;

    return loomParticipants.map(u => {
        if (u === myUsername) {
            return { id: u, hue: userHue(u), level: localLvl, pluck: isMuted ? 0 : _localPluck };
        }
        const m = voiceMeters.get(u);
        if (m) m.sample();
        const muted = !!userMuteStates.get(u);
        return { id: u, hue: userHue(u), level: muted ? 0 : (m ? m.level : 0), pluck: muted ? 0 : (m ? m.pluck : 0) };
    });
}

// Lazily create the persistent canvas + renderer once; reused across list rebuilds.
function ensureLoom() {
    if (!window.LoomRenderer) return null;
    if (!loomCanvasEl) {
        loomCanvasEl = document.createElement('canvas');
        loomCanvasEl.className = 'loom-canvas';
    }
    if (!loomRenderer) {
        loomRenderer = new LoomRenderer(loomCanvasEl, {
            mode: loomMode,
            getVoices: loomGetVoices,
            onRing: (id, glow) => { const el = ringEls.get(id); if (el) el.style.boxShadow = glow; },
        });
    }
    if (!staticBg) loomRenderer.start();
    return loomCanvasEl;
}

// A per-user volume control row — rendered BELOW the loom stage so anchor rows stay equal-height
// (the renderer needs equal rows for string↔avatar alignment). Reuses the existing slider handler.
function buildVolRow(user) {
    const sliderVal = Math.round((userVolumes.get(user) ?? 1) * 100);
    const row = document.createElement('div');
    row.className = 'user-vol-row';
    row.dataset.volFor = user;
    row.innerHTML = `
        <span class="vol-row-name">${user}</span>
        <input type="range" class="user-vol-slider" data-username="${user}"
               min="0" max="200" step="5" value="${sliderVal}">
        <span class="vol-pct">${sliderVal}%</span>
    `;
    return row;
}

// The active channel rendered as the Loom: mode switcher + (avatar anchor column ‖ strings canvas).
function buildLoomBlock(inChannel) {
    loomParticipants = inChannel.slice();   // display order, includes self

    const block = document.createElement('div');
    block.className = 'loom-block';

    const sw = document.createElement('div');
    sw.className = 'loom-switcher';
    sw.innerHTML = ['cloth', 'harp', 'web'].map(m =>
        `<button class="loom-mode-btn${m === loomMode ? ' active' : ''}" data-loom-mode="${m}">${m[0].toUpperCase()}${m.slice(1)}</button>`
    ).join('');
    block.appendChild(sw);

    const stage = document.createElement('div');
    stage.className = 'loom-stage';
    stage.style.height = `${Math.max(1, inChannel.length) * 44}px`;

    const anchors = document.createElement('div');
    anchors.className = 'loom-anchors';
    anchors.innerHTML = inChannel.map(user => {
        const isMe = user === myUsername;
        const muted = !!userMuteStates.get(user);
        const isStreaming = streamingUsers.has(user) && !isMe;
        const streamType = isStreaming ? getStreamType(user) : null;
        const badgeIcon  = streamType === 'webcam' ? _SVG_CAMERA : _SVG_MONITOR;
        const badgeTitle = streamType === 'webcam' ? 'Watch camera' : 'Watch stream';
        const tag = isMe ? 'you' : (muted ? 'muted' : 'listening');
        return `
            <div class="loom-anchor" data-username="${user}" style="--uc:${userHue(user)}">
                ${renderAvatar(user)}
                <div class="loom-anchor-meta">
                    <div class="loom-anchor-name">${user}</div>
                    <div class="loom-anchor-tag">${tag}</div>
                </div>
                ${muted ? `<span class="muted-indicator" title="Muted">${_SVG_MIC_OFF}</span>` : ''}
                ${!isMe ? `<button class="user-vol-btn" data-username="${user}" title="Adjust volume">${_SVG_VOL_SM}</button>` : ''}
                ${isStreaming ? `<span class="streaming-badge" data-username="${user}" data-type="${streamType}" title="${badgeTitle}">${badgeIcon}</span>` : ''}
            </div>`;
    }).join('');
    stage.appendChild(anchors);

    const wrap = document.createElement('div');
    wrap.className = 'loom-canvas-wrap';
    const canvas = ensureLoom();
    if (canvas) wrap.appendChild(canvas);   // re-parent the persistent canvas (keeps the renderer alive)
    stage.appendChild(wrap);
    block.appendChild(stage);

    // map each avatar element for the per-frame onRing glow
    anchors.querySelectorAll('.loom-anchor').forEach(a => {
        const u = a.dataset.username, av = a.querySelector('.avatar');
        if (u && av) ringEls.set(u, av);
    });

    // expanded volume controls live under the stage (don't disturb anchor row heights)
    for (const user of inChannel) {
        if (user !== myUsername && volExpandedUsers.has(user)) block.appendChild(buildVolRow(user));
    }
    return block;
}

// ===== CHANNEL BACKGROUND WEAVE (one strand per person, paced by channel noise) =====
// Message-rate component of channel "noise": messages per minute over a rolling window → 0..1.
function messageNoise() {
    const now = Date.now(), W = 20000;          // 20s window
    while (chanMsgTimes.length && now - chanMsgTimes[0] > W) chanMsgTimes.shift();
    const perMin = chanMsgTimes.length * (60000 / W);
    return Math.min(1, perMin / 30);            // ~30 msgs/min reads as "full"
}
// Voice component: favour the LOUDEST speaker (so one soft voice still registers) blended with the
// room average. Remote levels are already sensitivity-curved by VoiceMeter; curve the local term.
function voiceNoise(ids) {
    if (!ids || !ids.length) return 0;
    let sum = 0, loudest = 0;
    for (const u of ids) {
        const lvl = (u === myUsername) ? (isMuted ? 0 : visualLevel(micLevel)) : (voiceMeters.get(u)?.level || 0);
        sum += lvl;
        if (lvl > loudest) loudest = lvl;
    }
    return Math.min(1, Math.max(loudest, (sum / ids.length) * 1.4));
}
// Per-frame state for the channel weave: one strand per active-channel member + blended noise.
function channelGetState() {
    const channelId = userChannels.get(myUsername) || 'lobby';
    const allUsers = myUsername ? [...new Set([...connectedUsers, myUsername])] : [...connectedUsers];
    const ids = allUsers.filter(u => (userChannels.get(u) || 'lobby') === channelId);
    return {
        participants: ids.map(u => ({ id: u, hue: userHue(u) })),
        noise: Math.max(messageNoise(), voiceNoise(ids)),
    };
}
function ensureChannelWeave() {
    if (!window.ChannelWeave) return;
    if (!channelWeave) {
        const c = document.getElementById('chanBg');
        if (!c) return;
        channelWeave = new ChannelWeave(c, { getState: channelGetState, paceScale: 1.0 });
    }
    if (!staticBg) channelWeave.start();
}

function clearCanvas(c) { try { c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); } catch {} }

// Apply the "Static background" preference: stop + clear both canvas loops when on, or resume them
// when off (only if we're actually in a room and visible). A bare .stop() would freeze the last
// frame, so we clear the canvas to let the plain panel background show through.
function applyStaticBg() {
    if (staticBg) {
        loomRenderer?.stop();
        channelWeave?.stop();
        clearCanvas(loomCanvasEl);
        clearCanvas(document.getElementById('chanBg'));
    } else if (roomScreen.classList.contains('screen-active') && !document.hidden) {
        ensureLoom();
        ensureChannelWeave();
    }
}

function updateUsersList() {
    usersList.innerHTML = '';
    ringEls.clear();

    const allUsers = myUsername ? [...new Set([...connectedUsers, myUsername])] : [...connectedUsers];
    if (userCount) userCount.textContent = allUsers.length;

    for (const channelId of channelOrder()) {
        const inChannel = allUsers.filter(u => (userChannels.get(u) || 'lobby') === channelId);
        const myChannel = userChannels.get(myUsername) || 'lobby';
        const isActive  = myChannel === channelId;
        const priv      = isPrivateChannel(channelId);
        const canManage = priv && privateChannelMap.get(channelId)?.canManage;

        const header = document.createElement('div');
        header.className = 'channel-header' + (isActive ? ' channel-active' : '');
        header.title     = `Join ${channelLabel(channelId)}`;
        const countHtml  = inChannel.length > 0 ? `<span class="ch-count">${inChannel.length}</span>` : '';
        const iconHtml   = priv ? '🔒' : _SVG_SPEAKER;
        const manageHtml = canManage ? `<button class="ch-manage-btn" data-channel="${escapeHtml(channelId)}" title="Add members">＋</button>` : '';
        header.innerHTML = `<span class="ch-icon">${iconHtml}</span><span class="ch-name">${escapeHtml(channelLabel(channelId))}</span>${countHtml}${manageHtml}`;
        header.addEventListener('click', () => joinChannelStandard(channelId));
        // Manage button (creator/admin only) opens the add-members modal without joining.
        if (canManage) header.querySelector('.ch-manage-btn')?.addEventListener('click', e => {
            e.stopPropagation();
            openManageChannelModal(channelId);
        });
        usersList.appendChild(header);

        // The active channel renders as the Loom (voice strings); other channels stay as rows.
        if (isActive && inChannel.length > 0) {
            usersList.appendChild(buildLoomBlock(inChannel));
            continue;
        }

        if (inChannel.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'channel-empty';
            empty.textContent = '— empty —';
            usersList.appendChild(empty);
        } else {
            for (const user of inChannel) {
                const isMe = user === myUsername;
                const isStreaming = streamingUsers.has(user);
                const streamType = isStreaming ? getStreamType(user) : null;
                const badgeIcon  = streamType === 'webcam' ? _SVG_CAMERA : _SVG_MONITOR;
                const badgeTitle = streamType === 'webcam' ? 'Watch camera' : 'Watch stream';
                const item = document.createElement('div');
                item.className = 'user-item';
                item.dataset.username = user;
                item.style.setProperty('--uc', userHue(user));
                item.innerHTML = `
                    ${renderAvatar(user)}
                    <span class="username">${user}${isMe ? ' <span class="you-tag">(you)</span>' : ''}</span>
                    ${!isMe ? `<span id="speaking-${user}" class="speaking-indicator"></span>` : ''}
                    ${!isMe && userMuteStates.get(user) ? `<span class="muted-indicator" title="Muted">${_SVG_MIC_OFF}</span>` : ''}
                    ${!isMe ? `<button class="user-vol-btn" data-username="${user}" title="Adjust volume">${_SVG_VOL_SM}</button>` : ''}
                    ${isStreaming && !isMe ? `<span class="streaming-badge" data-username="${user}" data-type="${streamType}" title="${badgeTitle}">${badgeIcon}</span>` : ''}
                `;
                usersList.appendChild(item);

                if (!isMe && volExpandedUsers.has(user)) {
                    const gainVal = userVolumes.get(user) ?? 1;
                    const sliderVal = Math.round(gainVal * 100);
                    const row = document.createElement('div');
                    row.className = 'user-vol-row';
                    row.dataset.volFor = user;
                    row.innerHTML = `
                        <input type="range" class="user-vol-slider" data-username="${user}"
                               min="0" max="200" step="5" value="${sliderVal}">
                        <span class="vol-pct">${sliderVal}%</span>
                    `;
                    usersList.appendChild(row);
                }
            }
        }
    }
    ensureChannelWeave();
    clientLog('UI_UPDATE', `Users: ${allUsers.join(', ') || 'none'}`);
}

// ===== TOAST NOTIFICATIONS =====
function showToast(title, html, durationMs = 4000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<strong>${title}</strong><span>${html}</span>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-visible'));
    setTimeout(() => {
        el.classList.remove('toast-visible');
        el.addEventListener('transitionend', () => el.remove(), { once: true });
    }, durationMs);
}

// ===== AUTH PANEL SWITCHING =====

function showLoginPanel() {
    loginPanel.style.display = '';
    registerPanel.style.display = 'none';
    forgotPanel.style.display = 'none';
    authTitle.textContent = 'Welcome back';
    authSubtitle.textContent = 'Voice for small crews. Hop in.';
    loginError.style.display = 'none';
    loginBtn.disabled = false;
    loginBtn.querySelector('span').textContent = 'Login';
}

function showRegisterPanel() {
    loginPanel.style.display = 'none';
    registerPanel.style.display = '';
    forgotPanel.style.display = 'none';
    authTitle.textContent = 'Join the crew';
    authSubtitle.textContent = "Your stuff is safe — not like we're Discord or anything";
}

function showForgotPanel() {
    loginPanel.style.display = 'none';
    registerPanel.style.display = 'none';
    forgotPanel.style.display = '';
    authTitle.textContent = 'Recover Access';
    authSubtitle.textContent = "We’ll need to verify it’s really you.";
    forgotVerifyStep.style.display = '';
    forgotResetStep.style.display = 'none';
    forgotForm.reset();
    forgotError.style.display = 'none';
    forgotVerifyBtn.disabled = false;
    forgotVerifyBtn.querySelector('span').textContent = 'Verify';
}

function showLoginError(msg) {
    playSound('error');
    loginError.textContent = msg;
    loginError.style.display = 'block';
}

// ===== REGISTER VALIDATION =====
// Every field is mandatory. The Complete button stays clickable so a click can report exactly
// what's still missing (rather than sitting silently greyed-out). `el()` returns the element to
// highlight/focus for each rule, in form order.
const REGISTER_FIELDS = [
    { ok: () => regInviteCode.value.trim().length >= 8, el: () => regInviteCode, label: 'Invite Code' },
    { ok: () => regFullName.value.trim().length >= 2,   el: () => regFullName,   label: 'Full Name' },
    { ok: () => regNickName.value.trim().length >= 2,   el: () => regNickName,   label: 'Display Name' },
    { ok: () => regPassword.value.length >= 8,          el: () => regPassword,   label: 'Password (at least 8 characters)' },
    // Profile picture is OPTIONAL — registration must never be blocked by an image that won't upload
    // (e.g. iPhone HEIC photos can't be decoded client-side). Missing → server defaults to 🎭.
    { ok: () => regSecretPhrase.value.length >= 1,      el: () => regSecretPhrase, label: 'Secret Phrase' },
];

function registerProblems() {
    return REGISTER_FIELDS.filter(f => !f.ok());
}

// ===== TEXT CHAT =====
function updateTextChatHeader(channelId) {
    if (textChatChannelName) {
        textChatChannelName.textContent = channelLabel(channelId);
    }
}

// Limbo (no-channel) landing: show the banner and neutralize the chat composer until a channel is picked.
function enterLimboUI() {
    const banner = document.getElementById('limboBanner');
    if (banner) banner.style.display = '';
    if (textChatChannelName) textChatChannelName.textContent = 'No channel';
    const msgs = document.getElementById('textChatMessages');
    if (msgs) msgs.innerHTML = '<p class="text-chat-placeholder">Pick a channel to start chatting.</p>';
    const input = document.getElementById('textChatInput');
    const send  = document.getElementById('textChatSend');
    if (input) { input.disabled = true; input.placeholder = 'Pick a channel to chat…'; }
    if (send)  send.disabled = true;
}
function exitLimboUI() {
    const banner = document.getElementById('limboBanner');
    if (banner) banner.style.display = 'none';
    const input = document.getElementById('textChatInput');
    const send  = document.getElementById('textChatSend');
    if (input) { input.disabled = false; input.placeholder = 'Message…'; }
    if (send)  send.disabled = false;
}

function buildDaySeparator(date) {
    const sep = document.createElement('div');
    sep.className = 'chat-day-sep';
    sep.dataset.day = date.toDateString();
    sep.textContent = date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    return sep;
}

function appendDaySeparator(date) {
    textChatMessages.appendChild(buildDaySeparator(date));
}

function buildMessageEl({ username, text, ts, isMe = false, grouped = false }) {
    const d   = ts instanceof Date ? ts : new Date(ts || Date.now());
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = isToday
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' +
          d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const pic = userProfiles.get(username);
    let avatarHtml;
    if (pic && pic.startsWith('data:image')) {
        avatarHtml = `<div class="avatar avatar-img" style="width:32px;height:32px"><img src="${pic}" alt="${username[0].toUpperCase()}" /></div>`;
    } else if (pic) {
        avatarHtml = `<div class="avatar avatar-emoji" style="width:32px;height:32px;font-size:17px">${pic}</div>`;
    } else {
        avatarHtml = `<div class="avatar" style="width:32px;height:32px;background:${getAvatarColor(username)};font-size:13px">${username[0].toUpperCase()}</div>`;
    }

    const div = document.createElement('div');
    div.className = 'chat-msg' + (grouped ? ' grouped' : '');
    div.innerHTML = `
        <div class="chat-msg-avatar">${avatarHtml}</div>
        <div class="chat-msg-body">
            <div class="chat-msg-meta">
                <span class="chat-msg-author${isMe ? ' is-me' : ''}">${escapeHtml(username)}</span>
                <span class="chat-msg-time">${timeStr}</span>
            </div>
            <div class="chat-msg-text">${renderMessageContent(text)}</div>
        </div>
    `;
    // Kick off Open-Graph preview cards for the first couple of distinct (non-image) links.
    const bodyEl = div.querySelector('.chat-msg-body');
    for (const link of [...new Set(extractPreviewLinks(text))].slice(0, 2)) fetchLinkPreview(link, bodyEl);
    return div;
}

function appendTextMessage(opts) {
    if (!textChatMessages) return;
    const placeholder = textChatMessages.querySelector('.text-chat-placeholder');
    if (placeholder) placeholder.remove();
    textChatMessages.appendChild(buildMessageEl(opts));
    textChatMessages.scrollTop = textChatMessages.scrollHeight;
}

function isImageUrl(url) {
    return url.startsWith('/uploads/') || CHAT_IMG_EXT_RE.test(url);
}

// Render message text: linkify URLs, inline image URLs/uploads as <img>, escape the rest.
function renderMessageContent(text) {
    const re = new RegExp(CHAT_TOKEN_RE.source, 'gi');
    let out = '', last = 0, m;
    while ((m = re.exec(text)) !== null) {
        const url = m[0];
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        if (isImageUrl(url)) {
            out += `<img class="chat-img" src="${escapeHtml(url)}" alt="image" loading="lazy" />`;
        } else {
            out += `<a class="chat-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
        }
        last = m.index + url.length;
    }
    if (last < text.length) out += escapeHtml(text.slice(last));
    return out;
}

function extractPreviewLinks(text) {
    const re = new RegExp(CHAT_TOKEN_RE.source, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        if (/^https?:\/\//i.test(m[0]) && !isImageUrl(m[0])) out.push(m[0]);
    }
    return out;
}

// Fetch an Open-Graph preview (server-cached) and append a card into the message body.
async function fetchLinkPreview(url, bodyEl) {
    if (!bodyEl || !joinToken) return;
    let data = linkPreviewClientCache.get(url);
    if (!data) {
        try {
            const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`,
                { headers: { Authorization: `Bearer ${joinToken}` } });
            data = await res.json();
        } catch { data = { ok: false }; }
        linkPreviewClientCache.set(url, data);
    }
    if (!data.ok || !bodyEl.isConnected) return;

    const card = document.createElement('a');
    card.className = 'chat-link-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.dataset.url = url;
    card.innerHTML = `
        ${data.image ? `<div class="link-card-img"><img src="${escapeHtml(data.image)}" alt="" loading="lazy" /></div>` : ''}
        <div class="link-card-body">
            ${data.siteName ? `<div class="link-card-site">${escapeHtml(data.siteName)}</div>` : ''}
            <div class="link-card-title">${escapeHtml(data.title || url)}</div>
            ${data.description ? `<div class="link-card-desc">${escapeHtml(data.description)}</div>` : ''}
        </div>
        <button class="link-card-dismiss" title="Remove preview" aria-label="Remove preview">×</button>`;
    const cardImg = card.querySelector('.link-card-img img');
    if (cardImg) cardImg.addEventListener('error', () => cardImg.closest('.link-card-img')?.remove());
    card.querySelector('.link-card-dismiss').addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        card.remove();
    });
    bodyEl.appendChild(card);
    textChatMessages.scrollTop = textChatMessages.scrollHeight;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function sendTextMessage() {
    const text = textChatInput?.value?.trim();
    if (!text || !joined) { if (!text && joined) playSound('error'); return; }
    sendWS({ type: 'text_message', text });
    textChatInput.value = '';
}

// Upload an image file/blob to the Pi; returns its /uploads/<id>.<ext> URL.
async function uploadImage(file) {
    const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': file.type, Authorization: `Bearer ${joinToken}` },
        body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `upload failed (${res.status})`);
    return data.url;
}

// Paste/picked image → upload → post immediately as its own message (the URL is the text).
async function handleImageSend(file) {
    if (!file || !joined) return;
    try {
        const url = await uploadImage(file);
        sendWS({ type: 'text_message', text: url });
    } catch (err) {
        clientError('IMAGE_UPLOAD', err);
        playSound('error');
    }
}

function openLightbox(src) {
    const lb = document.getElementById('imgLightbox');
    const img = document.getElementById('imgLightboxImg');
    if (!lb || !img) return;
    img.src = src;
    lb.hidden = false;
}

function closeLightbox() {
    const lb = document.getElementById('imgLightbox');
    const img = document.getElementById('imgLightboxImg');
    if (!lb) return;
    lb.hidden = true;
    if (img) img.src = '';
}

// ===== STREAM WATCH =====
// Reliably stop an <audio> element: a detached element can keep playing after
// .remove() alone, so pause it and drop its srcObject first.
function stopAndRemoveAudioEl(el) {
    if (!el) return;
    const pid = el.dataset.pid;
    if (el.dataset.type === 'screen-audio') {
        if (streamGainNode) { try { streamGainNode.disconnect(); } catch {} streamGainNode = null; }
    } else if (pid) {
        const uname = consumers.get(pid)?.username;
        if (uname && voiceGainNodes.has(uname)) {
            try { voiceGainNodes.get(uname).disconnect(); } catch {}
            voiceGainNodes.delete(uname);
        }
    }
    try { el.pause(); } catch (_) {}
    try { el.srcObject = null; } catch (_) {}
    el.remove();
}

async function subscribeToStream(username) {
    if (activeStreamWatch?.username === username) return; // already watching this user
    if (activeStreamWatch) stopWatchingStream();          // switching streams → tear down the previous one first

    let videoPid = null;
    for (const [pid, info] of streamRegistry) {
        if (info.username === username && info.kind === 'video') { videoPid = pid; break; }
    }
    if (!videoPid) return;

    const stream = await window.weave.consumeStream(videoPid);
    if (!stream) return;

    let screenAudioPid = null;
    const saInfo = screenAudioRegistry.get(username);
    if (saInfo) {
        screenAudioPid = saInfo.producerId;
        await consumeProducer(saInfo.producerId, username, 'audio', saInfo.channelId, saInfo.appData);
    }

    activeStreamWatch = { producerId: videoPid, username, screenAudioProducerId: screenAudioPid };
    if (streamVideo) streamVideo.srcObject = stream;
    if (streamVolSlider) streamVolSlider.value = streamVolumes.get(username) ?? 1;
    mainContent?.classList.add('has-stream');
    clientLog('STREAM_WATCH', username);
}

function stopWatchingStream() {
    // You only ever watch one stream at a time, and screen-audio is only consumed for the
    // watched user — so close EVERY screen-audio consumer and clear the container. This kills
    // any duplicate/orphaned consumers that earlier re-consume bugs could have left behind.
    for (const [pid, info] of [...consumers]) {
        if (info.isScreenAudio) {
            try { info.consumer.close(); } catch (_) {}
            consumers.delete(pid);
        }
    }
    streamAudioContainer.querySelectorAll('audio').forEach(stopAndRemoveAudioEl);
    activeStreamWatch = null;
    if (streamVideo) { streamVideo.srcObject = null; }
    mainContent?.classList.remove('has-stream');
}

// ===== STANDARD-MODE CHANNEL JOIN =====
async function joinChannelStandard(channelId) {
    if (!joined) return;
    userChannels.set(myUsername, channelId);
    landingChannel = channelId;   // so a reconnect rejoins this channel, not limbo
    chanMsgTimes.length = 0;   // reset message-rate noise for the new channel
    for (const [producerId, entry] of consumers) {
        if (entry.kind !== 'audio') continue;
        try { entry.consumer.close(); } catch (_) {}
        consumers.delete(producerId);
        const container = entry.isScreenAudio ? streamAudioContainer : audioContainer;
        container.querySelectorAll(`[data-pid="${producerId}"]`).forEach(stopAndRemoveAudioEl);
        if (!entry.isScreenAudio) stopVAD(entry.username);
    }
    sendWS({ type: 'move', x: 1000, y: 960, channelId });
    // First channel pick out of limbo: start transmitting now (move is processed first, so the
    // server advertises this producer into the correct channel).
    if (!audioProducer) await produceAudio();
    exitLimboUI();
    updateUsersList();
    updateTextChatHeader(channelId);
    loadChannelHistory(channelId);
}

// ===== VOICE ACTIVITY DETECTION =====
// One VoiceMeter (level + onset pluck) per remote participant stream, sampled each frame by the
// Loom renderer (loomGetVoices). Reuses the shared playback AudioContext — no per-user context.
function startVAD(username, stream) {
    if (voiceMeters.has(username) || !window.VoiceMeter) return;
    try {
        voiceMeters.set(username, new VoiceMeter(getVoiceAudioCtx(), stream));
    } catch (e) { clientError('VAD_FAILED', e); }
}

function stopVAD(username) {
    const m = voiceMeters.get(username);
    if (!m) return;
    try { m.disconnect(); } catch {}
    voiceMeters.delete(username);
}

// ===== LOCAL MEDIA =====
async function initLocalMedia() {
    if (localStream) {
        const track = localStream.getAudioTracks()[0];
        if (track && track.readyState === 'live') return true;
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    clientLog('MIC_REQUEST', 'Requesting microphone...');
    for (let attempt = 0; attempt <= 1; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 600));
        try {
            const audio = {
                echoCancellation: micConstraints.echoCancellation,
                noiseSuppression: micConstraints.noiseSuppression,
                autoGainControl:  micConstraints.autoGainControl,   // default ON; user-toggleable (turn off to use the noise gate)
            };
            if (micConstraints.deviceId) audio.deviceId = { exact: micConstraints.deviceId };
            localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
            clientLog('MIC_SUCCESS', 'Microphone acquired');
            micErrorName = '';
            return true;
        } catch (err) {
            // Stored device unplugged/unavailable → drop the preference and retry the default mic.
            if (err.name === 'OverconstrainedError' && micConstraints.deviceId && attempt === 0) {
                clientLog('MIC_RETRY', 'Selected device unavailable — falling back to default');
                micConstraints.deviceId = '';
                saveMicConstraints();
                continue;
            }
            // NotReadableError/AbortError = the OS couldn't START the device (not a permissions issue) —
            // most often a transient lock from a closing tab/app on re-login. One quick retry clears it.
            if ((err.name === 'NotFoundError' || err.name === 'NotReadableError' || err.name === 'AbortError') && attempt === 0) {
                clientLog('MIC_RETRY', `${err.name} — retrying in 600 ms`);
                continue;
            }
            micErrorName = err.name || '';
            clientError('MIC_FAILED', err);
            return false;
        }
    }
    return false;
}

// Human, accurate guidance for a getUserMedia failure (NotReadableError is NOT a permissions issue).
function micErrorText(name) {
    switch (name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return "Microphone access is blocked. Allow it in your browser's site settings, then retry.";
        case 'NotReadableError':
        case 'AbortError':
        case 'TrackStartError':
            return "Your microphone couldn't start — it's likely in use by another app (Discord, Zoom, OBS) or another Weave tab. Close those, then retry.";
        case 'NotFoundError':
        case 'OverconstrainedError':
            return "No microphone was found. Plug one in (or pick another in Mic settings), then retry.";
        default:
            return "Your microphone couldn't start. Close any app that might be using it, then retry.";
    }
}

// Mic failed at join → enter the room in LISTEN-ONLY mode (still hear everyone + chat) instead of being
// locked out at the login screen. The mic button becomes a one-click retry.
function enterNoMicUI() {
    isMuted = true;
    if (muteBtn) {
        muteBtn.classList.add('active');
        const label = muteBtn.querySelector('.label');
        if (label) label.textContent = 'Enable mic';
        muteBtn.title = 'Microphone unavailable — click to retry';
    }
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mute_changed', muted: true }));
    showToast('Microphone unavailable',
        `${micErrorText(micErrorName)}<br><br>You're in <b>listen-only</b> mode — you can still hear everyone and use chat. Click the mic button to retry.`,
        9000);
}

// Re-attempt the mic (e.g. after the user closes the app holding it) and start transmitting.
async function retryMic() {
    showToast('Microphone', 'Trying your microphone…', 1500);
    const ok = await initLocalMedia();
    if (!ok) { showToast('Still unavailable', micErrorText(micErrorName), 7000); return; }
    micUnavailable = false;
    isMuted = false;
    if (sendTransport && (!audioProducer || audioProducer.closed)) {
        try { await produceAudio(); } catch (e) { clientError('RETRY_PRODUCE_FAILED', e); }
    }
    if (muteBtn) {
        muteBtn.classList.remove('active');
        const label = muteBtn.querySelector('.label');
        if (label) label.textContent = 'Mute';
        muteBtn.title = 'Toggle microphone';
    }
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mute_changed', muted: false }));
    showToast('Microphone connected', 'You can talk now.', 3000);
}

// ===== MIC NOISE GATE =====
// Route the mic through Web Audio (source → inputGain → analyser → gate gain → destination) and
// produce the gated track. inputGain is the user-adjustable input level (mic volume); it feeds the
// analyser too, so the meter, gate threshold and transmitted audio all reflect the boost. Below the
// threshold the gate gain ramps to 0 (silence); above it (plus a short hold) it ramps to 1. The
// graph stays in place even when the gate is disabled (gate gain held at 1 = transparent), so
// toggling / threshold / input-level changes are instant with no re-produce.
const GATE_HOLD_MS = 250;     // brief hold after speech so word-ends / short gaps aren't clipped
const GATE_ATTACK  = 0.012;   // fast open
const GATE_RELEASE = 0.25;    // gentle fade — soft tail, but reaches silence without lingering/bleeding
const GATE_FLOOR   = 0;       // closed = SILENCE. A noise gate must actually cut; a >0 floor leaks ("bleeds")
const GATE_HYSTERESIS = 0.85; // stay-open threshold = 85% of the set line → shuts reliably just below it, no chatter

function teardownMicGate() {
    if (!micGateGraph) return;
    clearInterval(micGateGraph.timer);
    try { micGateGraph.source.disconnect(); } catch {}
    try { micGateGraph.inputGain.disconnect(); } catch {}
    try { micGateGraph.gain.disconnect(); } catch {}
    try { micGateGraph.dest.disconnect(); } catch {}
    try { micGateGraph.monSource && micGateGraph.monSource.disconnect(); } catch {}
    try { micGateGraph.monGain && micGateGraph.monGain.disconnect(); } catch {}
    try { micGateGraph.monTrack && micGateGraph.monTrack.stop(); } catch {}
    // Never leave the transmitted mic gated-off after a teardown/rebuild.
    try { if (micGateGraph.rawTrack) micGateGraph.rawTrack.enabled = !isMuted; } catch {}
    // NOTE: do NOT close micCtx here — it is reused across rebuilds. Closing + recreating a context on
    // every settings change leaks contexts and hits Chrome's ~6-context cap, after which a new context
    // throws and the gate falls back to the raw (ungated) track.
    micGateGraph = null;
}

// Build the gate graph from the raw mic stream; returns the processed (gated) track.
function buildMicGate(stream) {
    teardownMicGate();
    // Pin the context to Opus's native 48 kHz so the gated track isn't resampled to the
    // output-device rate (e.g. 44.1 kHz, or 16 kHz on a Bluetooth headset). Fall back for
    // older browsers that reject the options object.
    // Reuse ONE AudioContext for the mic across rebuilds — see teardownMicGate for why.
    if (!micCtx || micCtx.state === 'closed') {
        try { micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); }
        catch { micCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    }
    const ctx = micCtx;
    ctx.resume?.().catch(() => {});
    const rawTrack = stream.getAudioTracks()[0];
    // TRANSMIT path: raw mic -> inputGain (user mic-volume) -> gate gain (soft fade) -> destination -> producer.
    // The HARD cut is done by toggling rawTrack.enabled in runGateLoop (see why there); the gain just fades.
    const source = ctx.createMediaStreamSource(stream);
    const inputGain = ctx.createGain();
    inputGain.gain.value = micGate.inputGain;     // user input level (mic volume)
    const gain = ctx.createGain();                // the gate (soft fade only)
    gain.gain.value = 1;
    const dest = ctx.createMediaStreamDestination();
    source.connect(inputGain);
    inputGain.connect(gain);
    gain.connect(dest);
    // MONITOR path: a CLONE of the mic, never gated, drives the analyser so the gate keeps SEEING the
    // input level even after it has muted the transmitted mic (rawTrack.enabled=false). Without this the
    // level reads 0 the instant we cut and the gate could never re-open.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    let monTrack = null, monSource = null, monGain = null;
    try {
        monTrack = rawTrack.clone();
        monSource = ctx.createMediaStreamSource(new MediaStream([monTrack]));
        monGain = ctx.createGain();
        monGain.gain.value = micGate.inputGain;
        monSource.connect(monGain);
        monGain.connect(analyser);
    } catch (e) {
        // clone unsupported (rare) -> tap the transmit path; meter goes quiet while fully cut, but the
        // hold window still lets brief sounds re-open the gate.
        inputGain.connect(analyser);
    }
    const buf = new Uint8Array(analyser.fftSize);
    micGateGraph = { ctx, source, inputGain, gain, dest, analyser, buf, rawTrack, monTrack, monSource, monGain, openUntil: 0, fadeDoneAt: 0, timer: null };
    micGateGraph.timer = setInterval(runGateLoop, 40);
    // Tag the synthetic destination track as speech so the Opus encoder uses voice tuning.
    const gatedTrack = dest.stream.getAudioTracks()[0];
    try { gatedTrack.contentHint = 'speech'; } catch {}
    return gatedTrack;
}

// Live-adjust the input level (mic volume). Applied instantly with a short ramp to avoid zipper noise.
function setMicInputGain(v) {
    micGate.inputGain = v;
    if (micGateGraph) {
        try { micGateGraph.inputGain.gain.setTargetAtTime(v, micGateGraph.ctx.currentTime, 0.02); } catch {}
        try { micGateGraph.monGain && micGateGraph.monGain.gain.setTargetAtTime(v, micGateGraph.ctx.currentTime, 0.02); } catch {}
    }
}

function runGateLoop() {
    if (!micGateGraph) return;
    const { analyser, gain, ctx, buf, rawTrack } = micGateGraph;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    micLevel = Math.min(1, rms / MIC_LEVEL_MAX);

    let open;
    if (!micGate.enabled) {
        open = true;
    } else {
        const openThresh  = micGate.threshold * MIC_LEVEL_MAX;
        const closeThresh = openThresh * GATE_HYSTERESIS;   // lower bar to STAY open → no chatter
        if (rms >= openThresh) micGateGraph.openUntil = performance.now() + GATE_HOLD_MS;
        open = performance.now() < micGateGraph.openUntil || rms >= closeThresh;
    }
    // Duck the Web Audio gain (smooth + drives nothing critical now) …
    try { gain.gain.setTargetAtTime(open ? 1 : GATE_FLOOR, ctx.currentTime, open ? GATE_ATTACK : GATE_RELEASE); } catch {}
    // GUARANTEED cut: toggle the RAW mic track's enabled flag — the exact mechanism the mute button uses
    // and the ONLY thing that reliably silences what listeners hear (ducking the WebAudio gain above or
    // pausing the producer do NOT silence a MediaStreamDestination track in Chromium — which is why the
    // gate appeared to do nothing). The analyser runs off a separate, never-gated clone (see
    // buildMicGate), so the level stays visible after a cut and the gate can re-open. We keep
    // transmitting through a short fade window after close, then hard-cut to true silence.
    const nowMs = performance.now();
    if (open) micGateGraph.fadeDoneAt = nowMs + 150;   // GATE_CUT_DELAY_MS: soft-fade window before the hard cut
    const gateAllows = !micGate.enabled || open || nowMs < micGateGraph.fadeDoneAt;
    const transmit = !isMuted && gateAllows;
    if (rawTrack) { try { rawTrack.enabled = transmit; } catch {} }
    // Keep the producer's paused state in sync as a belt-and-suspenders measure; the rawTrack.enabled
    // flag above is the real silencer, so this is harmless even if pause no-ops on the synthetic track.
    if (audioProducer && !audioProducer.closed) {
        const shouldPause = !transmit;   // gate fully cut OR muted
        try {
            if (shouldPause && !audioProducer.paused) audioProducer.pause();
            else if (!shouldPause && audioProducer.paused) audioProducer.resume();
        } catch {}
    }
    updateMicMeter();
}

// Live meter — only touches the DOM while the mic settings panel is visible.
function updateMicMeter() {
    const panel = document.getElementById('micSettingsPanel');
    if (!panel || panel.style.display === 'none') return;
    const fill  = document.getElementById('micMeterFill');
    const meter = document.getElementById('micMeter');
    if (fill)  fill.style.width = `${Math.round(micLevel * 100)}%`;
    if (meter) meter.classList.toggle('gate-open', !micGate.enabled || micLevel >= micGate.threshold);
}

// ===== MEDIASOUP CLIENT =====
async function setupDevice(routerRtpCapabilities) {
    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities });
    clientLog('DEVICE_LOADED', `canProduce audio=${device.canProduce('audio')}`);
}

function sendWS(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function createSendTransport() {
    sendWS({ type: 'createTransport', direction: 'send' });
    const msg = await waitForMessage('transportCreated_send');

    const transport = device.createSendTransport(msg.params);
    transport.on('connectionstatechange', (s) => clientLog('ICE_STATE', `send: ${s}`));

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            sendWS({ type: 'connectTransport', direction: 'send', dtlsParameters });
            await waitForMessage('transportConnected_send');
            callback();
        } catch (e) { errback(e); }
    });

    transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
            sendWS({ type: 'produce', kind, rtpParameters, appData });
            const { id } = await waitForMessage(`produced_${kind}`);
            callback({ id });
        } catch (e) { errback(e); }
    });

    sendTransport = transport;
    clientLog('SEND_TRANSPORT_READY', transport.id);
}

async function createRecvTransport() {
    sendWS({ type: 'createTransport', direction: 'recv' });
    const msg = await waitForMessage('transportCreated_recv');

    const transport = device.createRecvTransport(msg.params);
    transport.on('connectionstatechange', (s) => clientLog('ICE_STATE', `recv: ${s}`));

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
            sendWS({ type: 'connectTransport', direction: 'recv', dtlsParameters });
            await waitForMessage('transportConnected_recv');
            callback();
        } catch (e) { errback(e); }
    });

    recvTransport = transport;
    clientLog('RECV_TRANSPORT_READY', transport.id);
}

async function produceAudio() {
    if (!sendTransport || !localStream) return;
    const rawTrack = localStream.getAudioTracks()[0];
    if (!rawTrack) return;
    let track = rawTrack;
    try { track = buildMicGate(localStream); }
    catch (e) { clientError('MIC_GATE_FAILED', e); track = rawTrack; }
    // Tune Opus for voice: mono, FEC for packet-loss resilience, DTX off to avoid speech-onset
    // clipping (the gate already silences quiet input), full-band at 64 kbps. Persists across
    // reacquireMic()'s replaceTrack() — the codec is negotiated once at produce() time.
    audioProducer = await sendTransport.produce({
        track,
        codecOptions: {
            opusStereo: false,
            opusFec: true,
            opusDtx: false,
            opusMaxAverageBitrate: 96000,
            opusMaxPlaybackRate: 48000,
        },
    });
    clientLog('AUDIO_PRODUCED', `${audioProducer.id} (gated)`);
}

// Re-grab the mic with the current browser-processing constraints and swap the live producer
// track. Called when a browser-processing checkbox changes mid-call.
async function reacquireMic() {
    if (!localStream) return;   // not in a call yet — new constraints apply on next join
    const wasMuted = isMuted;
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    const ok = await initLocalMedia();
    if (!ok) { clientError('MIC_RECONFIG_FAILED', 'getUserMedia failed'); return; }
    localStream.getAudioTracks().forEach(t => { t.enabled = !wasMuted; });
    if (audioProducer) {
        try {
            const track = buildMicGate(localStream);
            await audioProducer.replaceTrack({ track });
            clientLog('MIC_RECONFIG', JSON.stringify(micConstraints));
        } catch (e) { clientError('MIC_RECONFIG_FAILED', e); }
    }
}

async function consumeProducer(producerId, username, kind, channelId = 'lobby', appData = {}) {
    if (!recvTransport || !device) return;
    if (consumers.has(producerId)) return; // already consuming — avoid duplicate consumer/audio element
    const isScreenAudio = appData?.type === 'screen-audio';
    if (kind === 'audio' && !streamRegistry.has(producerId)) {
        streamRegistry.set(producerId, { username, channelId, kind: isScreenAudio ? 'screen-audio' : kind });
    }
    clientLog('CONSUMING', `${kind} from ${username} (${producerId})`);

    sendWS({ type: 'consume', producerId, rtpCapabilities: device.rtpCapabilities });
    const data = await waitForMessage(`consumed_${producerId}`);

    const consumer = await recvTransport.consume({
        id: data.id,
        producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
    });

    const peerChannelId = streamRegistry.get(producerId)?.channelId ?? 'lobby';
    consumers.set(producerId, { consumer, username, kind, channelId: peerChannelId, isScreenAudio });
    sendWS({ type: 'resumeConsumer', producerId });

    if (kind === 'audio') {
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.dataset.pid = producerId;
        audioEl.srcObject = new MediaStream([consumer.track]);

        const gainValue = (isScreenAudio ? streamVolumes : userVolumes).get(username) ?? 1;
        const ctx = getVoiceAudioCtx();
        const src = ctx.createMediaStreamSource(audioEl.srcObject);
        const gain = ctx.createGain();
        gain.gain.value = gainValue;
        src.connect(gain);
        gain.connect(ctx.destination);
        audioEl.muted = true; // suppress direct output; GainNode handles playback

        if (isScreenAudio) {
            if (streamGainNode) { try { streamGainNode.disconnect(); } catch {} }
            streamGainNode = gain;
            audioEl.dataset.type = 'screen-audio';
            audioEl.dataset.streamUser = username;
            streamAudioContainer.appendChild(audioEl);
        } else {
            if (voiceGainNodes.has(username)) {
                try { voiceGainNodes.get(username).disconnect(); } catch {}
            }
            voiceGainNodes.set(username, gain);
            audioContainer.appendChild(audioEl);
            startVAD(username, audioEl.srcObject);
        }
        audioEl.play().catch(e => clientError('AUDIO_PLAY_FAILED', e));
        clientLog('AUDIO_PLAYING', `from ${username}${isScreenAudio ? ' (screen)' : ''}`);
    }

    consumer.on('transportclose', () => consumers.delete(producerId));
}

function resetSFUState() {
    try { if (sendTransport && !sendTransport.closed) sendTransport.close(); } catch (_) {}
    try { if (recvTransport && !recvTransport.closed) recvTransport.close(); } catch (_) {}
    sendTransport = null;
    recvTransport = null;
    audioProducer = null;
    videoProducer = null;
    screenAudioProducer = null;
    consumers.forEach(({ consumer }) => { try { consumer.close(); } catch (_) {} });
    consumers.clear();
    device = null;
    pendingCallbacks.clear();
}

// ===== WEBSOCKET =====
function connectWebSocket() {
    if (ws) {
        const old = ws;
        ws = null;
        old.onopen = old.onmessage = old.onerror = old.onclose = null;
        try { old.close(); } catch (_) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        clientLog('WS_CONNECTED', 'WebSocket open');
        reconnectAttempts = 0;
        reconnectTimer = null;
        if (myUsername && joinToken) {
            if (joined) clientLog('WS_REJOIN', 'Auto re-joining after reconnect');
            sendWS({ type: 'join', username: myUsername, token: joinToken, channelId: landingChannel });
        }
    };

    ws.onmessage = async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type !== 'peer_moved') {
            clientLog(`MSG_${msg.type.toUpperCase()}`, msg.username || msg.direction || msg.kind || '');
        }

        switch (msg.type) {

            case 'peer_moved': {
                const prevCh = userChannels.get(msg.username);
                const newCh  = msg.channelId || 'lobby';
                userChannels.set(msg.username, newCh);
                if (prevCh !== newCh) {
                    const myCh = userChannels.get(myUsername) || 'lobby';
                    if (newCh === myCh) playSound('join_channel');
                    if (prevCh === myCh) playSound('leave_channel');
                    updateUsersList();
                }
                window.weaveMap?.onPeerMoved(msg.username, msg.x, msg.y, msg.channelId);
                break;
            }

            case 'privateChannels': {
                setPrivateChannels(msg.channels);
                if (joined) updateUsersList();
                break;
            }

            case 'channelDestroyed': {
                privateChannelMap.delete(msg.channelId);
                // If we were somehow still inside it, fall back to the lobby; else just refresh.
                if ((userChannels.get(myUsername) || 'lobby') === msg.channelId) joinChannelStandard('lobby');
                else if (joined) updateUsersList();
                break;
            }

            case 'move_rejected': {
                clientError('MOVE_REJECTED', msg.reason || msg.channelId);
                showToast('Channel unavailable', msg.reason || 'You no longer have access to that channel.');
                updateUsersList();   // resync — the channel may have vanished
                break;
            }

            case 'join_ack': {
                joined = true;
                connectedUsers = msg.users.map(u => u.username);
                // Populate profiles from server
                for (const u of msg.users) {
                    if (u.profile_picture) userProfiles.set(u.username, u.profile_picture);
                    userMuteStates.set(u.username, !!u.muted);
                }
                clientLog('JOIN_SUCCESS', `room: ${connectedUsers.join(', ')}`);

                // Ingest the private channels this user may see. Drop a stale landing channel —
                // a private channel can self-destruct while we're away, so fall back to lobby.
                setPrivateChannels(msg.privateChannels);
                if (landingChannel !== LIMBO && isPrivateChannel(landingChannel) && !privateChannelMap.has(landingChannel)) {
                    landingChannel = 'lobby';
                }

                const inLimbo = landingChannel === LIMBO;
                userChannels.clear();
                for (const user of connectedUsers) userChannels.set(user, 'lobby');
                userChannels.set(myUsername, landingChannel);
                if (msg.mapPositions) {
                    for (const pos of msg.mapPositions) userChannels.set(pos.username, pos.channelId || 'lobby');
                }

                resetSFUState();

                // Mic may fail to START (NotReadableError: in use by another app/tab) — don't lock the
                // user out. Join listen-only: they still hear everyone + chat, and can retry the mic.
                const micOk = await initLocalMedia();
                micUnavailable = !micOk;

                await setupDevice(msg.routerRtpCapabilities);
                await createSendTransport();
                await createRecvTransport();
                if (!inLimbo && micOk) await produceAudio();

                if (!inLimbo) for (const { producerId, username, kind, appData } of msg.existingProducers) {
                    const chId = appData?.channelId || 'lobby';
                    if (appData?.type === 'screen-audio') {
                        screenAudioRegistry.set(username, { producerId, channelId: chId, appData: appData || {} });
                        continue;
                    }
                    if (kind === 'video') {
                        streamRegistry.set(producerId, { username, channelId: chId, kind, type: appData?.type || 'screen' });
                        streamingUsers.add(username);
                    }
                    await consumeProducer(producerId, username, kind, chId, appData || {});
                }

                updateUsersList();
                if (inLimbo) {
                    enterLimboUI();
                } else {
                    exitLimboUI();
                    updateTextChatHeader('lobby');
                    loadChannelHistory('lobby');
                }
                stopOnlinePolling();
                joinScreen.classList.remove('screen-active');
                roomScreen.classList.add('screen-active');
                showWhatsNewIfNeeded();
                if (micUnavailable) enterNoMicUI();   // listen-only banner + mic-button retry

                if (msg.mapPositions) window.weaveMap?.onInitialPositions(msg.mapPositions);
                break;
            }

            case 'user_joined':
                if (msg.username !== myUsername && !connectedUsers.includes(msg.username)) {
                    connectedUsers.push(msg.username);
                    userChannels.set(msg.username, 'lobby');
                    if (msg.profile_picture) userProfiles.set(msg.username, msg.profile_picture);
                    userMuteStates.set(msg.username, !!msg.muted);
                    updateUsersList();
                    clientLog('USER_JOINED', msg.username);
                }
                break;

            case 'user_left': {
                connectedUsers = connectedUsers.filter(u => u !== msg.username);
                userChannels.delete(msg.username);
                userMuteStates.delete(msg.username);
                streamingUsers.delete(msg.username);
                screenAudioRegistry.delete(msg.username);
                if (activeStreamWatch?.username === msg.username) stopWatchingStream();
                updateUsersList();
                stopVAD(msg.username);
                window.weaveMap?.onPeerLeft(msg.username);
                for (const [pid, entry] of consumers) {
                    if (entry.username === msg.username) {
                        try { entry.consumer.close(); } catch (_) {}
                        consumers.delete(pid);
                    }
                }
                clientLog('USER_LEFT', msg.username);
                break;
            }

            case 'user_muted_changed':
                userMuteStates.set(msg.username, !!msg.muted);
                updateUsersList();
                break;

            case 'persona_sound': {
                if (msg.sound) {
                    const parts = msg.sound.split('/');
                    const encoded = parts.map(encodeURIComponent).join('/');
                    const audio = new Audio(`/assets/sounds/${encoded}`);
                    audio.play().catch(() => {});
                }
                break;
            }


            case 'newProducer': {
                const channelId = msg.channelId || msg.appData?.channelId || 'lobby';
                if (msg.appData?.type === 'screen-audio') {
                    screenAudioRegistry.set(msg.username, { producerId: msg.producerId, channelId, appData: msg.appData });
                    if (activeStreamWatch?.username === msg.username) {
                        await consumeProducer(msg.producerId, msg.username, 'audio', channelId, msg.appData);
                        activeStreamWatch = { ...activeStreamWatch, screenAudioProducerId: msg.producerId };
                    }
                    break;
                }
                if (msg.kind === 'video') {
                    streamRegistry.set(msg.producerId, { username: msg.username, channelId, kind: msg.kind, type: msg.appData?.type || 'screen' });
                    streamingUsers.add(msg.username);
                    playSound('stream_start');
                    updateUsersList();
                    window.weaveMap?.onNewStream(msg.producerId, msg.username, channelId);
                }
                await consumeProducer(msg.producerId, msg.username, msg.kind, channelId, msg.appData || {});
                break;
            }

            case 'channelProducers': {
                for (const { producerId, username, kind, channelId, appData } of msg.producers) {
                    if (consumers.has(producerId)) continue;
                    if (appData?.type === 'screen-audio') {
                        screenAudioRegistry.set(username, { producerId, channelId, appData: appData || {} });
                        if (activeStreamWatch?.username === username) {
                            await consumeProducer(producerId, username, 'audio', channelId, appData || {});
                            activeStreamWatch = { ...activeStreamWatch, screenAudioProducerId: producerId };
                        }
                        continue;
                    }
                    if (kind === 'video') {
                        streamRegistry.set(producerId, { username, channelId, kind, type: appData?.type || 'screen' });
                        streamingUsers.add(username);
                    }
                    await consumeProducer(producerId, username, kind, channelId, appData || {});
                }
                updateUsersList();
                break;
            }

            case 'producerUnavailable': {
                const wasStream = streamRegistry.has(msg.producerId);
                const entry = consumers.get(msg.producerId);
                if (entry) {
                    try { entry.consumer.close(); } catch (_) {}
                    consumers.delete(msg.producerId);
                    if (entry.isScreenAudio) {
                        screenAudioRegistry.delete(entry.username);
                        streamAudioContainer.querySelectorAll(`[data-pid="${msg.producerId}"]`).forEach(stopAndRemoveAudioEl);
                        if (activeStreamWatch?.screenAudioProducerId === msg.producerId) {
                            activeStreamWatch = { ...activeStreamWatch, screenAudioProducerId: null };
                        }
                    } else {
                        audioContainer.querySelectorAll(`[data-pid="${msg.producerId}"]`).forEach(stopAndRemoveAudioEl);
                        stopVAD(entry.username);
                    }
                } else {
                    for (const [uname, info] of screenAudioRegistry) {
                        if (info.producerId === msg.producerId) { screenAudioRegistry.delete(uname); break; }
                    }
                }
                streamRegistry.delete(msg.producerId);
                if (wasStream) playSound('stream_end');
                break;
            }

            case 'producerClosed': {
                const entry = consumers.get(msg.producerId);
                if (entry) {
                    try { entry.consumer.close(); } catch (_) {}
                    consumers.delete(msg.producerId);
                    if (entry.kind === 'video') {
                        streamRegistry.delete(msg.producerId);
                        streamingUsers.delete(entry.username);
                        playSound('stream_end');
                        if (activeStreamWatch?.producerId === msg.producerId) stopWatchingStream();
                        updateUsersList();
                        window.weaveMap?.onStreamClosed(msg.producerId);
                    } else if (entry.kind === 'audio') {
                        if (entry.isScreenAudio) {
                            screenAudioRegistry.delete(entry.username);
                            streamAudioContainer.querySelectorAll(`[data-pid="${msg.producerId}"]`).forEach(stopAndRemoveAudioEl);
                            if (activeStreamWatch?.screenAudioProducerId === msg.producerId) {
                                activeStreamWatch = { ...activeStreamWatch, screenAudioProducerId: null };
                            }
                        } else {
                            audioContainer.querySelectorAll(`[data-pid="${msg.producerId}"]`).forEach(stopAndRemoveAudioEl);
                            stopVAD(entry.username);
                        }
                    }
                } else {
                    for (const [uname, info] of screenAudioRegistry) {
                        if (info.producerId === msg.producerId) { screenAudioRegistry.delete(uname); break; }
                    }
                }
                break;
            }

            case 'text_message': {
                chanMsgTimes.push(Date.now());   // feeds the channel-weave message-rate noise
                if (msg.username !== myUsername) playSound('new_text');
                const ts  = msg.ts ? new Date(msg.ts) : new Date();
                const day = ts.toDateString();
                if (day !== chatLastDay) { appendDaySeparator(ts); chatLastDay = day; chatLastAuthor = null; }
                const grouped = msg.username === chatLastAuthor && msg.ts - chatLastTs < 300000;
                appendTextMessage({ username: msg.username, text: msg.text, ts, isMe: msg.username === myUsername, grouped });
                chatLastAuthor = msg.username;
                chatLastTs     = msg.ts || Date.now();
                break;
            }

            case 'transportCreated':
                resolveMessage(`transportCreated_${msg.direction}`, msg);
                break;
            case 'transportConnected':
                resolveMessage(`transportConnected_${msg.direction}`, msg);
                break;
            case 'produced':
                resolveMessage(`produced_${msg.kind}`, msg);
                break;
            case 'consumed':
                resolveMessage(`consumed_${msg.producerId}`, msg);
                break;

            case 'join_rejected':
                clientError('JOIN_REJECTED', msg.reason);
                if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
                teardownMicGate();
                // If we were in the room (token expired on reconnect), go back to login screen
                if (joined) {
                    joined = false;
                    resetSFUState();
                    roomScreen.classList.remove('screen-active');
                    joinScreen.classList.add('screen-active');
                    showLoginPanel();
                }
                loginBtn.disabled = false;
                loginBtn.querySelector('span').textContent = 'Login';
                showLoginError(msg.reason || 'Join failed. Please log in again.');
                break;
        }
    };

    ws.onclose = () => {
        if (reconnectTimer) return;
        clientLog('WS_CLOSED', `attempt ${reconnectAttempts + 1}/${MAX_RECONNECT}`);
        if (joined && reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts++;
            reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, reconnectAttempts * 2000);
        }
    };

    ws.onerror = err => clientError('WS_ERROR', err);
}

// ===== CONTROLS =====

async function fetchOnlineUsers() {
    try {
        const res = await fetch('/api/users');
        const { users } = await res.json();
        const list  = document.getElementById('onlineUsersList');
        const count = document.getElementById('onlineCount');
        if (!list) return;
        count.textContent = users.length;
        if (users.length === 0) {
            list.innerHTML = '<p class="online-empty">No one yet</p>';
            return;
        }
        list.innerHTML = users.map(u => {
            const pic = u.profile_picture;
            let avatarHtml;
            if (pic && pic.startsWith('data:image')) {
                avatarHtml = `<div class="avatar avatar-img"><img src="${pic}" alt="${u.username[0].toUpperCase()}" /></div>`;
            } else if (pic) {
                avatarHtml = `<div class="avatar avatar-emoji">${pic}</div>`;
            } else {
                const initials = u.username.slice(0, 2).toUpperCase();
                const hue = [...u.username].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
                avatarHtml = `<div class="avatar" style="background:hsl(${hue},55%,40%)">${initials}</div>`;
            }
            return `<div class="online-user-item">${avatarHtml}<span>${u.username}</span></div>`;
        }).join('');
    } catch { /* server unreachable — fail silently */ }
}

const ONLINE_POLL_INTERVAL = 5000;
const ONLINE_POLL_TIMEOUT  = 60000;

function startOnlinePolling() {
    fetchOnlineUsers();
    onlinePollTimer = setInterval(fetchOnlineUsers, ONLINE_POLL_INTERVAL);
    setTimeout(stopOnlinePolling, ONLINE_POLL_TIMEOUT);
}

function stopOnlinePolling() {
    clearInterval(onlinePollTimer);
    onlinePollTimer = null;
}

// Upload a bug report (browser console + server log) to the Pi.
// Server enforces a hard 2-hour cooldown per Full Name; this client lock just
// prevents double-clicks within the page session.
async function submitBugReport() {
    if (bugReportSubmitted) return;
    const btn = document.getElementById('saveLogsBtn');
    if (!joinToken) { setBugBtnLabel('Log in first'); return; }

    const sep = '='.repeat(64);
    let browser_log = [sep, 'BROWSER CONSOLE LOG', `User: ${myUsername || 'unknown'}`, sep, logBuffer.join('\n')].join('\n');
    if (browser_log.length > 800_000) browser_log = '(…truncated, last 800KB)\n' + browser_log.slice(-800_000);

    setBugBtnLabel('Submitting…');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/bug-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinToken}` },
            body: JSON.stringify({ browser_log }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
            bugReportSubmitted = true;
            setBugBtnLabel('Report sent ✔');
            clientLog('BUG_REPORT_SENT', data.filename || '');
        } else if (res.status === 429) {
            bugReportSubmitted = true;
            setBugBtnLabel(`Wait ${fmtCooldown(data.retryAfterMs)}`);
        } else {
            setBugBtnLabel('Failed — retry');
            if (btn) btn.disabled = false;
        }
    } catch (e) {
        clientError('BUG_REPORT', e);
        setBugBtnLabel('Failed — retry');
        if (btn) btn.disabled = false;
    }
}

function setBugBtnLabel(t) {
    const l = document.getElementById('saveLogsBtn')?.querySelector('.label');
    if (l) l.textContent = t;
}

function fmtCooldown(ms) {
    const m = Math.ceil((ms || 0) / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function toggleMute() {
    if (!localStream) { retryMic(); return; }   // no mic (listen-only) → the button retries the mic
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    if (audioProducer && !audioProducer.closed) {
        isMuted ? audioProducer.pause() : audioProducer.resume();
    }
    muteBtn.classList.toggle('active', isMuted);
    const label = muteBtn.querySelector('.label');
    if (label) label.textContent = isMuted ? 'Unmute' : 'Mute';
    clientLog('MUTE_TOGGLE', isMuted ? 'MUTED' : 'UNMUTED');
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'mute_changed', muted: isMuted }));
}

async function startScreenShare() {
    clientLog('SCREEN_START_REQUEST');
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            // Capture system/tab audio raw. These voice-oriented filters wreck music/game
            // audio — autoGainControl in particular causes the slow volume pumping.
            audio: {
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false,
                channelCount: 2,
            },
        });
        // Screen captured — now safe to drop webcam (mutually exclusive)
        if (isWebcamOn) stopWebcam();
        const videoTrack = screenStream.getVideoTracks()[0];
        const channelId = window.weaveMap?._engine?.getCurrentChannelId() ?? (userChannels.get(myUsername) || 'lobby');
        videoProducer = await sendTransport.produce({ track: videoTrack, appData: { type: 'screen', channelId } });

        const audioTrack = screenStream.getAudioTracks()[0];
        if (audioTrack) {
            screenAudioProducer = await sendTransport.produce({
                track: audioTrack,
                // Music/system audio: stereo, full bitrate, FEC for loss resilience, no DTX
                // (DTX gates "silence" and hurts sustained/ambient audio).
                codecOptions: {
                    opusStereo: true,
                    opusFec: true,
                    opusDtx: false,
                    opusMaxAverageBitrate: 128000,
                },
                appData: { type: 'screen-audio', channelId },
            });
            clientLog('SCREEN_AUDIO_PRODUCING', screenAudioProducer.id);
        } else {
            clientLog('SCREEN_NO_AUDIO', 'browser provided no audio track');
            showToast(
                'No audio captured',
                'To share audio, choose <strong>Entire Screen</strong> and enable <strong>Share system audio</strong>, or share a <strong>Chrome tab</strong> with "Share tab audio" checked.',
                6000
            );
        }

        isScreenSharing = true;
        screenShareBtn.classList.add('active');
        const label = screenShareBtn.querySelector('.label');
        if (label) label.textContent = 'Stop Sharing';
        videoTrack.onended = () => stopScreenShare(true);
        clientLog('SCREEN_SHARING', videoProducer.id);
    } catch (err) {
        clientError('SCREEN_SHARE_FAILED', err);
    }
}

function stopScreenShare(fromBrowser = false) {
    clientLog('SCREEN_STOP', fromBrowser ? '(browser ended)' : '');
    if (videoProducer && !videoProducer.closed) {
        videoProducer.close();
        sendWS({ type: 'closeProducer', kind: 'video' });
        videoProducer = null;
    }
    if (screenAudioProducer && !screenAudioProducer.closed) {
        screenAudioProducer.close();
        sendWS({ type: 'closeProducer', kind: 'screen-audio' });
        screenAudioProducer = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    isScreenSharing = false;
    screenShareBtn.classList.remove('active');
    const label = screenShareBtn.querySelector('.label');
    if (label) label.textContent = 'Share Screen';
}

// ===== WEBCAM =====
async function startWebcam() {
    clientLog('WEBCAM_START_REQUEST');
    try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: camFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,   // mic voice producer already carries audio
        });
        // Camera acquired — now safe to drop screen share (mutually exclusive)
        if (isScreenSharing) stopScreenShare();
        const videoTrack = webcamStream.getVideoTracks()[0];
        const channelId = window.weaveMap?._engine?.getCurrentChannelId() ?? (userChannels.get(myUsername) || 'lobby');
        videoProducer = await sendTransport.produce({ track: videoTrack, appData: { type: 'webcam', channelId } });

        isWebcamOn = true;
        webcamBtn?.classList.add('active');
        const label = webcamBtn?.querySelector('.label');
        if (label) label.textContent = 'Stop Camera';

        if (selfViewVideo) selfViewVideo.srcObject = webcamStream;
        selfView?.classList.add('visible');

        videoTrack.onended = () => stopWebcam();
        clientLog('WEBCAM_ON', videoProducer.id);
    } catch (err) {
        clientError('WEBCAM_FAILED', err);
        showToast(
            'Camera unavailable',
            'Weave could not access your camera. Check that you granted permission and no other app is using it.',
            6000
        );
    }
}

function stopWebcam() {
    clientLog('WEBCAM_STOP');
    if (videoProducer && !videoProducer.closed) {
        videoProducer.close();
        sendWS({ type: 'closeProducer', kind: 'video' });
        videoProducer = null;
    }
    if (webcamStream) {
        webcamStream.getTracks().forEach(t => t.stop());
        webcamStream = null;
    }
    isWebcamOn = false;
    webcamBtn?.classList.remove('active');
    const label = webcamBtn?.querySelector('.label');
    if (label) label.textContent = 'Camera';
    if (selfViewVideo) selfViewVideo.srcObject = null;
    selfView?.classList.remove('visible');
}

async function flipCamera() {
    if (!isWebcamOn || !videoProducer) return;
    camFacingMode = camFacingMode === 'user' ? 'environment' : 'user';
    clientLog('WEBCAM_FLIP', camFacingMode);
    try {
        if (webcamStream) webcamStream.getTracks().forEach(t => t.stop());
        webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: camFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
        });
        const videoTrack = webcamStream.getVideoTracks()[0];
        await videoProducer.replaceTrack({ track: videoTrack });
        if (selfViewVideo) selfViewVideo.srcObject = webcamStream;
        videoTrack.onended = () => stopWebcam();
    } catch (err) {
        clientError('WEBCAM_FLIP_FAILED', err);
    }
}

function leaveRoom() {
    clientLog('LEAVE_ROOM');
    // Best-effort: revoke the join token server-side so it can't be reused after leaving.
    if (joinToken) {
        fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${joinToken}` } }).catch(() => {});
    }
    window._stopMapSpeech?.();
    window.weaveMap?.destroy();
    window._resetMap?.();
    joined = false;

    try { if (audioProducer) audioProducer.close(); } catch (_) {}
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    teardownMicGate();
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }

    resetSFUState();

    loomRenderer?.stop();
    channelWeave?.stop();
    voiceMeters.forEach((_, username) => stopVAD(username));
    audioContainer.querySelectorAll('audio').forEach(stopAndRemoveAudioEl);
    streamAudioContainer.querySelectorAll('audio').forEach(stopAndRemoveAudioEl);
    audioContainer.innerHTML = '';
    streamAudioContainer.innerHTML = '';

    if (ws) { ws.close(); ws = null; }

    connectedUsers = [];
    streamingUsers.clear();
    screenAudioRegistry.clear();
    userMuteStates.clear();
    stopWatchingStream();
    bugReportSubmitted = false;
    isMuted = false;
    isScreenSharing = false;
    isWebcamOn = false;
    webcamBtn?.classList.remove('active');
    const webcamLabel = webcamBtn?.querySelector('.label');
    if (webcamLabel) webcamLabel.textContent = 'Camera';
    selfView?.classList.remove('visible');
    if (selfViewVideo) selfViewVideo.srcObject = null;
    joinToken = null;
    myUsername = null;
    isAdminUser = false;
    if (adminPanelOpen) {
        adminPanelOpen = false;
        adminPanel.classList.remove('screen-active');
    }

    muteBtn.classList.remove('active');
    const muteLabel = muteBtn.querySelector('.label');
    if (muteLabel) muteLabel.textContent = 'Mute';
    screenShareBtn.classList.remove('active');
    const screenLabel = screenShareBtn.querySelector('.label');
    if (screenLabel) screenLabel.textContent = 'Share Screen';

    chatLastAuthor = null;
    chatLastTs     = 0;
    chatLastDay    = null;
    if (textChatMessages) {
        textChatMessages.innerHTML = '<p class="text-chat-placeholder">No messages yet.</p>';
    }
    updateTextChatHeader('lobby');

    roomScreen.classList.remove('screen-active');
    joinScreen.classList.add('screen-active');
    showLoginPanel();
    startOnlinePolling();
}

// ===== WINDOW.WEAVE — Map module hooks =====
window.weave = {
    localChannelChange(channelId) {
        if (!joined) return;
        userChannels.set(myUsername, channelId);
        for (const [producerId, entry] of consumers) {
            if (entry.kind !== 'audio') continue;
            try { entry.consumer.close(); } catch (_) {}
            consumers.delete(producerId);
            const container = entry.isScreenAudio ? streamAudioContainer : audioContainer;
            const audioEl = container.querySelector(`[data-pid="${producerId}"]`);
            if (audioEl) audioEl.remove();
            if (!entry.isScreenAudio) stopVAD(entry.username);
        }
        updateUsersList();
        updateTextChatHeader(channelId);
        loadChannelHistory(channelId);
        clientLog('MAP_CHANNEL', channelId);
    },

    async consumeStream(producerId) {
        if (!recvTransport || !device) return null;
        if (consumers.has(producerId)) {
            const entry = consumers.get(producerId);
            return new MediaStream([entry.consumer.track]);
        }
        try {
            sendWS({ type: 'consume', producerId, rtpCapabilities: device.rtpCapabilities });
            const data = await waitForMessage(`consumed_${producerId}`);
            const consumer = await recvTransport.consume({
                id: data.id, producerId, kind: data.kind, rtpParameters: data.rtpParameters,
            });
            consumers.set(producerId, { consumer, username: streamRegistry.get(producerId)?.username || '', kind: 'video' });
            sendWS({ type: 'resumeConsumer', producerId });
            return new MediaStream([consumer.track]);
        } catch (e) {
            clientError('STREAM_CONSUME_FAILED', e);
            return null;
        }
    },

    getActiveStreams(channelId) {
        const result = [];
        for (const [producerId, info] of streamRegistry) {
            if (info.channelId === channelId) result.push({ producerId, username: info.username });
        }
        return result;
    },

    joinChannel: null,
};

window.weave.joinChannel = joinChannelStandard;
window.weave.stopWatchingStream = stopWatchingStream;
window.weave.toggleWebcam = () => isWebcamOn ? stopWebcam() : startWebcam();
window.weave.flipCamera = flipCamera;
window.toggleStreamFullscreen = toggleStreamFullscreen;

// ===== IMAGE RESIZE (client-side, square crop at 128px) =====
function resizeImage(file) {
    return new Promise((resolve, reject) => {
        const MAX = 128;
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const side = Math.min(img.width, img.height);
            const sx   = (img.width  - side) / 2;
            const sy   = (img.height - side) / 2;
            const canvas = document.createElement('canvas');
            canvas.width  = MAX;
            canvas.height = MAX;
            canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, MAX, MAX);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = reject;
        img.src = url;
    });
}

// ===== CHANNEL HISTORY =====
async function loadChannelHistory(channelId) {
    if (!joinToken) return;
    chatChannelId   = channelId;
    chatOldestRowid = null;
    chatHasMore     = false;
    textChatMessages.innerHTML = '<p class="text-chat-placeholder">Loading…</p>';
    chatLastAuthor = null;
    chatLastTs     = 0;
    chatLastDay    = null;
    // Private channels are ephemeral — no persisted history to fetch or page through.
    if (isPrivateChannel(channelId)) {
        textChatMessages.innerHTML = '<p class="text-chat-placeholder">Private channel — messages vanish when it closes.</p>';
        return;
    }
    try {
        const res = await fetch(`/api/messages/${encodeURIComponent(channelId)}?limit=15`,
            { headers: { Authorization: `Bearer ${joinToken}` } });
        const data = await res.json();
        if (chatChannelId !== channelId) return;   // channel switched mid-fetch
        textChatMessages.innerHTML = '';
        const msgs = data.messages || [];
        if (!msgs.length) {
            textChatMessages.innerHTML = '<p class="text-chat-placeholder">No messages yet.</p>';
            return;
        }
        chatOldestRowid = msgs[0].rowid;
        chatHasMore     = msgs.length >= 15;
        if (chatHasMore) renderShowMoreButton();
        for (const m of msgs) {
            const ts  = new Date(m.created_at);
            const day = ts.toDateString();
            if (day !== chatLastDay) {
                appendDaySeparator(ts);
                chatLastDay    = day;
                chatLastAuthor = null;
            }
            const grouped = m.nick_name === chatLastAuthor && (ts - chatLastTs) < 300000;
            if (m.nick_name && !userProfiles.has(m.nick_name) && m.profile_picture) {
                userProfiles.set(m.nick_name, m.profile_picture);
            }
            appendTextMessage({ username: m.nick_name, text: m.content, ts, isMe: m.nick_name === myUsername, grouped });
            chatLastAuthor = m.nick_name;
            chatLastTs     = ts;
        }
        textChatMessages.scrollTop = textChatMessages.scrollHeight;
    } catch (e) { clientError('LOAD_HISTORY', e); }
}

function renderShowMoreButton() {
    if (!textChatMessages || textChatMessages.querySelector('.chat-show-more')) return;
    const btn = document.createElement('button');
    btn.className = 'chat-show-more';
    btn.textContent = 'Show older messages';
    btn.addEventListener('click', loadOlderMessages);
    textChatMessages.insertBefore(btn, textChatMessages.firstChild);
}

// Prepend the previous 15 messages above the current ones, preserving scroll position.
async function loadOlderMessages() {
    if (!joinToken || chatLoadingOlder || chatOldestRowid == null || !chatChannelId) return;
    chatLoadingOlder = true;
    const channelId = chatChannelId;
    const btn = textChatMessages.querySelector('.chat-show-more');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    const prevH = textChatMessages.scrollHeight, prevTop = textChatMessages.scrollTop;
    try {
        const res = await fetch(`/api/messages/${encodeURIComponent(channelId)}?limit=15&before=${chatOldestRowid}`,
            { headers: { Authorization: `Bearer ${joinToken}` } });
        const data = await res.json();
        if (chatChannelId !== channelId) return;
        const msgs = data.messages || [];

        const frag = document.createDocumentFragment();
        let lAuthor = null, lTs = 0, lDay = null;
        for (const m of msgs) {
            const ts  = new Date(m.created_at);
            const day = ts.toDateString();
            if (day !== lDay) { frag.appendChild(buildDaySeparator(ts)); lDay = day; lAuthor = null; }
            const grouped = m.nick_name === lAuthor && (ts - lTs) < 300000;
            if (m.nick_name && !userProfiles.has(m.nick_name) && m.profile_picture) {
                userProfiles.set(m.nick_name, m.profile_picture);
            }
            frag.appendChild(buildMessageEl({ username: m.nick_name, text: m.content, ts, isMe: m.nick_name === myUsername, grouped }));
            lAuthor = m.nick_name; lTs = ts;
        }

        chatHasMore     = msgs.length >= 15;
        chatOldestRowid = msgs.length ? msgs[0].rowid : chatOldestRowid;

        if (btn) btn.remove();
        const existingFirstSep = textChatMessages.querySelector('.chat-day-sep');
        textChatMessages.insertBefore(frag, textChatMessages.firstChild);
        // Drop a duplicate day separator at the boundary (older block ended on the same day).
        if (existingFirstSep && existingFirstSep.dataset.day === lDay) existingFirstSep.remove();
        if (chatHasMore) renderShowMoreButton();

        textChatMessages.scrollTop = textChatMessages.scrollHeight - prevH + prevTop;
    } catch (e) {
        clientError('LOAD_OLDER', e);
        if (btn) { btn.disabled = false; btn.textContent = 'Show older messages'; }
    } finally {
        chatLoadingOlder = false;
    }
}

// ===== ADMIN PANEL =====

async function adminFetch(path, method = 'GET', body = null) {
    const opts = { method, headers: { Authorization: `Bearer ${joinToken}` } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    return r.json();
}

function toggleAdminPanel() {
    adminPanelOpen = !adminPanelOpen;
    if (adminPanelOpen) {
        roomScreen.classList.remove('screen-active');
        adminPanel.classList.add('screen-active');
        loadAdminSection('db');
    } else {
        adminPanel.classList.remove('screen-active');
        roomScreen.classList.add('screen-active');
    }
}

async function loadAdminSection(section) {
    document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('adminTableList').style.display = 'none';
    document.getElementById('adminTableView').style.display = 'none';
    document.getElementById('adminConfigView').style.display = 'none';
    document.getElementById('adminBirthdayView').style.display = 'none';

    if (section === 'config') {
        document.getElementById('adminNavConfig').classList.add('active');
        document.getElementById('adminConfigView').style.display = '';
        loadConfigPanel();
        return;
    }

    if (section === 'birthday') {
        document.getElementById('adminNavBirthday').classList.add('active');
        document.getElementById('adminBirthdayView').style.display = '';
        loadBirthdayPanel();
        return;
    }

    // section === 'db'
    document.getElementById('adminNavDb').classList.add('active');
    const tableList = document.getElementById('adminTableList');
    const tableView = document.getElementById('adminTableView');
    tableList.innerHTML = '';
    tableList.style.display = 'flex';
    adminCurrentTable = null;
    adminSelectedId = null;
    adminCheckedIds.clear();
    adminEditMode = false;
    try {
        const data = await adminFetch('/api/admin/tables');
        for (const name of (data.tables || [])) {
            const btn = document.createElement('button');
            btn.className = 'admin-table-chip';
            btn.textContent = name;
            btn.addEventListener('click', () => loadAdminTable(name));
            tableList.appendChild(btn);
        }
    } catch (e) { clientError('ADMIN_LOAD_TABLES', e); }
}

// ===== ADMIN CONFIG PANEL =====
let _allConfigSounds = [];
let _joinTagInput = null;
let _leaveTagInput = null;

function createTagInput(prefix) {
    const tagsEl    = document.getElementById(`${prefix}SoundsTags`);
    const fieldEl   = document.getElementById(`${prefix}SoundsField`);
    const dropdownEl = document.getElementById(`${prefix}SoundsDropdown`);
    const selected  = new Set();

    function playPreview(value) {
        const parts = value.split('/');
        const encoded = parts.map(encodeURIComponent).join('/');
        new Audio(`/assets/sounds/${encoded}`).play().catch(() => {});
    }

    function renderTags() {
        tagsEl.innerHTML = '';
        for (const value of selected) {
            const item = _allConfigSounds.find(s => s.value === value);
            const label = item ? item.label : value;
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML =
                `<span class="tag-chip-label">${escapeHtml(label)}</span>` +
                `<button class="tag-chip-preview" title="Preview" data-val="${escapeHtml(value)}">🔊</button>` +
                `<button class="tag-chip-remove" title="Remove" data-val="${escapeHtml(value)}">×</button>`;
            chip.querySelector('.tag-chip-preview').addEventListener('click', e => { e.stopPropagation(); playPreview(e.currentTarget.dataset.val); });
            chip.querySelector('.tag-chip-remove').addEventListener('click', e => { e.stopPropagation(); selected.delete(e.currentTarget.dataset.val); renderTags(); });
            tagsEl.appendChild(chip);
        }
    }

    function renderDropdown(filter) {
        const lc = filter.toLowerCase();
        const matches = _allConfigSounds.filter(s => s.label.toLowerCase().includes(lc));
        if (!matches.length) { dropdownEl.classList.remove('open'); return; }
        dropdownEl.innerHTML = '';
        for (const s of matches) {
            const item = document.createElement('div');
            item.className = 'tag-input-dropdown-item' + (selected.has(s.value) ? ' selected' : '');
            item.innerHTML =
                `<button class="tag-input-dropdown-item-preview" title="Preview" data-val="${escapeHtml(s.value)}">🔊</button>` +
                `<span class="tag-input-dropdown-item-text">${escapeHtml(s.label)}</span>`;
            item.querySelector('.tag-input-dropdown-item-preview').addEventListener('mousedown', e => { e.preventDefault(); playPreview(s.value); });
            item.querySelector('.tag-input-dropdown-item-text').addEventListener('mousedown', e => {
                e.preventDefault();
                if (!selected.has(s.value)) { selected.add(s.value); renderTags(); }
                fieldEl.value = '';
                dropdownEl.classList.remove('open');
            });
            dropdownEl.appendChild(item);
        }
        dropdownEl.classList.add('open');
    }

    fieldEl.addEventListener('input', () => renderDropdown(fieldEl.value));
    fieldEl.addEventListener('focus', () => { if (fieldEl.value) renderDropdown(fieldEl.value); });
    fieldEl.addEventListener('blur', () => setTimeout(() => dropdownEl.classList.remove('open'), 150));

    return {
        getValues() { return [...selected]; },
        setValues(arr) { selected.clear(); for (const v of arr) selected.add(v); renderTags(); },
    };
}

async function loadConfigPanel() {
    const sel = document.getElementById('configUserSelect');
    const saveBtn = document.getElementById('adminConfigSaveBtn');
    const msgEl = document.getElementById('adminConfigMsg');
    saveBtn.disabled = true;
    msgEl.textContent = '';

    try {
        const [usersData, soundsData] = await Promise.all([
            adminFetch('/api/admin/users'),
            adminFetch('/api/admin/sounds/list'),
        ]);
        const users = Array.isArray(usersData) ? usersData : [];
        const { standard = [], configurations = [] } = soundsData || {};
        _allConfigSounds = [
            ...standard.map(f => ({ label: f, value: f })),
            ...configurations.map(f => ({ label: f, value: `configurations/${f}` })),
        ];
        sel.innerHTML = '<option value="">— select a user —</option>' +
            users.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.nick_name)} (${escapeHtml(u.full_name)})</option>`).join('');
    } catch (e) { clientError('ADMIN_CONFIG_LOAD', e); }

    _joinTagInput  = createTagInput('join');
    _leaveTagInput = createTagInput('leave');

    sel.onchange = () => loadUserSoundConfig(sel.value);

    saveBtn.onclick = async () => {
        const userId = sel.value;
        if (!userId) return;
        try {
            const result = await adminFetch('/api/admin/sounds/config', 'POST', {
                user_id: userId,
                join_sounds: _joinTagInput.getValues(),
                leave_sounds: _leaveTagInput.getValues(),
            });
            msgEl.textContent = result.ok ? 'Saved.' : `Error: ${result.error}`;
        } catch (e) { msgEl.textContent = 'Save failed.'; }
    };
}

// ===== ADMIN BIRTHDAY PANEL =====
async function loadBirthdayPanel() {
    const sel = document.getElementById('birthdayUserSelect');
    const saveBtn = document.getElementById('adminBirthdaySaveBtn');
    const removeBtn = document.getElementById('adminBirthdayRemoveBtn');
    const msgEl = document.getElementById('adminBirthdayMsg');
    msgEl.textContent = '';
    try {
        const [usersData, current] = await Promise.all([
            adminFetch('/api/admin/users'),
            adminFetch('/api/admin/birthday-user'),
        ]);
        const users = Array.isArray(usersData) ? usersData : [];
        sel.innerHTML = '<option value="">— none —</option>' +
            users.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.nick_name)} (${escapeHtml(u.full_name)})</option>`).join('');
        if (current?.user_id) sel.value = current.user_id;
    } catch (e) { clientError('ADMIN_BIRTHDAY_LOAD', e); }

    saveBtn.onclick = async () => {
        try {
            const result = await adminFetch('/api/admin/birthday-user', 'POST', { user_id: sel.value || null });
            msgEl.textContent = result.ok ? (sel.value ? 'Birthday user set.' : 'Cleared.') : `Error: ${result.error}`;
        } catch (e) { msgEl.textContent = 'Save failed.'; }
    };

    removeBtn.onclick = async () => {
        try {
            const result = await adminFetch('/api/admin/birthday-user', 'POST', { user_id: null });
            if (result.ok) { sel.value = ''; msgEl.textContent = 'Cleared.'; }
            else msgEl.textContent = `Error: ${result.error}`;
        } catch (e) { msgEl.textContent = 'Remove failed.'; }
    };
}

async function loadUserSoundConfig(userId) {
    if (!userId) return;
    const saveBtn = document.getElementById('adminConfigSaveBtn');
    const msgEl = document.getElementById('adminConfigMsg');
    try {
        const cfg = await adminFetch(`/api/admin/sounds/config?user_id=${encodeURIComponent(userId)}`);
        _joinTagInput.setValues(cfg.join_sounds || []);
        _leaveTagInput.setValues(cfg.leave_sounds || []);
        saveBtn.disabled = false;
        msgEl.textContent = '';
    } catch (e) { clientError('ADMIN_CONFIG_USER', e); }
}

async function loadAdminTable(name) {
    adminCurrentTable = name;
    adminSelectedId = null;
    adminCheckedIds.clear();
    adminEditMode = false;
    document.querySelectorAll('.admin-table-chip').forEach(c => c.classList.toggle('active', c.textContent === name));
    const tableView = document.getElementById('adminTableView');
    tableView.style.display = '';
    document.getElementById('adminEditBtn').disabled = true;
    document.getElementById('adminSaveBtn').style.display = 'none';
    document.getElementById('adminDeleteBtn').disabled = true;
    // Reset-password action is only meaningful on the users table.
    const resetBtn = document.getElementById('adminResetPwBtn');
    resetBtn.style.display = name === 'weave_users' ? '' : 'none';
    resetBtn.disabled = true;
    document.getElementById('adminActionMsg').textContent = '';
    try {
        const data = await adminFetch(`/api/admin/tables/${encodeURIComponent(name)}`);
        adminRecords = data.records || [];
        adminSchema  = adminRecords.length > 0 ? Object.keys(adminRecords[0]) : [];
        renderAdminGrid();
    } catch (e) { clientError('ADMIN_LOAD_TABLE', e); }
}

function renderAdminGrid() {
    const thead = document.getElementById('adminTableHead');
    const tbody = document.getElementById('adminTableBody');
    thead.innerHTML = '<tr><th class="admin-check-col"><input type="checkbox" id="adminSelectAll"></th>'
        + adminSchema.map(k => `<th>${escapeHtml(k)}</th>`).join('') + '</tr>';
    tbody.innerHTML = '';
    for (const row of adminRecords) {
        const tr = document.createElement('tr');
        tr.className = 'admin-row';
        tr.dataset.id = row.id;

        const checkTd = document.createElement('td');
        checkTd.className = 'admin-check-col';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'admin-row-check';
        cb.checked = adminCheckedIds.has(row.id);
        cb.addEventListener('change', () => toggleAdminRowCheck(row.id, cb.checked));
        checkTd.appendChild(cb);
        tr.appendChild(checkTd);

        for (const key of adminSchema) {
            const td = document.createElement('td');
            const val = row[key];
            const display = val === null ? '—' : String(val).length > 40 ? String(val).slice(0, 40) + '…' : String(val);
            td.textContent = display;
            td.dataset.key = key;
            td.dataset.val = val === null ? '' : String(val);
            tr.appendChild(td);
        }

        // Clicking the row body (not the checkbox cell) toggles selection — a larger hit target.
        tr.addEventListener('click', (e) => {
            if (adminEditMode) return;
            if (e.target.closest('.admin-check-col')) return; // checkbox manages itself
            cb.checked = !cb.checked;
            toggleAdminRowCheck(row.id, cb.checked);
        });

        if (adminCheckedIds.has(row.id)) tr.classList.add('selected');
        tbody.appendChild(tr);
    }

    const selectAll = document.getElementById('adminSelectAll');
    if (selectAll) {
        selectAll.checked = adminRecords.length > 0 && adminCheckedIds.size === adminRecords.length;
        selectAll.addEventListener('change', () => {
            if (adminEditMode) { selectAll.checked = !selectAll.checked; return; }
            adminCheckedIds.clear();
            if (selectAll.checked) for (const r of adminRecords) adminCheckedIds.add(r.id);
            renderAdminGrid();
        });
    }

    refreshAdminActionButtons();
}

function toggleAdminRowCheck(id, checked) {
    if (checked) adminCheckedIds.add(id); else adminCheckedIds.delete(id);
    const tr = document.querySelector(`.admin-row[data-id="${id}"]`);
    if (tr) tr.classList.toggle('selected', checked);
    const all = document.getElementById('adminSelectAll');
    if (all) all.checked = adminRecords.length > 0 && adminCheckedIds.size === adminRecords.length;
    refreshAdminActionButtons();
}

function refreshAdminActionButtons() {
    const n = adminCheckedIds.size;
    adminSelectedId = n === 1 ? [...adminCheckedIds][0] : null;
    document.getElementById('adminEditBtn').disabled   = n !== 1 || adminEditMode;
    document.getElementById('adminDeleteBtn').disabled = n === 0 || adminEditMode;
    document.getElementById('adminResetPwBtn').disabled = adminCurrentTable !== 'weave_users' || n !== 1 || adminEditMode;
    const msg = document.getElementById('adminActionMsg');
    if (!adminEditMode && msg && !msg.querySelector('button')) {
        msg.textContent = n > 0 ? `${n} selected` : '';
    }
}

function startEdit() {
    if (!adminSelectedId || adminEditMode) return;
    adminEditMode = true;
    const tr = document.querySelector(`.admin-row[data-id="${adminSelectedId}"]`);
    if (!tr) return;
    for (const td of tr.querySelectorAll('td')) {
        const key = td.dataset.key;
        // checkbox col (no key), id, and nulled-sensitive cols (show as —) are not editable
        if (!key || key === 'id' || td.textContent === '—') continue;
        td.classList.add('admin-cell-edit');
        const input = document.createElement('input');
        input.type  = 'text';
        input.value = td.dataset.val;
        td.textContent = '';
        td.appendChild(input);
    }
    document.getElementById('adminEditBtn').disabled = true;
    document.getElementById('adminSaveBtn').style.display = '';
    document.getElementById('adminCancelBtn').style.display = '';
    document.getElementById('adminDeleteBtn').disabled = true;
    document.getElementById('adminResetPwBtn').disabled = true;
}

function cancelEdit() {
    if (!adminEditMode) return;
    const tr = document.querySelector(`.admin-row[data-id="${adminSelectedId}"]`);
    if (tr) {
        for (const td of tr.querySelectorAll('td.admin-cell-edit')) {
            td.classList.remove('admin-cell-edit');
            const v = td.dataset.val;
            td.textContent = v === '' ? '—' : v.length > 40 ? v.slice(0, 40) + '…' : v;
        }
    }
    adminEditMode = false;
    document.getElementById('adminSaveBtn').style.display = 'none';
    document.getElementById('adminCancelBtn').style.display = 'none';
    document.getElementById('adminEditBtn').disabled = false;
    document.getElementById('adminDeleteBtn').disabled = false;
    document.getElementById('adminActionMsg').textContent = '';
    refreshAdminActionButtons();
}

async function saveEdit() {
    if (!adminSelectedId || !adminEditMode) return;
    const tr = document.querySelector(`.admin-row[data-id="${adminSelectedId}"]`);
    if (!tr) return;
    const fields = {};
    for (const td of tr.querySelectorAll('td.admin-cell-edit')) {
        const input = td.querySelector('input');
        if (input) fields[td.dataset.key] = input.value;
    }
    try {
        const result = await adminFetch(
            `/api/admin/tables/${encodeURIComponent(adminCurrentTable)}/${encodeURIComponent(adminSelectedId)}`,
            'PUT', fields
        );
        if (result.ok) {
            document.getElementById('adminActionMsg').textContent = 'Saved.';
            await loadAdminTable(adminCurrentTable);
        } else {
            document.getElementById('adminActionMsg').textContent = result.error || 'Save failed.';
            adminEditMode = false;
            document.getElementById('adminSaveBtn').style.display = 'none';
            document.getElementById('adminEditBtn').disabled = false;
            document.getElementById('adminDeleteBtn').disabled = false;
        }
    } catch (e) {
        clientError('ADMIN_SAVE', e);
        document.getElementById('adminActionMsg').textContent = 'Network error.';
    }
}

function confirmDelete() {
    if (adminCheckedIds.size === 0 || adminEditMode) return;
    const ids = [...adminCheckedIds];
    const msg = document.getElementById('adminActionMsg');
    const label = ids.length === 1 ? 'this record' : `${ids.length} records`;
    msg.innerHTML = `Delete ${label}? <button id="adminDeleteYes" class="admin-confirm-btn">Yes</button><button id="adminDeleteNo" class="admin-confirm-btn">No</button>`;
    document.getElementById('adminDeleteYes').addEventListener('click', async () => {
        let okCount = 0, failCount = 0;
        for (const id of ids) {
            try {
                const result = await adminFetch(
                    `/api/admin/tables/${encodeURIComponent(adminCurrentTable)}/${encodeURIComponent(id)}`,
                    'DELETE'
                );
                if (result.ok) okCount++; else failCount++;
            } catch (e) {
                clientError('ADMIN_DELETE', e);
                failCount++;
            }
        }
        adminCheckedIds.clear();
        await loadAdminTable(adminCurrentTable);
        msg.textContent = failCount === 0 ? `Deleted ${okCount}.` : `Deleted ${okCount}, ${failCount} failed.`;
    });
    document.getElementById('adminDeleteNo').addEventListener('click', () => { refreshAdminActionButtons(); });
}

// Admin: set a chosen password for the selected user (weave_users only). The user's active
// sessions are invalidated server-side, so they must log in again with the new password.
async function adminResetPassword() {
    if (adminCurrentTable !== 'weave_users' || !adminSelectedId || adminEditMode) return;
    const row = adminRecords.find(r => r.id === adminSelectedId);
    const who = row ? (row.full_name || row.nick_name || adminSelectedId) : adminSelectedId;
    const msg = document.getElementById('adminActionMsg');
    const pw = prompt(`Set a new password for "${who}" (min 8 characters).\nThey will be logged out and must use this password.`);
    if (pw === null) return; // cancelled
    if (pw.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; return; }
    try {
        const result = await adminFetch('/api/admin/reset-password', 'POST', { user_id: adminSelectedId, new_password: pw });
        msg.textContent = result.ok ? `Password reset for ${who}.` : (result.error || 'Reset failed.');
    } catch (e) {
        clientError('ADMIN_RESET_PW', e);
        msg.textContent = 'Network error.';
    }
}

// ===== RESIZABLE CHANNEL-LIST SIDEBAR =====
// Drag the handle on the sidebar's left edge to resize the channel list; the chat reflows to fit.
// Clamped to [MIN, half-screen] so the text chat always keeps room. Width persists per device.
function initSidebarResize() {
    const sidebar = document.querySelector('.users-sidebar');
    const handle = document.getElementById('sidebarResizer');
    if (!sidebar || !handle) return;
    const MIN = 200;
    const maxW = () => Math.floor(window.innerWidth * 0.5);   // never more than half the screen
    const clamp = (w) => Math.max(MIN, Math.min(maxW(), w));

    const saved = parseInt(localStorage.getItem('weave.sidebarWidth') || '', 10);
    if (saved) sidebar.style.width = clamp(saved) + 'px';

    let startX = 0, startW = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        startX = e.clientX;
        startW = sidebar.getBoundingClientRect().width;
        handle.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch {}
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        // sidebar is on the right: dragging the left edge leftward (smaller clientX) widens it
        sidebar.style.width = clamp(startW + (startX - e.clientX)) + 'px';
    });
    const end = (e) => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch {}
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        localStorage.setItem('weave.sidebarWidth', String(Math.round(sidebar.getBoundingClientRect().width)));
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);

    // if the window shrinks, keep the sidebar within half the (new) screen
    window.addEventListener('resize', () => {
        if (!sidebar.style.width) return;
        sidebar.style.width = clamp(sidebar.getBoundingClientRect().width) + 'px';
    });
}

// ===== INIT =====
function init() {
    clientLog('APP_READY', 'Weave SFU client initialized');
    initSounds();
    startOnlinePolling();

    // ── Panel switching ────────────────────────────────────────────────────
    toRegisterLink.addEventListener('click', e => { e.preventDefault(); showRegisterPanel(); });
    toForgotLink.addEventListener('click',   e => { e.preventDefault(); showForgotPanel(); });
    toLoginLink1.addEventListener('click',   e => { e.preventDefault(); showLoginPanel(); });
    toLoginLink2.addEventListener('click',   e => { e.preventDefault(); showLoginPanel(); });

    // ── Avatar upload ──────────────────────────────────────────────────────
    const avatarFileInput = document.getElementById('avatarFileInput');
    const avatarPreview   = document.getElementById('avatarPreview');
    document.getElementById('avatarUploadBtn').addEventListener('click', () => avatarFileInput.click());
    avatarFileInput.addEventListener('change', async () => {
        const file = avatarFileInput.files[0];
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) {
            playSound('error');
            registerError.textContent = 'That image is over 20 MB — try a smaller one. (A profile picture is optional, so you can also just skip it.)';
            registerError.style.display = 'block';
            avatarFileInput.value = '';
            return;
        }
        registerError.style.display = 'none';
        try {
            const dataUrl = await resizeImage(file);
            regAvatar.value = dataUrl;
            avatarPreview.innerHTML = `<img src="${dataUrl}" alt="preview" />`;
            avatarPreview.classList.add('has-image');
        } catch {
            playSound('error');
            // Most common cause: iPhone HEIC/HEIF photos, which browsers can't decode to a canvas.
            registerError.textContent = "Couldn't read that image — iPhone HEIC photos aren't supported. Try a JPG or PNG, or just skip it (a picture is optional).";
            registerError.style.display = 'block';
            avatarFileInput.value = '';
        }
        avatarPreview.classList.remove('field-invalid');
    });

    // Clear the "still required" highlight + message as the user fills each field.
    [regInviteCode, regFullName, regNickName, regPassword, regSecretPhrase].forEach(el => {
        el.addEventListener('input', () => {
            el.classList.remove('field-invalid');
            registerError.style.display = 'none';
        });
    });

    // An invite link (?invite=CODE) pre-fills the code and jumps straight to Register.
    const inviteParam = new URLSearchParams(location.search).get('invite');
    if (inviteParam) {
        regInviteCode.value = inviteParam.trim();
        showRegisterPanel();
    }

    // ── LOGIN FORM ─────────────────────────────────────────────────────────
    const autoJoinLobbyEl = document.getElementById('autoJoinLobby');
    if (autoJoinLobbyEl) autoJoinLobbyEl.checked = loadAutoJoinLobby();

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const full_name = loginFullName.value.trim();
        const password  = loginPassword.value;
        if (!full_name || !password) {
            showLoginError('Both fields are required.');
            return;
        }
        loginError.style.display = 'none';
        loginBtn.disabled = true;
        loginBtn.querySelector('span').textContent = 'Logging in…';
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ full_name, password }),
            });
            const data = await res.json();
            if (!data.ok) {
                // Shake the form inputs
                loginForm.classList.remove('shake');
                void loginForm.offsetWidth; // reflow to re-trigger
                loginForm.classList.add('shake');
                showLoginError('Incorrect like most of your opinions — try again');
                loginBtn.disabled = false;
                loginBtn.querySelector('span').textContent = 'Login';
                return;
            }
            myUsername   = data.nick_name;
            joinToken    = data.token;
            isAdminUser  = !!data.is_admin;
            userProfiles.set(data.nick_name, data.profile_picture);
            micGate = loadMicGate();
            micConstraints = loadMicConstraints();
            applyMicSettingsUI();
            const autoJoin = document.getElementById('autoJoinLobby')?.checked !== false;
            saveAutoJoinLobby(autoJoin);
            landingChannel = autoJoin ? 'lobby' : LIMBO;
            loginBtn.querySelector('span').textContent = 'Connecting…';
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                connectWebSocket();
            } else {
                sendWS({ type: 'join', username: myUsername, token: joinToken, channelId: landingChannel });
            }
        } catch (err) {
            clientError('LOGIN_FAILED', err);
            showLoginError('Could not reach the server. Try again.');
            loginBtn.disabled = false;
            loginBtn.querySelector('span').textContent = 'Login';
        }
    });

    // ── REGISTER FORM ──────────────────────────────────────────────────────
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        // All fields are mandatory — on click, point out exactly what's still missing.
        REGISTER_FIELDS.forEach(f => f.el()?.classList.remove('field-invalid'));
        const problems = registerProblems();
        if (problems.length) {
            playSound('error');
            problems.forEach(f => f.el()?.classList.add('field-invalid'));
            const labels = problems.map(f => f.label);
            registerError.textContent = labels.length === 1
                ? `${labels[0]} is still required.`
                : `Still required: ${labels.join(', ')}.`;
            registerError.style.display = 'block';
            problems[0].el()?.focus();
            return;
        }
        registerBtn.disabled = true;
        registerBtn.textContent = 'Registering…';
        registerError.style.display = 'none';
        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name:       regFullName.value.trim(),
                    nick_name:       regNickName.value.trim(),
                    password:        regPassword.value,
                    profile_picture: regAvatar.value,
                    secret_phrase:   regSecretPhrase.value,
                    invite_code:     regInviteCode.value.trim(),
                    website:         regWebsite.value,   // honeypot — must stay empty
                }),
            });
            const data = await res.json();
            if (!data.ok) {
                playSound('error');
                registerError.textContent = data.error || 'Registration failed. Try again.';
                registerError.style.display = 'block';
                registerBtn.disabled = false;
                registerBtn.textContent = 'Complete';
                return;
            }
            // Show success then smoke-out to login
            const successMsg = document.createElement('div');
            successMsg.className = 'success-message';
            successMsg.textContent = 'Registration complete ✨ Welcome to the crew.';
            registerForm.appendChild(successMsg);
            setTimeout(() => {
                const container = document.querySelector('.join-container');
                container.classList.add('smoke-out');
                container.addEventListener('animationend', () => {
                    container.classList.remove('smoke-out');
                    successMsg.remove();
                    registerForm.reset();
                    regAvatar.value = '';
                    document.getElementById('avatarPreview').innerHTML = '<span class="avatar-upload-placeholder">?</span>';
                    document.getElementById('avatarPreview').classList.remove('has-image');
                    REGISTER_FIELDS.forEach(f => f.el()?.classList.remove('field-invalid'));
                    registerBtn.disabled = false;
                    registerBtn.textContent = 'Complete';
                    showLoginPanel();
                }, { once: true });
            }, 1400);
        } catch (err) {
            clientError('REGISTER_FAILED', err);
            playSound('error');
            registerError.textContent = 'Could not reach the server. Try again.';
            registerError.style.display = 'block';
            registerBtn.disabled = false;
            registerBtn.textContent = 'Complete';
        }
    });

    // ── FORGOT FORM ────────────────────────────────────────────────────────
    forgotForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        forgotError.style.display = 'none';
        forgotVerifyBtn.disabled = true;
        forgotVerifyBtn.querySelector('span').textContent = 'Verifying…';
        try {
            const res = await fetch('/api/auth/forgot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name:     forgotFullName.value.trim(),
                    secret_phrase: forgotSecretPhrase.value,
                }),
            });
            const data = await res.json();
            if (!data.ok) {
                playSound('error');
                forgotError.textContent = '… Oh my god — dude.. Comon.';
                forgotError.style.display = 'block';
                forgotForm.classList.remove('shake');
                void forgotForm.offsetWidth;
                forgotForm.classList.add('shake');
                forgotVerifyBtn.disabled = false;
                forgotVerifyBtn.querySelector('span').textContent = 'Verify';
                return;
            }
            currentResetToken = data.reset_token;
            forgotVerifyStep.style.display = 'none';
            forgotResetStep.style.display = '';
        } catch (err) {
            clientError('FORGOT_FAILED', err);
            playSound('error');
            forgotError.textContent = 'Could not reach the server.';
            forgotError.style.display = 'block';
            forgotVerifyBtn.disabled = false;
            forgotVerifyBtn.querySelector('span').textContent = 'Verify';
        }
    });

    // ── RESET FORM ─────────────────────────────────────────────────────────
    resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const new_password = newPasswordInput.value;
        const new_secret_phrase = newSecretPhraseInput?.value?.trim() ?? '';
        if (new_password.length < 8) {
            playSound('error');
            resetError.textContent = 'Password must be at least 8 characters.';
            resetError.style.display = 'block';
            return;
        }
        if (!new_secret_phrase) {
            playSound('error');
            resetError.textContent = 'Please set a new secret phrase.';
            resetError.style.display = 'block';
            return;
        }
        resetBtn.disabled = true;
        resetBtn.textContent = 'Resetting…';
        resetError.style.display = 'none';
        try {
            const res = await fetch('/api/auth/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reset_token: currentResetToken, new_password, new_secret_phrase }),
            });
            const data = await res.json();
            if (!data.ok) {
                playSound('error');
                resetError.textContent = data.error || 'Reset failed. Try the forgot flow again.';
                resetError.style.display = 'block';
                resetBtn.disabled = false;
                resetBtn.textContent = 'Reset Password';
                return;
            }
            const successMsg = document.createElement('div');
            successMsg.className = 'success-message';
            successMsg.textContent = 'Password & secret updated ✔ You can log in now.';
            resetForm.appendChild(successMsg);
            setTimeout(() => {
                successMsg.remove();
                resetForm.reset();
                resetBtn.disabled = false;
                resetBtn.textContent = 'Reset Password & Secret';
                currentResetToken = null;
                showLoginPanel();
            }, 1500);
        } catch (err) {
            clientError('RESET_FAILED', err);
            playSound('error');
            resetError.textContent = 'Could not reach the server.';
            resetError.style.display = 'block';
            resetBtn.disabled = false;
            resetBtn.textContent = 'Reset Password';
        }
    });

    // ── ROOM CONTROLS ──────────────────────────────────────────────────────
    muteBtn.addEventListener('click', toggleMute);
    document.getElementById('saveLogsBtn')?.addEventListener('click', () => submitBugReport());

    screenShareBtn.addEventListener('click', () => {
        isScreenSharing ? stopScreenShare() : startScreenShare();
    });

    webcamBtn?.addEventListener('click', () => {
        isWebcamOn ? stopWebcam() : startWebcam();
    });
    document.getElementById('flipCamBtn')?.addEventListener('click', flipCamera);

    leaveBtn.addEventListener('click', leaveRoom);

    textChatSend?.addEventListener('click', sendTextMessage);
    textChatInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
    });
    textChatInput?.addEventListener('paste', e => {
        for (const it of Array.from(e.clipboardData?.items || [])) {
            if (it.type && it.type.startsWith('image/')) {
                e.preventDefault();
                const file = it.getAsFile();
                if (file) handleImageSend(file);
                return;
            }
        }
    });

    const chatAttachBtn  = document.getElementById('chatAttachBtn');
    const chatImageInput = document.getElementById('chatImageInput');
    chatAttachBtn?.addEventListener('click', () => chatImageInput?.click());
    chatImageInput?.addEventListener('change', () => {
        const file = chatImageInput.files?.[0];
        chatImageInput.value = '';
        if (file) handleImageSend(file);
    });

    textChatMessages?.addEventListener('click', e => {
        const img = e.target.closest('.chat-img');
        if (img) { e.preventDefault(); openLightbox(img.src); }
    });
    const imgLightbox = document.getElementById('imgLightbox');
    imgLightbox?.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && imgLightbox && !imgLightbox.hidden) closeLightbox();
    });

    streamVolSlider?.addEventListener('input', () => {
        const gain = parseInt(streamVolSlider.value, 10) / 100;
        if (!activeStreamWatch) return;
        streamVolumes.set(activeStreamWatch.username, gain);
        if (streamGainNode) streamGainNode.gain.value = gain;
        const pctEl = document.getElementById('streamVolPct');
        if (pctEl) pctEl.textContent = `${Math.round(gain * 100)}%`;
    });

    usersList?.addEventListener('click', e => {
        const modeBtn = e.target.closest('.loom-mode-btn');
        if (modeBtn) {
            loomMode = modeBtn.dataset.loomMode;
            localStorage.setItem('weave.loomMode', loomMode);
            if (loomRenderer) loomRenderer.setMode(loomMode);
            updateUsersList();
            return;
        }

        const badge = e.target.closest('.streaming-badge');
        if (badge) {
            const username = badge.dataset.username;
            if (username) subscribeToStream(username);
            return;
        }

        const volBtn = e.target.closest('.user-vol-btn');
        if (volBtn) {
            const username = volBtn.dataset.username;
            if (!username) return;
            if (volExpandedUsers.has(username)) volExpandedUsers.delete(username);
            else volExpandedUsers.add(username);
            updateUsersList();
            return;
        }

        // Click a string's avatar/row to pluck it.
        const anchor = e.target.closest('.loom-anchor');
        if (anchor) {
            const username = anchor.dataset.username;
            if (username === myUsername) _localPluck = 1;
            else voiceMeters.get(username)?.trigger();
        }
    });

    usersList?.addEventListener('input', e => {
        const slider = e.target.closest('.user-vol-slider');
        if (!slider) return;
        const username = slider.dataset.username;
        const gain = parseInt(slider.value, 10) / 100;
        userVolumes.set(username, gain);
        const gn = voiceGainNodes.get(username);
        if (gn) gn.gain.value = gain;
        const pct = slider.closest('.user-vol-row')?.querySelector('.vol-pct');
        if (pct) pct.textContent = `${Math.round(gain * 100)}%`;
    });

    document.addEventListener('keydown', e => {
        if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
            e.preventDefault();
            toggleMute();
        }
        if (e.ctrlKey && e.shiftKey) {
            const k = e.key.toLowerCase();
            if (k === 'f' || k === 'l') {
                e.preventDefault();
                adminKeyBuf.push(k);
                clearTimeout(adminKeyTimer);
                adminKeyTimer = setTimeout(() => { adminKeyBuf = []; }, 2000);
                if (adminKeyBuf.includes('f') && adminKeyBuf.includes('l')) {
                    adminKeyBuf = [];
                    if (isAdminUser && joined) toggleAdminPanel();
                }
            }
        }
    });

    // ── EMOJI PICKER ───────────────────────────────────────────────────────

    // ── ADMIN PANEL ────────────────────────────────────────────────────────
    document.getElementById('adminNavDb').addEventListener('click', () => loadAdminSection('db'));
    document.getElementById('adminNavConfig').addEventListener('click', () => loadAdminSection('config'));
    document.getElementById('adminNavBirthday')?.addEventListener('click', () => loadAdminSection('birthday'));
    document.getElementById('adminEditBtn').addEventListener('click', startEdit);
    document.getElementById('adminSaveBtn').addEventListener('click', saveEdit);
    document.getElementById('adminCancelBtn').addEventListener('click', cancelEdit);
    document.getElementById('adminDeleteBtn').addEventListener('click', confirmDelete);
    document.getElementById('adminResetPwBtn').addEventListener('click', adminResetPassword);

    // ── Living-loom login background ─────────────────────────────────────────
    const joinCanvas = document.getElementById('joinCanvas');
    if (joinCanvas && window.JoinBackground) {
        const joinBg = new JoinBackground(joinCanvas);
        const syncJoinBg = () => {
            const visible = joinScreen.classList.contains('screen-active') && !document.hidden;
            if (visible) joinBg.start(); else joinBg.stop();
        };
        new MutationObserver(syncJoinBg).observe(joinScreen, { attributes: true, attributeFilter: ['class'] });
        document.addEventListener('visibilitychange', syncJoinBg);
        syncJoinBg();
    }

    // Pause the canvas loops while the tab is hidden; resume if we're back in a room.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { loomRenderer?.stop(); channelWeave?.stop(); }
        else if (roomScreen.classList.contains('screen-active') && !staticBg) {
            loomRenderer?.start();
            channelWeave?.start();
        }
    });

    initSidebarResize();

    window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
}

window.onload = init;

// ── Edit Profile modal ───────────────────────────────────────────────────────
const epModal      = document.getElementById('editProfileModal');
const epForm       = document.getElementById('editProfileForm');
const epNickInput  = document.getElementById('epNickName');
const epAvatar     = document.getElementById('epAvatar');
const epAvatarPrev = document.getElementById('epAvatarPreview');
const epAvatarFile = document.getElementById('epAvatarFileInput');
const epJoinSel    = document.getElementById('epJoinSound');
const epLeaveSel   = document.getElementById('epLeaveSound');
const epCurrentPw  = document.getElementById('epCurrentPw');
const epNewPw      = document.getElementById('epNewPw');
const epNewSecret  = document.getElementById('epNewSecret');
const epSaveBtn    = document.getElementById('epSaveBtn');
const epError      = document.getElementById('epError');

function showEpError(msg) { epError.textContent = msg; epError.style.display = 'block'; }

function epSetAvatar(pic) {
    if (pic && pic.startsWith('data:image')) {
        epAvatar.value = pic;
        epAvatarPrev.innerHTML = `<img src="${pic}" alt="avatar" />`;
        epAvatarPrev.classList.add('has-image');
    } else if (pic) {
        epAvatar.value = pic; // emoji
        epAvatarPrev.innerHTML = `<span class="avatar-upload-emoji">${pic}</span>`;
        epAvatarPrev.classList.remove('has-image');
    } else {
        epAvatar.value = '';
        epAvatarPrev.innerHTML = '<span class="avatar-upload-placeholder">?</span>';
        epAvatarPrev.classList.remove('has-image');
    }
}

function epBuildOptions(sel, sounds, current) {
    const opts = [
        ...(sounds.standard || []).map(f => ({ value: f, label: f })),
        ...(sounds.configurations || []).map(f => ({ value: `configurations/${f}`, label: f })),
    ];
    sel.innerHTML = opts.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    if (current && opts.some(o => o.value === current)) sel.value = current;
}

function epClose() { if (epModal) { epModal.style.display = 'none'; epError.style.display = 'none'; } }

async function openEditProfile() {
    if (!epModal || !joinToken) return;
    epError.style.display = 'none';
    epCurrentPw.value = '';
    epNewPw.value = '';
    if (epNewSecret) epNewSecret.value = '';
    try {
        const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${joinToken}` } });
        const data = await res.json();
        if (!data.ok) { showEpError('Could not load your profile.'); epModal.style.display = 'flex'; return; }
        epNickInput.value = data.nick_name || '';
        epSetAvatar(data.profile_picture || '');
        epBuildOptions(epJoinSel,  data.sounds || {}, (data.join_sounds  || [])[0]);
        epBuildOptions(epLeaveSel, data.sounds || {}, (data.leave_sounds || [])[0]);
        epModal.style.display = 'flex';
    } catch (e) {
        clientError('PROFILE_LOAD', e);
    }
}

if (epModal) {
    document.getElementById('epAvatarUploadBtn')?.addEventListener('click', () => epAvatarFile.click());
    epAvatarFile.addEventListener('change', async () => {
        const file = epAvatarFile.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) { showEpError('Image is too large — max 5 MB.'); epAvatarFile.value = ''; return; }
        epError.style.display = 'none';
        try { epSetAvatar(await resizeImage(file)); }
        catch { showEpError('Could not read that image — try another file.'); }
        epAvatarFile.value = '';
    });

    epModal.querySelectorAll('.sound-preview-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sel = document.getElementById(btn.dataset.for);
            if (!sel?.value) return;
            const encoded = sel.value.split('/').map(encodeURIComponent).join('/');
            new Audio(`/assets/sounds/${encoded}`).play().catch(() => {});
        });
    });

    document.getElementById('editProfileClose')?.addEventListener('click', epClose);
    epModal.addEventListener('click', e => { if (e.target === epModal) epClose(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && epModal.style.display !== 'none') epClose(); });

    epForm.addEventListener('submit', async e => {
        e.preventDefault();
        epError.style.display = 'none';
        const nick = epNickInput.value.trim();
        if (nick.length < 2 || nick.length > 32) { showEpError('Display name must be 2–32 characters.'); return; }
        const newPw = epNewPw.value;
        const newSecret = epNewSecret ? epNewSecret.value.trim() : '';
        if (newPw && newPw.length < 8) { showEpError('New password must be at least 8 characters.'); return; }
        if ((newPw || newSecret) && !epCurrentPw.value) {
            showEpError('Enter your current password to change your password or secret phrase.');
            return;
        }

        const payload = {
            nick_name: nick,
            profile_picture: epAvatar.value || '🎭',
            join_sound: epJoinSel.value,
            leave_sound: epLeaveSel.value,
        };
        if (newPw || newSecret) {
            payload.current_password = epCurrentPw.value;
            if (newPw) payload.new_password = newPw;
            if (newSecret) payload.new_secret_phrase = newSecret;
        }

        epSaveBtn.disabled = true;
        epSaveBtn.textContent = 'Saving…';
        try {
            const res = await fetch('/api/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinToken}` },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                epSaveBtn.textContent = 'Saved ✔';
                const note = document.createElement('div');
                note.className = 'success-message';
                note.textContent = 'Saved — name & picture apply next login.';
                epForm.appendChild(note);
                setTimeout(() => { note.remove(); epSaveBtn.disabled = false; epSaveBtn.textContent = 'Save Changes'; epClose(); }, 1300);
            } else {
                showEpError(data.error || 'Save failed.');
                epSaveBtn.disabled = false;
                epSaveBtn.textContent = 'Save Changes';
            }
        } catch (err) {
            clientError('PROFILE_SAVE', err);
            showEpError('Could not reach the server.');
            epSaveBtn.disabled = false;
            epSaveBtn.textContent = 'Save Changes';
        }
    });
}

// ── Create / manage private channels ─────────────────────────────────────────
// Markup sits before the app.js <script> tag (next to the Edit-Profile modal), so these
// elements exist when this file runs — wire inline, same as epModal above.
const ccModal      = document.getElementById('createChannelModal');
const ccForm       = document.getElementById('createChannelForm');
const ccName       = document.getElementById('ccName');
const ccUserFilter = document.getElementById('ccUserFilter');
const ccUserList   = document.getElementById('ccUserList');
const ccCreateBtn  = document.getElementById('ccCreateBtn');
const ccError      = document.getElementById('ccError');

const mcModal      = document.getElementById('manageChannelModal');
const mcForm       = document.getElementById('manageChannelForm');
const mcTitle      = document.getElementById('mcTitle');
const mcUserFilter = document.getElementById('mcUserFilter');
const mcUserList   = document.getElementById('mcUserList');
const mcAddBtn     = document.getElementById('mcAddBtn');
const mcError      = document.getElementById('mcError');
let   mcChannelId  = null;

function showCcError(m) { if (ccError) { ccError.textContent = m; ccError.style.display = 'block'; } }
function showMcError(m) { if (mcError) { mcError.textContent = m; mcError.style.display = 'block'; } }
function ccClose() { if (ccModal) { ccModal.style.display = 'none'; ccError.style.display = 'none'; } }
function mcClose() { if (mcModal) { mcModal.style.display = 'none'; mcError.style.display = 'none'; mcChannelId = null; } }

// Build picker rows. Each row shows nickname + avatar only; the checkbox value is the opaque
// user id (the wire identity), so other users' real names never reach the client.
function buildUserPicker(users) {
    const rows = users.map(u => {
        const pic = u.profile_picture;
        const avatar = (pic && pic.startsWith('data:image'))
            ? `<img class="cc-ava" src="${escapeHtml(pic)}" alt="">`
            : `<span class="cc-ava cc-ava-emoji">${escapeHtml(pic || '🎭')}</span>`;
        return `<label class="cc-user-row"><input type="checkbox" value="${escapeHtml(u.id)}">${avatar}<span class="cc-user-nick">${escapeHtml(u.nick_name)}</span></label>`;
    }).join('');
    return rows || '<p class="text-chat-placeholder">No other users yet.</p>';
}

function filterPicker(listEl, query) {
    const q = query.trim().toLowerCase();
    listEl.querySelectorAll('.cc-user-row').forEach(row => {
        const nick = row.querySelector('.cc-user-nick')?.textContent.toLowerCase() || '';
        row.style.display = nick.includes(q) ? '' : 'none';
    });
}

async function fetchAllUsers() {
    const res = await fetch('/api/users/all', { headers: { Authorization: `Bearer ${joinToken}` } });
    const data = await res.json();
    if (!data.ok) throw new Error('users');
    return data.users || [];
}

async function openCreateChannelModal() {
    if (!ccModal || !joinToken) return;
    ccError.style.display = 'none';
    ccName.value = '';
    ccUserFilter.value = '';
    ccUserList.innerHTML = '<p class="text-chat-placeholder">Loading…</p>';
    ccModal.style.display = 'flex';
    ccName.focus();
    try { ccUserList.innerHTML = buildUserPicker(await fetchAllUsers()); }
    catch { ccUserList.innerHTML = '<p class="text-chat-placeholder">Could not load users.</p>'; }
}

async function openManageChannelModal(channelId) {
    if (!mcModal || !joinToken) return;
    mcChannelId = channelId;
    mcError.style.display = 'none';
    mcUserFilter.value = '';
    if (mcTitle) mcTitle.textContent = channelLabel(channelId);
    mcUserList.innerHTML = '<p class="text-chat-placeholder">Loading…</p>';
    mcModal.style.display = 'flex';
    try { mcUserList.innerHTML = buildUserPicker(await fetchAllUsers()); }
    catch { mcUserList.innerHTML = '<p class="text-chat-placeholder">Could not load users.</p>'; }
}

document.getElementById('createChannelBtn')?.addEventListener('click', openCreateChannelModal);

if (ccModal) {
    document.getElementById('createChannelClose')?.addEventListener('click', ccClose);
    ccModal.addEventListener('click', e => { if (e.target === ccModal) ccClose(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && ccModal.style.display !== 'none') ccClose(); });
    ccUserFilter.addEventListener('input', () => filterPicker(ccUserList, ccUserFilter.value));

    ccForm.addEventListener('submit', async e => {
        e.preventDefault();
        ccError.style.display = 'none';
        const name = ccName.value.trim();
        if (name.length < 1 || name.length > 40) { showCcError('Channel name must be 1–40 characters.'); return; }
        const allowed_user_ids = [...ccUserList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);

        ccCreateBtn.disabled = true;
        ccCreateBtn.textContent = 'Creating…';
        try {
            const res = await fetch('/api/channels/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinToken}` },
                body: JSON.stringify({ name, allowed_user_ids }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                // Make it renderable immediately; the WS `privateChannels` push reconciles right after.
                if (!privateChannelMap.has(data.channelId)) privateChannelMap.set(data.channelId, { label: data.label, canManage: true });
                ccClose();
                showToast('Private channel created', escapeHtml(data.label));
                await joinChannelStandard(data.channelId);   // creator auto-joins
            } else {
                showCcError(data.error || 'Could not create the channel.');
            }
        } catch (err) {
            clientError('CHANNEL_CREATE', err);
            showCcError('Could not reach the server.');
        } finally {
            ccCreateBtn.disabled = false;
            ccCreateBtn.textContent = 'Create & Join';
        }
    });
}

if (mcModal) {
    document.getElementById('manageChannelClose')?.addEventListener('click', mcClose);
    mcModal.addEventListener('click', e => { if (e.target === mcModal) mcClose(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && mcModal.style.display !== 'none') mcClose(); });
    mcUserFilter.addEventListener('input', () => filterPicker(mcUserList, mcUserFilter.value));

    mcForm.addEventListener('submit', async e => {
        e.preventDefault();
        mcError.style.display = 'none';
        if (!mcChannelId) { showMcError('No channel selected.'); return; }
        const ids = [...mcUserList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
        if (!ids.length) { showMcError('Pick at least one person to add.'); return; }

        mcAddBtn.disabled = true;
        mcAddBtn.textContent = 'Adding…';
        try {
            const results = await Promise.all(ids.map(user_id =>
                fetch('/api/channels/add-member', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${joinToken}` },
                    body: JSON.stringify({ channelId: mcChannelId, user_id }),
                }).then(r => r.ok).catch(() => false)
            ));
            const added = results.filter(Boolean).length;
            if (added) {
                mcClose();
                showToast('Members added', `${added} ${added === 1 ? 'person' : 'people'} can now join.`);
            } else {
                showMcError('Could not add the selected members.');
            }
        } catch (err) {
            clientError('CHANNEL_ADD', err);
            showMcError('Could not reach the server.');
        } finally {
            mcAddBtn.disabled = false;
            mcAddBtn.textContent = 'Add Members';
        }
    });
}

// ── Mic sensitivity (noise gate threshold) ───────────────────────────────────
// Controls live inline inside the dock popover; no separate popover needed.
// NOTE: the Mic & Audio panel markup lives AFTER the app.js <script> tag in index.html, so its
// elements don't exist when this file first executes. Defer wiring until the DOM is parsed,
// otherwise every getElementById below returns null and no mic control is ever hooked up.
function initMicSettings() {
  const enableEl = document.getElementById('micGateToggle');
  const meterEl  = document.getElementById('micMeter');
  const markerEl = document.getElementById('micMeterThreshold');
  const inputEl  = document.getElementById('micInputGainSlider');
  const echoEl   = document.getElementById('micEchoToggle');
  const noiseEl  = document.getElementById('micNoiseToggle');
  const agcEl    = document.getElementById('micAgcToggle');
  if (!enableEl && !meterEl && !echoEl) return;

  applyMicSettingsUI();

  enableEl?.addEventListener('change', () => {
    micGate.enabled = enableEl.checked;
    saveMicGate();
    // AGC and the noise gate fight each other (AGC boosts idle noise back above the gate), so the
    // moment the gate is switched ON we turn AGC OFF and re-acquire the mic — the gate then works.
    if (enableEl.checked && micConstraints.autoGainControl) {
      micConstraints.autoGainControl = false;
      saveMicConstraints();
      if (agcEl) agcEl.checked = false;
      reacquireMic();
    }
  });

  // Drag/click the gold line on the live meter to set the noise-gate threshold. The gate loop
  // reads micGate.threshold every 40 ms, so activation tracks the drag instantly.
  function setThresholdFromEvent(e) {
    const rect = meterEl.getBoundingClientRect();
    micGate.threshold = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (markerEl) markerEl.style.left = `${micGate.threshold * 100}%`;
    saveMicGate();
  }
  meterEl?.addEventListener('pointerdown', e => {
    e.preventDefault();
    meterEl.setPointerCapture(e.pointerId);
    setThresholdFromEvent(e);
  });
  meterEl?.addEventListener('pointermove', e => {
    if (meterEl.hasPointerCapture(e.pointerId)) setThresholdFromEvent(e);
  });
  meterEl?.addEventListener('pointerup', e => {
    try { meterEl.releasePointerCapture(e.pointerId); } catch {}
  });

  inputEl?.addEventListener('input', () => {
    setMicInputGain(Math.max(0, Math.min(2, parseInt(inputEl.value, 10) / 100)));
    saveMicGate();
  });

  // Browser-processing checkboxes — persist + re-acquire the mic so it applies live.
  function onConstraintChange(key, el) {
    micConstraints[key] = el.checked;
    saveMicConstraints();
    reacquireMic();
  }
  echoEl?.addEventListener('change',  () => onConstraintChange('echoCancellation', echoEl));
  noiseEl?.addEventListener('change', () => onConstraintChange('noiseSuppression', noiseEl));
  // AGC and the noise gate are mutually exclusive — turning AGC ON disables the gate (mirror of the
  // gate-enable handler above), so the two can never both be on.
  agcEl?.addEventListener('change', () => {
    if (agcEl.checked && micGate.enabled) {
      micGate.enabled = false;
      saveMicGate();
      if (enableEl) enableEl.checked = false;
    }
    onConstraintChange('autoGainControl', agcEl);
  });

  // Input-device picker — persist + re-acquire so the chosen mic applies live.
  const deviceEl = document.getElementById('micDeviceSelect');
  deviceEl?.addEventListener('change', () => {
    micConstraints.deviceId = deviceEl.value;
    saveMicConstraints();
    reacquireMic();
  });
  populateMicDevices();
  // Refresh the list when devices are plugged/unplugged and each time the panel is opened
  // (labels also become available once mic permission has been granted).
  navigator.mediaDevices?.addEventListener?.('devicechange', populateMicDevices);
  document.getElementById('micSettingsPanelBtn')?.addEventListener('click', populateMicDevices);

  // Display panel — "Static background" toggle (stops both in-room canvas animations).
  const staticBgEl = document.getElementById('staticBgToggle');
  if (staticBgEl) {
    staticBgEl.checked = staticBg;
    staticBgEl.addEventListener('change', () => {
      staticBg = staticBgEl.checked;
      saveStaticBg();
      applyStaticBg();
    });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMicSettings);
else initMicSettings();

// ── Brand dropdown menu ──────────────────────────────────────────────────────
(function () {
  const brandTrigger    = document.querySelector('.brand-menu-trigger');
  const brandDropdown   = document.getElementById('brandDropdown');
  const fuckDiscordBtn  = document.getElementById('fuckDiscordBtn');
  const inviteFriendItem = document.getElementById('inviteFriendItem');
  const inviteLinkInput  = document.getElementById('inviteLinkInput');
  const copyInviteBtn    = document.getElementById('copyInviteBtn');
  const generateInviteBtn = document.getElementById('generateInviteBtn');
  const shareDiscordBtn  = document.getElementById('shareDiscordBtn');
  const inviteDiscordNo  = document.getElementById('inviteDiscordNo');

  if (!brandTrigger) return;

  const FD_PHRASES = [
    'Yeah~fuckem', 'mmmh!', 'HarDer DadDy!', "Don't STOP!",
    'Click harder for privacy', 'I LOVE PRIVACY!',
    'BURN EVERYTHING DISCORD STANDS FOR!'
  ];
  let fdLastIndex = -1;
  let discordNoTimer = null;

  function openMenu() {
    brandDropdown?.classList.add('open');
    brandTrigger?.classList.add('menu-open');
    brandTrigger?.setAttribute('aria-expanded', 'true');
    brandDropdown?.setAttribute('aria-hidden', 'false');
  }

  function closeMenu() {
    brandDropdown?.classList.remove('open');
    brandTrigger?.classList.remove('menu-open');
    brandTrigger?.setAttribute('aria-expanded', 'false');
    brandDropdown?.setAttribute('aria-hidden', 'true');
  }

  function toggleMenu() {
    brandDropdown?.classList.contains('open') ? closeMenu() : openMenu();
  }

  brandTrigger.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  brandTrigger.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMenu(); }
    if (e.key === 'Escape') closeMenu();
  });

  document.getElementById('editProfileBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    closeMenu();
    openEditProfile();
  });

  document.addEventListener('click', e => {
    if (brandDropdown?.classList.contains('open') && !brandDropdown.contains(e.target) && e.target !== brandTrigger) {
      closeMenu();
    }
  });

  fuckDiscordBtn.addEventListener('click', e => {
    e.stopPropagation();
    playDegradingMoan();
    let idx;
    do { idx = Math.floor(Math.random() * FD_PHRASES.length); } while (idx === fdLastIndex && FD_PHRASES.length > 1);
    fdLastIndex = idx;

    const phrase = FD_PHRASES[idx];
    const rect   = fuckDiscordBtn.getBoundingClientRect();
    const offsetX = (Math.random() - 0.5) * 140;
    const offsetY = -20 - Math.random() * 40;
    let x = rect.left + rect.width / 2 + offsetX;
    let y = rect.top  + offsetY;
    x = Math.max(8, Math.min(x, window.innerWidth  - 200));
    y = Math.max(8, Math.min(y, window.innerHeight - 30));

    const el = document.createElement('span');
    el.className = 'fd-phrase';
    el.textContent = phrase;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  });

  inviteFriendItem.addEventListener('click', e => {
    e.stopPropagation();
    inviteFriendItem.classList.toggle('expanded');
  });

  if (generateInviteBtn) generateInviteBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!joinToken) return;
    generateInviteBtn.disabled = true;
    const orig = generateInviteBtn.textContent;
    generateInviteBtn.textContent = 'Generating…';
    try {
      const res = await fetch('/api/invite/generate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${joinToken}` },
      });
      const data = await res.json();
      if (data.ok && data.code) {
        inviteLinkInput.value = `${window.location.origin}/?invite=${data.code}`;
        showToast('Invite code ready', 'A one-time invite link is below — share it with one person. It works once.');
      } else {
        showToast('Could not generate', data.error || 'Try again in a moment.');
      }
    } catch (err) {
      clientError('INVITE_GEN_FAILED', err);
      showToast('Could not generate', 'Network error — try again.');
    } finally {
      generateInviteBtn.disabled = false;
      generateInviteBtn.textContent = orig;
    }
  });

  copyInviteBtn.addEventListener('click', e => {
    e.stopPropagation();
    navigator.clipboard.writeText(inviteLinkInput.value).then(() => {
      copyInviteBtn.textContent = 'Copied!';
      copyInviteBtn.classList.add('copied');
      setTimeout(() => {
        copyInviteBtn.textContent = 'Copy';
        copyInviteBtn.classList.remove('copied');
      }, 1800);
    });
  });

  shareDiscordBtn.addEventListener('click', e => {
    e.stopPropagation();
    clearTimeout(discordNoTimer);
    inviteDiscordNo.classList.remove('show');
    void inviteDiscordNo.offsetWidth;
    inviteDiscordNo.classList.add('show');
    discordNoTimer = setTimeout(() => inviteDiscordNo.classList.remove('show'), 2000);
  });
}());

// ── What's New modal ──────────────────────────────────────────────────────────
let lastChangelogVersion = null;
async function showWhatsNewIfNeeded() {
  const modal = document.getElementById('whatsNewModal');
  const list  = document.getElementById('whatsNewList');
  if (!modal || !list) return;
  let entries = [];
  try {
    const data = await fetch('/api/changelog', {
      headers: joinToken ? { Authorization: `Bearer ${joinToken}` } : {},
    }).then(r => r.json());
    lastChangelogVersion = (data && data.version) || null;
    entries = (data && Array.isArray(data.entries)) ? data.entries : [];
  } catch { return; }
  if (!lastChangelogVersion) return;
  // Show once per server restart, per user (localStorage is per-browser).
  const seenKey = `${lastChangelogVersion}::${myUsername || ''}`;
  if (localStorage.getItem('weave.lastSeenChangelog') === seenKey) return;
  list.innerHTML = entries.map(e => `
      <li class="whats-new-item">
        <span class="wn-dot"></span>
        <div><strong>${e.title}</strong><p>${e.summary}</p></div>
      </li>`).join('');
  modal.style.display = 'flex';
}

// Wire the close controls on DOMContentLoaded: the #whatsNewModal markup sits AFTER the app.js
// <script> tag, so binding at parse time would find nothing (getElementById → null).
function initWhatsNew() {
  const modal = document.getElementById('whatsNewModal');
  if (!modal) return;
  function closeWhatsNew() {
    if (lastChangelogVersion) {
      localStorage.setItem('weave.lastSeenChangelog', `${lastChangelogVersion}::${myUsername || ''}`);
    }
    modal.style.display = 'none';
  }
  document.getElementById('whatsNewClose')?.addEventListener('click', closeWhatsNew);
  document.getElementById('whatsNewDismiss')?.addEventListener('click', closeWhatsNew);
  modal.addEventListener('click', e => { if (e.target === modal) closeWhatsNew(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.style.display === 'flex') closeWhatsNew();
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWhatsNew);
else initWhatsNew();
