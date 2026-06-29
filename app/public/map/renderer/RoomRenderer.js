// RoomRenderer.js — Draws a single room stretched full-canvas (ROOM state).
// Handles room background, interactive objects, footprints, player names,
// and DOM overlay positioning for text-channel book and video portals.

import { STEP_FADE_MS } from '../engine/GameEngine.js';

export class RoomRenderer {
    constructor(theme, overlayEl) {
        this._theme     = theme;
        this._overlay   = overlayEl;  // #mapOverlay DOM element
        this._bgImg     = null;
        this._bgPat     = null;
        this._ftImgs    = { left: null, right: null };
        this._objSprites = {};         // type → HTMLImageElement | null
        this._loadAssets();
    }

    _loadAssets() {
        const t = this._theme;

        const bg = new Image();
        bg.onload = () => { this._bgImg = bg; };
        bg.onerror = () => { this._bgImg = null; };
        bg.src = t.backgroundImage;

        const fl = new Image();
        fl.onload = () => { this._ftImgs.left = fl; };
        fl.src = t.footprintImages.left;

        const fr = new Image();
        fr.onload = () => { this._ftImgs.right = fr; };
        fr.src = t.footprintImages.right;

        for (const [type, src] of Object.entries(t.objectSprites)) {
            if (!src) { this._objSprites[type] = null; continue; }
            const img = new Image();
            img.onload = () => { this._objSprites[type] = img; };
            img.onerror = () => { this._objSprites[type] = null; };
            img.src = src;
        }
    }

    // ── Main draw ──────────────────────────────────────────────────────────
    // ctx          : CanvasRenderingContext2D (identity transform — room fills canvas)
    // room         : current room object from MAP_DATA
    // engine       : GameEngine
    // myUsername   : string
    // nowMs        : performance.now()
    // activeStreams : array of { producerId, username } in this room

    draw(ctx, room, engine, myUsername, nowMs, activeStreams) {
        const cw = ctx.canvas.width;
        const ch = ctx.canvas.height;
        const t  = this._theme;

        // Compute the screen rect the room occupies (with padding)
        const pad  = Math.min(cw, ch) * t.roomPadding;
        const rx   = pad;
        const ry   = pad;
        const rw   = cw - pad * 2;
        const rh   = ch - pad * 2;

        // 1. Background fill
        this._drawRoomBackground(ctx, cw, ch, rx, ry, rw, rh);

        // 2. Room border and label
        this._drawRoomBorder(ctx, room, rx, ry, rw, rh);

        // 3. Objects (books, paintings, exit door)
        for (const obj of room.objects) {
            const skip = obj.condition === 'hasActiveStream' &&
                         !this._streamForSlot(activeStreams, obj.payload?.streamSlot);
            if (skip) continue;

            const sx = rx + obj.x * rw;
            const sy = ry + obj.y * rh;
            const sw = obj.w * rw;
            const sh = obj.h * rh;
            const isHovered = engine.hoveredObject?.id === obj.id;

            this._drawObject(ctx, obj, sx, sy, sw, sh, isHovered, activeStreams);
        }

        // 4. Footprints — only players in this room
        const roomChannel = room.channelId;
        for (const [username, rp] of engine.remotePlayers) {
            if (rp.channelId !== roomChannel) continue;
            this._drawFootprints(ctx, rp.footprints, nowMs, rx, ry, rw, rh, room);
            this._drawPlayerName(ctx, username, rp.pos.x, rp.pos.y, false, rx, ry, rw, rh, room);
        }
        this._drawFootprints(ctx, engine.footprints, nowMs, rx, ry, rw, rh, room);
        this._drawPlayerName(ctx, myUsername, engine.playerPos.x, engine.playerPos.y, true, rx, ry, rw, rh, room);
    }

    // ── Background ─────────────────────────────────────────────────────────

    _drawRoomBackground(ctx, cw, ch, rx, ry, rw, rh) {
        const t = this._theme;
        ctx.globalCompositeOperation = 'source-over';

        // Dim area outside the room rect
        ctx.fillStyle = 'rgba(20,10,5,0.72)';
        ctx.fillRect(0, 0, cw, ch);

        // Room fill
        if (this._bgImg) {
            if (!this._bgPat) this._bgPat = ctx.createPattern(this._bgImg, 'repeat');
            ctx.fillStyle = this._bgPat;
        } else {
            ctx.fillStyle = t.backgroundFallbackColor;
        }
        ctx.fillRect(rx, ry, rw, rh);
    }

    // ── Room border ────────────────────────────────────────────────────────

