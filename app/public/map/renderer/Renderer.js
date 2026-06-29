// Renderer.js — Orchestrates which sub-renderer is active and handles transitions.
// Owns the canvas, camera transform (overworld), and DOM overlay management.

import { MAP_DATA } from '../map-data.js';
import { VIEW } from '../engine/GameEngine.js';
import { OverworldRenderer } from './OverworldRenderer.js';
import { RoomRenderer }      from './RoomRenderer.js';

export class Renderer {
    constructor(canvas, overlayEl, theme) {
        this._canvas   = canvas;
        this._ctx      = canvas.getContext('2d');
        this._overlay  = overlayEl;
        this._theme    = theme;

        this._overworld = new OverworldRenderer(theme);
        this._room      = new RoomRenderer(theme, overlayEl);

        // Transition state
        this._transition = {
            active:    false,
            startMs:   0,
            progress:  0,
            fromView:  null,
            toView:    null,
            toRoom:    null,
        };

        // Camera — lazy-initialised to player position on first draw
        this._camX = undefined;
        this._camY = undefined;

        // Text channel overlay state
        this._bookOpen      = false;
        this._bookChannelId = null;

        // Stream portal DOM nodes: producerId → <div>
        this._portals = new Map();

        // Resize
        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(canvas.parentElement || document.body);
        requestAnimationFrame(() => this._onResize());
    }

    // ── Resize ─────────────────────────────────────────────────────────────

    _onResize() {
        const parent = this._canvas.parentElement;
        if (!parent) return;
        const pw = parent.clientWidth  || window.innerWidth;
        const ph = parent.clientHeight || window.innerHeight;

        const mapAspect    = MAP_DATA.width / MAP_DATA.height;
        const parentAspect = pw / ph;

        let cw, ch;
        if (parentAspect >= mapAspect) {
            ch = ph;
            cw = ph * mapAspect;
        } else {
            cw = pw;
            ch = pw / mapAspect;
        }

        this._canvas.width  = Math.floor(cw);
        this._canvas.height = Math.floor(ch);
        this._canvas.style.width  = this._canvas.width  + 'px';
        this._canvas.style.height = this._canvas.height + 'px';
    }

    // ── Transition trigger ─────────────────────────────────────────────────

    startTransition(fromView, toView, toRoom, prevRoom = null) {
        this._transition = {
            active:   true,
            startMs:  performance.now(),
            progress: 0,
            fromView,
            toView,
            toRoom,
            prevRoom,
        };
        this._closeBookOverlay();
    }

    // ── Main draw ──────────────────────────────────────────────────────────

    draw(engine, myUsername, nowMs, activeStreams) {
        const ctx  = this._ctx;
        const cw   = this._canvas.width;
        const ch   = this._canvas.height;
        const t    = this._theme;

        if (this._transition.active) {
            const elapsed  = nowMs - this._transition.startMs;
            this._transition.progress = Math.min(1, elapsed / t.transition.durationMs);
            if (this._transition.progress >= 1) this._transition.active = false;
        }

        ctx.clearRect(0, 0, cw, ch);

        const view = engine.viewState;

        if (!this._transition.active) {
            if (view === VIEW.OVERWORLD) {
                this._drawOverworld(ctx, engine, myUsername, nowMs, cw, ch);
            } else {
                this._drawRoom(ctx, engine, myUsername, nowMs, activeStreams);
            }
        } else {
            this._drawTransition(ctx, engine, myUsername, nowMs, activeStreams, cw, ch);
        }

        this._updatePortalPositions(engine, activeStreams, cw, ch);
    }

    // ── Overworld draw with camera follow ─────────────────────────────────

