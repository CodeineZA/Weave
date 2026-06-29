// map.js — Entry point. Wires engine + renderer + theme + networking together.
// Exported as window.weaveMap so index.html can call weaveMap.init() and
// weaveMap.destroy() when toggling the map on/off.

import { GameEngine, VIEW } from './engine/GameEngine.js';
import { NetworkSync }      from './engine/NetworkSync.js';
import { VoIPBridge }       from './engine/VoIPBridge.js';
import { Renderer }         from './renderer/Renderer.js';
import { theme }            from './theme/theme-marauder.js';

class WeaveMap {
    constructor() {
        this._engine   = null;
        this._network  = null;
        this._voip     = null;
        this._renderer = null;
        this._rafId    = null;
        this._username = null;
        this._running  = false;

        // Active streams in current room: [{ producerId, username }]
        this._activeStreams = [];

        // Player world position saved just before enterRoom() repositions them.
        // Used to draw the correct overworld position during the first half of
        // the OVERWORLD→ROOM transition.
        this._fromPlayerPos = null;
    }

    // ── Public API ─────────────────────────────────────────────────────────

    init(canvas, overlayEl, ws, username) {
        if (this._running) return;
        this._username = username;
        this._running  = true;

        // Engine
        this._engine = new GameEngine();
        this._engine.onViewChange  = (v, room, prevRoom) => this._onViewChange(v, room, prevRoom);
        this._engine.onObjectClick = (obj) => this._onObjectClick(obj);
        // Save the overworld player position before enterRoom() repositions the player,
        // so the transition can draw the correct pre-entry position during its first half.
        this._engine.onDoorEnter   = (_roomId) => {
            this._fromPlayerPos = { ...this._engine.playerPos };
        };
        this._engine.start();

        // Networking
        this._network = new NetworkSync(this._engine);
        this._network.attach(ws, username);

        // VoIP
        this._voip = new VoIPBridge();

        // Renderer
        this._renderer = new Renderer(canvas, overlayEl, theme);

        // Canvas input
        canvas.addEventListener('click',     e => this._onCanvasClick(e));
        canvas.addEventListener('mousemove', e => this._onCanvasMouseMove(e));

        // Close book overlay button
        const closeBook = overlayEl.querySelector('#bookOverlay .close-btn');
        if (closeBook) closeBook.addEventListener('click', () => this._renderer.closeBookOverlay());

        // Start loop
        this._rafId = requestAnimationFrame(ts => this._loop(ts));
    }

    // Stop rendering but keep engine/network alive so position is preserved across map toggles.
    pause() {
        if (!this._running) return;
        this._running = false;
        cancelAnimationFrame(this._rafId);
    }

    // Restart rendering after a pause().
    resume() {
        if (this._running || !this._engine) return;
        this._running = true;
        // Trigger resize in case the canvas was hidden when last sized
        requestAnimationFrame(() => this._renderer?._onResize());
        this._rafId = requestAnimationFrame(ts => this._loop(ts));
    }

    // Full teardown — only called when the user leaves Weave entirely.
    destroy() {
        if (!this._engine) return;
        this._running = false;
        cancelAnimationFrame(this._rafId);
        this._engine.stop();
        this._network.detach();
        this._renderer.destroy();
        this._engine = this._network = this._voip = this._renderer = null;
        this._activeStreams = [];
    }

    // Join a channel by its channelId ('lobby' or 'room:xxx').
    // Can be called from the sidebar without the map being visible.
    joinChannel(channelId) {
        if (!this._engine) return;
        const eng = this._engine;
        if (channelId === 'lobby') {
            if (eng.viewState === VIEW.ROOM) eng.exitRoom();
            return;
        }
        const roomId = channelId.replace('room:', '');
        if (eng.viewState === VIEW.ROOM) {
            if (eng.currentRoom?.id === roomId) return;
            eng.exitRoom();
            // Wait for exit transition before entering the new room
            setTimeout(() => { if (this._engine) this._engine.enterRoom(roomId); }, 420);
        } else {
            eng.enterRoom(roomId);
        }
    }

