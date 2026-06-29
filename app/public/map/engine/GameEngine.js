// GameEngine.js — Pure game logic. No theme imports, no canvas drawing.
// Manages: player movement, collision, view state machine, door detection,
// footprint trail data, remote player interpolation, object interaction.

import { MAP_DATA, getDoorHitbox } from '../map-data.js';

// ── Constants ──────────────────────────────────────────────────────────────
export const STEP_DISTANCE     = 150;   // px between footprint stamps — wide gait so prints don't overlap
export const STEP_FADE_MS      = 10000; // ms for full alpha decay (was 7000)
export const STEP_WIDTH_FACTOR = 0.30;  // lateral offset factor (was 0.25)
export const PLAYER_SPEED      = 2.5;   // px per frame @ 60 fps
export const INTERP_SPEED      = 0.18;  // remote player interpolation factor per frame
export const HEADING_LERP      = 0.04;  // smoothing for player body turn direction

// ── View States ────────────────────────────────────────────────────────────
export const VIEW = { OVERWORLD: 'OVERWORLD', ROOM: 'ROOM' };

export class GameEngine {
    constructor() {
        // ── Spawn animation ──
        const targetX = MAP_DATA.spawnPoint.x + (Math.random() - 0.5) * 120;
        const targetY = MAP_DATA.height * 0.95;
        this.spawnAnim = { active: true, progress: 0, targetX, targetY };

        // ── Local player ──
        this.playerPos    = { x: -999, y: -999 };  // offscreen until spawn completes
        this.lastStepPos  = { x: -999, y: -999 };
        this.stepNumber   = 0;
        this.footprints   = [];   // { x, y, angle, isRight, spawnTime }
        this.velocity     = { x: 0, y: 0 };

        // ── Player heading (smooth "invisible body" direction) ──
        this.playerHeading  = 0;   // smoothed display angle (radians) — read by renderer
        this._targetHeading = 0;

        // ── View state ──
        this.viewState    = VIEW.OVERWORLD;
        this.currentRoom  = null;  // room object from MAP_DATA.rooms | null

        // ── Transition ──
        this.transitioning      = false;
        this.transitionProgress = 0;
        this.transitionTarget   = null;

        // ── Remote players ──
        // username → { pos, targetPos, channelId, footprints, lastStepPos, stepNumber, heading, _targetHeading }
        this.remotePlayers = new Map();

        // ── Input ──
        this._keys = {};
        this._boundKeyDown = e => this._onKeyDown(e);
        this._boundKeyUp   = e => this._onKeyUp(e);

        // ── Interaction ──
        this.hoveredObject  = null;
        this._mouseWorld    = { x: 0, y: 0 };

        // ── Callbacks (set by map.js) ──
        this.onViewChange     = null;
        this.onObjectClick    = null;
        this.onDoorEnter      = null;

        this._doorCooldown = false;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    start() {
        document.addEventListener('keydown', this._boundKeyDown);
        document.addEventListener('keyup',   this._boundKeyUp);
    }

    stop() {
        document.removeEventListener('keydown', this._boundKeyDown);
        document.removeEventListener('keyup',   this._boundKeyUp);
    }

    // ── Input handlers ─────────────────────────────────────────────────────

    _onKeyDown(e) {
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        this._keys[e.key.toLowerCase()] = true;
    }

    _onKeyUp(e) {
        this._keys[e.key.toLowerCase()] = false;
    }

    handleClick(worldX, worldY) {
        if (this.viewState !== VIEW.ROOM || !this.currentRoom) return;
        const obj = this._hitTestObjects(worldX, worldY);
        if (obj && this.onObjectClick) this.onObjectClick(obj);
    }

    handleMouseMove(worldX, worldY) {
        this._mouseWorld = { x: worldX, y: worldY };
        if (this.viewState === VIEW.ROOM && this.currentRoom) {
            this.hoveredObject = this._hitTestObjects(worldX, worldY);
        } else {
            this.hoveredObject = null;
        }
    }

    // ── Main update — called every frame ───────────────────────────────────

    update(nowMs) {
        // Advance spawn animation before anything else
        if (this.spawnAnim.active) {
            this.spawnAnim.progress = Math.min(1, this.spawnAnim.progress + 0.004);
            if (this.spawnAnim.progress >= 1) {
                this.spawnAnim.active = false;
                this.playerPos   = { x: this.spawnAnim.targetX, y: this.spawnAnim.targetY };
                this.lastStepPos = { ...this.playerPos };
            }
            return;
        }

        if (this.transitioning) return;

        this._movePlayer();
        this._checkDoorCrossing();
        this._decayFootprints(nowMs);
        this._interpolateRemotePlayers();
    }

    // ── Movement & collision ───────────────────────────────────────────────

    _movePlayer() {
        let dx = 0, dy = 0;
        if (this._keys['w'] || this._keys['arrowup'])    dy -= PLAYER_SPEED;
        if (this._keys['s'] || this._keys['arrowdown'])  dy += PLAYER_SPEED;
        if (this._keys['a'] || this._keys['arrowleft'])  dx -= PLAYER_SPEED;
        if (this._keys['d'] || this._keys['arrowright']) dx += PLAYER_SPEED;

        if (dx !== 0 && dy !== 0) {
            dx *= 0.7071;
            dy *= 0.7071;
        }

        this.velocity = { x: dx, y: dy };

        // Update heading toward movement direction
        if (dx !== 0 || dy !== 0) {
            this._targetHeading = Math.atan2(dy, dx);
        }
        // Smooth body turn — wrap to shortest path then lerp
        let da = this._targetHeading - this.playerHeading;
        da = ((da + Math.PI) % (Math.PI * 2)) - Math.PI;
        this.playerHeading += da * HEADING_LERP;

        if (dx === 0 && dy === 0) return;

        const nx = this.playerPos.x + dx;
        const ny = this.playerPos.y + dy;

        const bounds = this.viewState === VIEW.ROOM && this.currentRoom
            ? this._roomBounds()
            : { x: 0, y: 0, w: MAP_DATA.width, h: MAP_DATA.height };

        const cx = Math.max(bounds.x + 10, Math.min(bounds.x + bounds.w - 10, nx));
        const cy = Math.max(bounds.y + 10, Math.min(bounds.y + bounds.h - 10, ny));

        const finalPos = this.viewState === VIEW.OVERWORLD
            ? this._resolveWallCollision(this.playerPos, cx, cy)
            : { x: cx, y: cy };

        this.playerPos = finalPos;
        this._tryStampFootprint(dx, dy, this.footprints, this.lastStepPos);
    }

    _roomBounds() {
        const r = this.currentRoom;
        const pad = 20;
        return { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: r.h - pad * 2 };
    }

    _resolveWallCollision(from, nx, ny) {
        for (const room of MAP_DATA.rooms) {
            const door = getDoorHitbox(room);
            if (this._pointInRect(nx, ny, room) && !this._pointInRect(nx, ny, door)) {
                const slideX = { x: nx, y: from.y };
                const slideY = { x: from.x, y: ny };
                if (!this._pointInRect(slideX.x, slideX.y, room) || this._pointInRect(slideX.x, slideX.y, door)) return slideX;
                if (!this._pointInRect(slideY.x, slideY.y, room) || this._pointInRect(slideY.x, slideY.y, door)) return slideY;
                return from;
            }
        }
        return { x: nx, y: ny };
    }

    _pointInRect(x, y, rect) {
        return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    }

    // ── Door crossing detection ────────────────────────────────────────────

    _checkDoorCrossing() {
        if (this.viewState !== VIEW.OVERWORLD || this._doorCooldown) return;

        for (const room of MAP_DATA.rooms) {
            const door = getDoorHitbox(room);
            if (this._pointInRect(this.playerPos.x, this.playerPos.y, door)) {
                this._doorCooldown = true;
                if (this.onDoorEnter) this.onDoorEnter(room.id);
                this.enterRoom(room.id);
                setTimeout(() => { this._doorCooldown = false; }, 800);
                return;
            }
        }
    }

    enterRoom(roomId) {
        const room = MAP_DATA.rooms.find(r => r.id === roomId);
        if (!room) return;
        this.currentRoom = room;
        this.viewState   = VIEW.ROOM;
        this.playerPos = {
            x: room.x + room.w * 0.5,
            y: room.doorSide === 'bottom' ? room.y + room.h - 60 : room.y + 60,
        };
        this.lastStepPos = { ...this.playerPos };
        this.footprints  = [];
        if (this.onViewChange) this.onViewChange(VIEW.ROOM, room);
    }

    exitRoom() {
        if (!this.currentRoom) return;
        const room = this.currentRoom;
        this.viewState   = VIEW.OVERWORLD;
        this.currentRoom = null;
        const door = getDoorHitbox(room);
        this.playerPos = {
            x: door.x + door.w / 2,
            y: room.doorSide === 'bottom' ? door.y + door.h + 10 : door.y - 10,
        };
        this.lastStepPos = { ...this.playerPos };
        this.footprints  = [];
        this._doorCooldown = true;
        setTimeout(() => { this._doorCooldown = false; }, 800);
        if (this.onViewChange) this.onViewChange(VIEW.OVERWORLD, null, room);
    }

    // ── Footprint stamping (Marauder math) ────────────────────────────────

    _tryStampFootprint(dx, dy, footprintsArr, lastStep) {
        const pos  = this.playerPos;
        const dist = Math.hypot(pos.x - lastStep.x, pos.y - lastStep.y);
        if (dist < STEP_DISTANCE) return;

        const angle   = Math.atan2(dy, dx) + Math.PI / 2;
        const isRight = this.stepNumber % 2 === 0;
        const perpX   = -Math.sin(angle);
        const perpY   =  Math.cos(angle);
        const offset  = STEP_DISTANCE * STEP_WIDTH_FACTOR * (isRight ? 1 : -1);

        footprintsArr.push({
            x:         pos.x + perpX * offset,
            y:         pos.y + perpY * offset,
            angle,
            isRight,
            spawnTime: performance.now(),
        });

        while (footprintsArr.length > 3) footprintsArr.shift();

        lastStep.x = pos.x;
        lastStep.y = pos.y;
        this.stepNumber++;
    }

    _decayFootprints(nowMs) {
        const cutoff = nowMs - STEP_FADE_MS;
        for (let i = this.footprints.length - 1; i >= 0; i--) {
            if (this.footprints[i].spawnTime < cutoff) this.footprints.splice(i, 1);
        }
        for (const rp of this.remotePlayers.values()) {
            for (let i = rp.footprints.length - 1; i >= 0; i--) {
                if (rp.footprints[i].spawnTime < cutoff) rp.footprints.splice(i, 1);
            }
        }
    }

    // ── Remote player management ───────────────────────────────────────────

    upsertRemotePlayer(username, x, y, channelId) {
        if (!this.remotePlayers.has(username)) {
            this.remotePlayers.set(username, {
                pos:            { x, y },
                targetPos:      { x, y },
                channelId,
                footprints:     [],
                lastStepPos:    { x, y },
                stepNumber:     0,
                prevPos:        { x, y },
                heading:        0,
                _targetHeading: 0,
            });
        } else {
            const rp = this.remotePlayers.get(username);
            rp.prevPos   = { ...rp.pos };
            rp.targetPos = { x, y };
            rp.channelId = channelId;
        }
    }

    removeRemotePlayer(username) {
        this.remotePlayers.delete(username);
    }

    _interpolateRemotePlayers() {
        for (const rp of this.remotePlayers.values()) {
            const dx   = rp.targetPos.x - rp.pos.x;
            const dy   = rp.targetPos.y - rp.pos.y;
            const dist = Math.hypot(dx, dy);

            if (dist > 0.5) {
                // Fixed-step movement — matches PLAYER_SPEED so all users look the same pace.
                // 2× gives slight catch-up headroom for network jitter without snapping.
                const step = Math.min(dist, PLAYER_SPEED * 2);
                rp.pos.x += (dx / dist) * step;
                rp.pos.y += (dy / dist) * step;

                // Update remote heading
                rp._targetHeading = Math.atan2(dy, dx);
                let da = rp._targetHeading - rp.heading;
                da = ((da + Math.PI) % (Math.PI * 2)) - Math.PI;
                rp.heading += da * HEADING_LERP;

                // Stamp remote footprint
                const stepDist = Math.hypot(rp.pos.x - rp.lastStepPos.x, rp.pos.y - rp.lastStepPos.y);
                if (stepDist >= STEP_DISTANCE) {
                    const angle   = Math.atan2(dy, dx) + Math.PI / 2;
                    const isRight = rp.stepNumber % 2 === 0;
                    const perpX   = -Math.sin(angle);
                    const perpY   =  Math.cos(angle);
                    const offset  = STEP_DISTANCE * STEP_WIDTH_FACTOR * (isRight ? 1 : -1);
                    rp.footprints.push({
                        x:         rp.pos.x + perpX * offset,
                        y:         rp.pos.y + perpY * offset,
                        angle,
                        isRight,
                        spawnTime: performance.now(),
                    });
                    rp.lastStepPos.x = rp.pos.x;
                    rp.lastStepPos.y = rp.pos.y;
                    rp.stepNumber++;
                }
            }
        }
    }

    // ── Object interaction (ROOM view) ─────────────────────────────────────

    _hitTestObjects(worldX, worldY) {
        if (!this.currentRoom) return null;
        const room = this.currentRoom;
        for (const obj of room.objects) {
            const rx = room.x + obj.x * room.w;
            const ry = room.y + obj.y * room.h;
            const rw = obj.w * room.w;
            const rh = obj.h * room.h;
            if (worldX >= rx && worldX <= rx + rw && worldY >= ry && worldY <= ry + rh) {
                return obj;
            }
        }
        return null;
    }

    getCurrentChannelId() {
        if (this.viewState === VIEW.ROOM && this.currentRoom) {
            return this.currentRoom.channelId;
        }
        return 'lobby';
    }
}