    _drawOverworld(ctx, engine, myUsername, nowMs, cw, ch) {
        ctx.save();

        const cam   = this._theme.camera;
        const viewW = MAP_DATA.width  * cam.viewFraction;   // 500 world units
        const viewH = viewW * (ch / cw);
        const scale = cw / viewW;

        // Lazy-initialise camera to player position — avoids sliding from (0,0) on first frame
        if (this._camX === undefined) {
            this._camX = engine.playerPos.x < 0 ? MAP_DATA.spawnPoint.x : engine.playerPos.x;
            this._camY = engine.playerPos.y < 0 ? MAP_DATA.spawnPoint.y : engine.playerPos.y;
        }

        // Smooth camera lerp toward player; during spawn track the landing spot instead
        const targetX = engine.spawnAnim?.active ? engine.spawnAnim.targetX : engine.playerPos.x;
        const targetY = engine.spawnAnim?.active ? engine.spawnAnim.targetY : engine.playerPos.y;
        const lerpK   = engine.spawnAnim?.active ? 0.02 : cam.lerpSpeed;
        this._camX += (targetX - this._camX) * lerpK;
        this._camY += (targetY - this._camY) * lerpK;

        // Clamp so camera never reveals outside the map
        const camX = Math.max(viewW / 2, Math.min(MAP_DATA.width  - viewW / 2, this._camX));
        const camY = Math.max(viewH / 2, Math.min(MAP_DATA.height - viewH / 2, this._camY));

        ctx.scale(scale, scale);
        ctx.translate(-(camX - viewW / 2), -(camY - viewH / 2));

        this._overworld.draw(ctx, engine, myUsername, nowMs);
        ctx.restore();
    }

    // ── Room draw ──────────────────────────────────────────────────────────

    _drawRoom(ctx, engine, myUsername, nowMs, activeStreams) {
        if (!engine.currentRoom) return;
        this._room.draw(ctx, engine.currentRoom, engine, myUsername, nowMs, activeStreams);
    }

    // ── Transition draw ────────────────────────────────────────────────────

    _drawTransition(ctx, engine, myUsername, nowMs, activeStreams, cw, ch) {
        const p     = this._transition.progress;
        const style = this._theme.transition.style;

        if (style === 'zoom') {
            const entering = this._transition.toView === VIEW.ROOM;
            const scale = entering
                ? 1 + p * 0.35
                : 1.35 - p * 0.35;

            ctx.save();
            ctx.translate(cw / 2, ch / 2);
            ctx.scale(scale, scale);
            ctx.translate(-cw / 2, -ch / 2);

            if (p < 0.5) {
                if (this._transition.fromView === VIEW.OVERWORLD) {
                    this._drawOverworld(ctx, engine, myUsername, nowMs, cw, ch);
                } else {
                    const roomToDraw = this._transition.prevRoom;
                    if (roomToDraw) this._room.draw(ctx, roomToDraw, engine, myUsername, nowMs, activeStreams);
                }
            } else {
                if (this._transition.toView === VIEW.OVERWORLD) {
                    this._drawOverworld(ctx, engine, myUsername, nowMs, cw, ch);
                } else {
                    this._drawRoom(ctx, engine, myUsername, nowMs, activeStreams);
                }
            }
            ctx.restore();

            ctx.globalAlpha = Math.sin(p * Math.PI) * 0.9;
            ctx.fillStyle   = '#0d0705';
            ctx.fillRect(0, 0, cw, ch);
            ctx.globalAlpha = 1;

        } else if (style === 'fade') {
            const drawTarget = p >= 0.5;
            if (!drawTarget) {
                if (this._transition.fromView === VIEW.OVERWORLD) this._drawOverworld(ctx, engine, myUsername, nowMs, cw, ch);
                else this._drawRoom(ctx, engine, myUsername, nowMs, activeStreams);
            } else {
                if (this._transition.toView === VIEW.OVERWORLD) this._drawOverworld(ctx, engine, myUsername, nowMs, cw, ch);
                else this._drawRoom(ctx, engine, myUsername, nowMs, activeStreams);
            }
            ctx.globalAlpha = Math.sin(p * Math.PI);
            ctx.fillStyle   = '#0d0705';
            ctx.fillRect(0, 0, cw, ch);
            ctx.globalAlpha = 1;

        } else {
            if (engine.viewState === VIEW.OVERWORLD) this._drawOverworld(ctx, engine, myUsername, nowMs, cw, ch);
            else this._drawRoom(ctx, engine, myUsername, nowMs, activeStreams);
        }
    }

    // ── World → Screen coordinate mapping ─────────────────────────────────