    // Return to lobby from wherever the player currently is.
    leaveChannel() {
        if (this._engine?.viewState === VIEW.ROOM) this._engine.exitRoom();
    }

    // Called by app.js when a peer_moved message arrives
    onPeerMoved(username, x, y, channelId) {
        this._network?.handlePeerMoved(username, x, y, channelId);
    }

    // Called by app.js when a user leaves the room
    onPeerLeft(username) {
        this._network?.handlePeerLeft(username);
    }

    // Called by app.js after join_ack to seed existing positions
    onInitialPositions(mapPositions) {
        this._network?.handleInitialPositions(mapPositions);
    }

    // Called by app.js when a new video producer appears
    onNewStream(producerId, username, channelId) {
        const myChannel = this._engine?.getCurrentChannelId();
        if (channelId !== myChannel) return;
        const slot = this._activeStreams.length;
        this._activeStreams.push({ producerId, username, slot });
        this._renderer?.addStreamPortal(producerId, username);
    }

    // Called by app.js when a producer closes
    onStreamClosed(producerId) {
        this._activeStreams = this._activeStreams.filter(s => s.producerId !== producerId);
        this._renderer?.removeStreamPortal(producerId);
    }

    // ── Game loop ──────────────────────────────────────────────────────────

    _loop(nowMs) {
        if (!this._running) return;
        this._engine.update(nowMs);
        this._renderer.draw(this._engine, this._username, nowMs, this._activeStreams);
        this._rafId = requestAnimationFrame(ts => this._loop(ts));
    }

    // ── View state change ──────────────────────────────────────────────────

    _onViewChange(viewState, room, prevRoom = null) {
        const from = viewState === VIEW.ROOM ? VIEW.OVERWORLD : VIEW.ROOM;

        // Consume and clear the saved pre-entry player position (only relevant for
        // OVERWORLD→ROOM transitions triggered by door crossing).
        const fromPlayerPos = this._fromPlayerPos;
        this._fromPlayerPos = null;

        // Freeze engine input during the visual transition so the player can't
        // move while the screen is black. The renderer calls onComplete when done.
        this._engine.transitioning = true;
        const onComplete = () => { if (this._engine) this._engine.transitioning = false; };

        this._renderer.startTransition(from, viewState, room, prevRoom, fromPlayerPos, onComplete);

        // Switch VoIP channel
        const channelId = viewState === VIEW.ROOM ? room.channelId : 'lobby';
        this._voip.switchChannel(channelId);

        // Clear stream portals when leaving a room
        if (viewState === VIEW.OVERWORLD) {
            this._activeStreams = [];
            this._renderer.removeAllPortals();
        }
    }

    // ── Object click ───────────────────────────────────────────────────────

    _onObjectClick(obj) {
        switch (obj.action) {
            case 'openTextChannel':
                this._renderer.openBookOverlay(obj.payload.channelId);
                break;

            case 'openStream': {
                const stream = this._activeStreams[obj.payload?.streamSlot];
                if (stream) this._voip.openStream(stream.producerId);
                break;
            }

            case 'exitRoom':
                this._engine.exitRoom();
                break;
        }
    }

    // ── Canvas input → world coords ────────────────────────────────────────

    _onCanvasClick(e) {
        const rect  = e.target.getBoundingClientRect();
        const sx    = e.clientX - rect.left;
        const sy    = e.clientY - rect.top;
        const world = this._renderer.screenToWorld(sx, sy, this._engine);
        this._engine.handleClick(world.x, world.y);
    }

    _onCanvasMouseMove(e) {
        const rect  = e.target.getBoundingClientRect();
        const sx    = e.clientX - rect.left;
        const sy    = e.clientY - rect.top;
        const world = this._renderer.screenToWorld(sx, sy, this._engine);
        this._engine.handleMouseMove(world.x, world.y);

        // Cursor style: pointer when hovering an object in ROOM view
        e.target.style.cursor = this._engine.hoveredObject ? 'pointer' : 'default';
    }
}

// Expose as singleton
window.weaveMap = new WeaveMap();
