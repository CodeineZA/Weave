// NetworkSync.js — Sends local position to server and receives remote positions.
// Broadcasts at 20 Hz. Remote player state is written into GameEngine.

const SEND_INTERVAL_MS = 50; // 20 Hz

export class NetworkSync {
    constructor(engine) {
        this._engine    = engine;
        this._ws        = null;
        this._interval  = null;
        this._username  = null;
    }

    // Called by map.js once the WebSocket and username are available.
    // ws is the same WebSocket instance used by app.js.
    attach(ws, username) {
        this._ws       = ws;
        this._username = username;
        this._startSending();
    }

    detach() {
        this._stopSending();
        this._ws = null;
    }

    // Handle an incoming peer_moved message (called by app.js WS handler)
    handlePeerMoved(username, x, y, channelId) {
        this._engine.upsertRemotePlayer(username, x, y, channelId || 'lobby');
    }

    handlePeerLeft(username) {
        this._engine.removeRemotePlayer(username);
    }

    // Seed positions for players already in the room when we join
    handleInitialPositions(mapPositions) {
        if (!Array.isArray(mapPositions)) return;
        for (const entry of mapPositions) {
            if (!entry.username || entry.username === this._username) continue;
            this._engine.upsertRemotePlayer(
                entry.username,
                entry.x ?? 1000,
                entry.y ?? 960,
                entry.channelId ?? 'lobby',
            );
        }
    }

    _startSending() {
        this._stopSending();
        this._interval = setInterval(() => this._send(), SEND_INTERVAL_MS);
    }

    _stopSending() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    _send() {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        const pos = this._engine.playerPos;
        this._ws.send(JSON.stringify({
            type:      'move',
            x:         Math.round(pos.x),
            y:         Math.round(pos.y),
            channelId: this._engine.getCurrentChannelId(),
        }));
    }
}