    screenToWorld(screenX, screenY, engine) {
        const cw = this._canvas.width;
        const ch = this._canvas.height;

        if (engine.viewState === VIEW.OVERWORLD) {
            const cam   = this._theme.camera;
            const viewW = MAP_DATA.width  * cam.viewFraction;
            const viewH = viewW * (ch / cw);
            const scale = cw / viewW;

            const camXRaw = this._camX ?? engine.playerPos.x;
            const camYRaw = this._camY ?? engine.playerPos.y;
            const camX = Math.max(viewW / 2, Math.min(MAP_DATA.width  - viewW / 2, camXRaw));
            const camY = Math.max(viewH / 2, Math.min(MAP_DATA.height - viewH / 2, camYRaw));

            return {
                x: screenX / scale + (camX - viewW / 2),
                y: screenY / scale + (camY - viewH / 2),
            };
        }

        const room = engine.currentRoom;
        if (!room) return { x: screenX, y: screenY };
        const pad  = Math.min(cw, ch) * this._theme.roomPadding;
        const rx   = pad, ry = pad, rw = cw - pad * 2, rh = ch - pad * 2;
        return {
            x: room.x + ((screenX - rx) / rw) * room.w,
            y: room.y + ((screenY - ry) / rh) * room.h,
        };
    }

    // ── Book overlay ───────────────────────────────────────────────────────

    openBookOverlay(channelId) {
        this._bookOpen      = true;
        this._bookChannelId = channelId;
        const el = this._overlay.querySelector('#bookOverlay');
        if (!el) return;
        el.querySelector('.book-channel-id').textContent = channelId;
        el.classList.add('open');
    }

    _closeBookOverlay() {
        this._bookOpen = false;
        const el = this._overlay.querySelector('#bookOverlay');
        if (el) el.classList.remove('open');
    }

    closeBookOverlay() { this._closeBookOverlay(); }

    // ── Stream portals ─────────────────────────────────────────────────────

    addStreamPortal(producerId, username) {
        if (this._portals.has(producerId)) return;

        const div = document.createElement('div');
        div.className   = 'stream-portal';
        div.dataset.pid = producerId;
        div.innerHTML   = `
            <div class="portal-tag">${username}'s Stream</div>
            <div class="portal-click-hint">Click to watch</div>
            <video class="portal-video" autoplay playsinline></video>
        `;

        div.addEventListener('click', () => {
            if (window.weave?.consumeStream) {
                window.weave.consumeStream(producerId).then(stream => {
                    if (!stream) return;
                    const video = div.querySelector('.portal-video');
                    video.srcObject = stream;
                    video.style.display = 'block';
                    div.querySelector('.portal-click-hint').style.display = 'none';
                    div.classList.add('active');
                });
            }
        });

        this._overlay.appendChild(div);
        this._portals.set(producerId, div);
    }

    removeStreamPortal(producerId) {
        const div = this._portals.get(producerId);
        if (div) { div.remove(); this._portals.delete(producerId); }
    }

    removeAllPortals() {
        for (const div of this._portals.values()) div.remove();
        this._portals.clear();
    }

    _updatePortalPositions(engine, activeStreams, cw, ch) {
        if (engine.viewState !== VIEW.ROOM || !engine.currentRoom) {
            for (const div of this._portals.values()) div.style.display = 'none';
            return;
        }

        const room = engine.currentRoom;
        const pad  = Math.min(cw, ch) * this._theme.roomPadding;
        const rx   = pad, ry = pad, rw = cw - pad * 2, rh = ch - pad * 2;
        const paintingObjects = room.objects.filter(o => o.type === 'painting');

        for (const [producerId, div] of this._portals) {
            const streamIdx = (activeStreams || []).findIndex(s => s.producerId === producerId);
            const paintObj  = paintingObjects.find(o => o.payload?.streamSlot === streamIdx);

            if (!paintObj || streamIdx === -1) {
                div.style.display = 'none';
                continue;
            }

            const sx = rx + paintObj.x * rw;
            const sy = ry + paintObj.y * rh;
            const sw = paintObj.w * rw;
            const sh = paintObj.h * rh;

            div.style.display  = 'flex';
            div.style.left     = sx + 'px';
            div.style.top      = sy + 'px';
            div.style.width    = sw + 'px';
            div.style.height   = sh + 'px';
        }
    }

    destroy() {
        this._resizeObserver.disconnect();
        this.removeAllPortals();
    }
}