    _drawRoomBorder(ctx, room, rx, ry, rw, rh) {
        const t = this._theme;
        ctx.globalCompositeOperation = 'multiply';
        ctx.strokeStyle = t.colors.roomStroke;
        ctx.lineWidth   = t.wall.lineWidth * 1.5;
        ctx.setLineDash([]);
        ctx.strokeRect(rx, ry, rw, rh);

        ctx.fillStyle    = t.colors.inkDark;
        ctx.font         = t.fonts.roomLabel;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(room.label, rx + rw / 2, ry - 10);

        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Objects ────────────────────────────────────────────────────────────

    _drawObject(ctx, obj, sx, sy, sw, sh, isHovered, activeStreams) {
        const t = this._theme;

        ctx.save();
        ctx.globalCompositeOperation = 'multiply';

        const sprite = this._objSprites[obj.type];

        if (sprite) {
            ctx.globalAlpha = isHovered ? 1 : 0.9;
            ctx.drawImage(sprite, sx, sy, sw, sh);
        } else {
            // Placeholder rectangle
            let fill, stroke;
            if (obj.type === 'book')      { fill = t.colors.bookFill;     stroke = t.colors.bookStroke; }
            else if (obj.type === 'painting') { fill = t.colors.paintingFill; stroke = t.colors.paintingStroke; }
            else                          { fill = t.colors.exitFill;     stroke = t.colors.exitStroke; }

            ctx.fillStyle   = isHovered ? t.colors.hover : fill;
            ctx.strokeStyle = stroke;
            ctx.lineWidth   = 1.5;
            ctx.fillRect(sx, sy, sw, sh);
            ctx.strokeRect(sx, sy, sw, sh);

            // Icon glyph
            const glyph = obj.type === 'book' ? '📖'
                        : obj.type === 'exit-door' ? '🚪'
                        : '🖼';
            ctx.font         = `${Math.min(sw, sh) * 0.55}px serif`;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.globalAlpha  = 0.75;
            ctx.fillStyle    = stroke;
            ctx.fillText(glyph, sx + sw / 2, sy + sh * 0.38);
        }

        // Label below the object
        ctx.globalAlpha              = 1;
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle    = t.colors.inkMid;
        ctx.font         = t.fonts.objectLabel;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';

        // For paintings, show whose stream it is
        let label = obj.label;
        if (obj.type === 'painting') {
            const stream = this._streamForSlot(activeStreams, obj.payload?.streamSlot);
            label = stream ? `${stream.username}'s Stream` : '';
        }
        if (label) ctx.fillText(label, sx + sw / 2, sy + sh + 4);

        ctx.restore();
    }

    // ── Footprints ─────────────────────────────────────────────────────────

    _drawFootprints(ctx, footprints, nowMs, rx, ry, rw, rh, room) {
        const t = this._theme;
        const w = t.footprint.width;

        ctx.save();
        for (const fp of footprints) {
            const opacity = Math.max(0, (STEP_FADE_MS - (nowMs - fp.spawnTime)) / STEP_FADE_MS);
            if (opacity <= 0) continue;

            const sx = this._worldToScreen(fp.x, room.x, room.w, rx, rw);
            const sy = this._worldToScreen(fp.y, room.y, room.h, ry, rh);

            ctx.globalAlpha              = opacity;
            ctx.globalCompositeOperation = t.blendMode;
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(fp.angle);

            const img = fp.isRight ? this._ftImgs.right : this._ftImgs.left;
            if (img && img.complete && img.naturalWidth > 0) {
                const aspect = img.naturalHeight / img.naturalWidth;
                const h = w * aspect;
                ctx.drawImage(img, -w / 2, -h / 2, w, h);
            } else if (t.footprint.usePlaceholder) {
                ctx.fillStyle    = t.colors.inkMid;
                ctx.font         = `${w}px serif`;
                ctx.textAlign    = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(fp.isRight ? '☾' : '☽', 0, 0);
            }
            ctx.restore();
        }
        ctx.restore();
    }

    // ── Player name ────────────────────────────────────────────────────────

    _drawPlayerName(ctx, name, wx, wy, isLocal, rx, ry, rw, rh, room) {
        const t  = this._theme;
        const sx = this._worldToScreen(wx, room.x, room.w, rx, rw);
        const sy = this._worldToScreen(wy, room.y, room.h, ry, rh);

        ctx.save();
        ctx.globalCompositeOperation = t.blendMode;
        ctx.globalAlpha  = isLocal ? 1 : 0.88;
        ctx.fillStyle    = t.colors.playerInk;
        ctx.font         = t.fonts.playerName;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        if (isLocal) {
            const w = ctx.measureText(name).width;
            ctx.fillRect(sx - w / 2, sy + 14, w, 1);
        }
        ctx.fillText(name, sx, sy);
        ctx.restore();
    }

    // ── Coordinate mapping: world → screen ────────────────────────────────

    _worldToScreen(worldVal, roomOrigin, roomSize, screenOrigin, screenSize) {
        const t = (worldVal - roomOrigin) / roomSize;
        return screenOrigin + t * screenSize;
    }

    // ── Stream helpers ─────────────────────────────────────────────────────

    _streamForSlot(activeStreams, slot) {
        if (!activeStreams || slot == null) return null;
        return activeStreams[slot] || null;
    }
}
