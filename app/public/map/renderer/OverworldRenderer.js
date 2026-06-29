// OverworldRenderer.js — Draws the full landscape map (OVERWORLD state).
// Reads engine state and theme config. Contains zero game logic.

import { MAP_DATA, getDoorHitbox } from '../map-data.js';
import { STEP_FADE_MS } from '../engine/GameEngine.js';

export class OverworldRenderer {
    constructor(theme) {
        this._theme  = theme;
        this._bgImg  = null;
        this._bgPat  = null;
        this._ftImgs = { left: null, right: null };
        this._cobblestones = this._generateCobblestones();
        this._loadAssets();
    }

    _loadAssets() {
        const t = this._theme;

        const bg = new Image();
        bg.onload = () => { this._bgImg = bg; this._bgPat = null; };
        bg.onerror = () => { this._bgImg = null; };
        bg.src = t.backgroundImage;

        const fl = new Image();
        fl.onload = () => { this._ftImgs.left = fl; };
        fl.src = t.footprintImages.left;

        const fr = new Image();
        fr.onload = () => { this._ftImgs.right = fr; };
        fr.src = t.footprintImages.right;
    }

    // ── Cobblestone precomputation ─────────────────────────────────────────
    // Uses a simple LCG RNG — no library needed, deterministic each load.

    _generateCobblestones() {
        const stones = [];
        let seed = 314159;
        const rng = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        const rooms  = MAP_DATA.rooms;
        const PAD    = 22;

        for (let attempt = 0; attempt < 700 && stones.length < 160; attempt++) {
            const x = rng() * MAP_DATA.width;
            const y = rng() * MAP_DATA.height;

            // Skip positions inside or near any room
            const blocked = rooms.some(
                r => x > r.x - PAD && x < r.x + r.w + PAD &&
                     y > r.y - PAD && y < r.y + r.h + PAD
            );
            if (blocked) continue;

            // Also skip inside the spawn landmark box (±130 ×±40 around spawnPoint)
            const sp = MAP_DATA.spawnPoint;
            if (Math.abs(x - sp.x) < 130 && Math.abs(y - sp.y) < 40) continue;

            stones.push({
                x,
                y,
                w:     18 + rng() * 28,
                h:     10 + rng() * 16,
                angle: (rng() - 0.5) * 0.55,
            });
        }
        return stones;
    }

    // ── Main draw entry point ──────────────────────────────────────────────

    draw(ctx, engine, myUsername, nowMs, playerPosOverride = null) {
        const t = this._theme;

        // 1. Background
        this._drawBackground(ctx);

        // 2. Cobblestone ground
        this._drawCobblestones(ctx);

        // 3. Corridor tint
        this._drawCorridor(ctx);

        // 4. Rooms — wavy walls + door eddies
        MAP_DATA.rooms.forEach((room, idx) => {
            this._drawRoom(ctx, room, idx, nowMs);
        });

        // 5. Train Station landmark
        this._drawSpawn(ctx);

        // 6. Remote player footprints
        for (const rp of engine.remotePlayers.values()) {
            this._drawFootprints(ctx, rp.footprints, nowMs);
        }

        // 7. Local player footprints (skip during spawn)
        const localFootprints = playerPosOverride ? [] : engine.footprints;
        this._drawFootprints(ctx, localFootprints, nowMs);

        // 8. All names via collision-resolved label positions
        this._drawAllNames(ctx, engine, myUsername, nowMs, playerPosOverride);

        // 9. Spawn sludge — top layer, only when active
        this._drawSpawnSludge(ctx, engine, nowMs);
    }

    // ── Background ─────────────────────────────────────────────────────────

    _drawBackground(ctx) {
        const t = this._theme;
        const { width, height } = MAP_DATA;

        ctx.globalCompositeOperation = 'source-over';
        if (this._bgImg) {
            if (!this._bgPat) this._bgPat = ctx.createPattern(this._bgImg, 'repeat');
            ctx.fillStyle = this._bgPat;
        } else {
            ctx.fillStyle = t.backgroundFallbackColor;
        }
        ctx.fillRect(0, 0, width, height);
    }

    // ── Cobblestone ground texture ─────────────────────────────────────────

    _drawCobblestones(ctx) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.strokeStyle = 'rgba(59,31,10,0.22)';
        ctx.lineWidth   = 0.9;
        for (const s of this._cobblestones) {
            ctx.save();
            ctx.translate(s.x, s.y);
            ctx.rotate(s.angle);
            const r = Math.min(s.w, s.h) * 0.28;
            this._roundRect(ctx, -s.w / 2, -s.h / 2, s.w, s.h, r);
            ctx.stroke();
            ctx.restore();
        }
        ctx.restore();
    }

    // ── Corridor tint ──────────────────────────────────────────────────────

    _drawCorridor(ctx) {
        const t = this._theme;
        const c = MAP_DATA.corridor;
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = t.colors.corridorFill;
        ctx.fillRect(0, c.y, MAP_DATA.width, c.h);
        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Train Station spawn ────────────────────────────────────────────────

    _drawSpawn(ctx) {
        const t = this._theme;
        const s = MAP_DATA.spawnPoint;
        const w = 240, h = 70;
        const x = s.x - w / 2, y = s.y - h / 2;

        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle   = t.colors.stationFill;
        ctx.strokeStyle = t.colors.stationStroke;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 4]);
        this._roundRect(ctx, x, y, w, h, 6);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle    = t.colors.inkMid;
        ctx.font         = t.fonts.spawnLabel;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✦  ' + s.label + '  ✦', s.x, s.y);
        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Room ───────────────────────────────────────────────────────────────

    _drawRoom(ctx, room, roomIdx, nowMs) {
        const t    = this._theme;
        const door = getDoorHitbox(room);
        const seed = roomIdx * 2.7;

        // Room fill
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = t.colors.roomFill;
        ctx.fillRect(room.x, room.y, room.w, room.h);

        // Animated wavy walls
        ctx.strokeStyle = t.colors.roomStroke;
        ctx.lineWidth   = t.wall.lineWidth;
        ctx.setLineDash(t.wall.dash);
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';

        this._drawWallsWithDoor(ctx, room, door, nowMs, seed);

        ctx.setLineDash([]);

        // Door eddy effect
        this._drawDoorEddy(ctx, room, door, nowMs);

        // Room label
        ctx.fillStyle    = t.colors.inkDark;
        ctx.font         = t.fonts.roomLabel;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(room.label, room.x + room.w / 2, room.y + t.roomLabelOffsetY);

        ctx.globalCompositeOperation = 'source-over';
    }

    // ── Animated wavy wall segments ────────────────────────────────────────

    _wavySegment(ctx, x1, y1, x2, y2, nowMs, seed) {
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 1) return;
        const steps = Math.max(3, Math.ceil(len / 10));
        const sdx   = (x2 - x1) / len;
        const sdy   = (y2 - y1) / len;
        const nx    = -sdy;   // perpendicular unit normal
        const ny    =  sdx;
        const phase = nowMs * 0.0007 + seed;

        ctx.moveTo(x1, y1);
        for (let i = 1; i <= steps; i++) {
            const t     = i / steps;
            const taper = Math.sin(t * Math.PI);   // tapers naturally at segment ends
            const off   = 1.8 * taper * Math.sin(i * 1.1 + phase);
            ctx.lineTo(x1 + sdx * len * t + nx * off, y1 + sdy * len * t + ny * off);
        }
    }

    _drawWallsWithDoor(ctx, room, door, nowMs, seed) {
        const { x, y, w, h, doorSide, doorOffset, doorWidth } = room;
        const cx    = x + w * doorOffset;
        const dHalf = doorWidth / 2;

        ctx.beginPath();

        if (doorSide === 'bottom') {
            this._wavySegment(ctx, x,          y,     x + w,        y,     nowMs, seed);
            this._wavySegment(ctx, x + w,      y,     x + w,        y + h, nowMs, seed + 1);
            this._wavySegment(ctx, x,          y + h, cx - dHalf,   y + h, nowMs, seed + 2);
            this._wavySegment(ctx, cx + dHalf, y + h, x + w,        y + h, nowMs, seed + 3);
            this._wavySegment(ctx, x,          y,     x,            y + h, nowMs, seed + 4);
        } else {
            this._wavySegment(ctx, x,          y + h, x + w,        y + h, nowMs, seed);
            this._wavySegment(ctx, x + w,      y,     x + w,        y + h, nowMs, seed + 1);
            this._wavySegment(ctx, x,          y,     cx - dHalf,   y,     nowMs, seed + 2);
            this._wavySegment(ctx, cx + dHalf, y,     x + w,        y,     nowMs, seed + 3);
            this._wavySegment(ctx, x,          y,     x,            y + h, nowMs, seed + 4);
        }

        ctx.stroke();

        // Door threshold marker
        ctx.strokeStyle = this._theme.colors.door;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (doorSide === 'bottom') {
            ctx.moveTo(cx - dHalf, y + h); ctx.lineTo(cx + dHalf, y + h);
        } else {
            ctx.moveTo(cx - dHalf, y); ctx.lineTo(cx + dHalf, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = this._theme.colors.roomStroke;
    }

    // ── Door eddy — ink drawn into the opening ─────────────────────────────

    _drawDoorEddy(ctx, room, door, nowMs) {
        const cx = door.x + door.w / 2;
        const cy = room.doorSide === 'bottom' ? door.y : door.y + door.h;
        const t  = (nowMs * 0.0012) % (Math.PI * 2);

        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.strokeStyle = this._theme.colors.inkFaint;
        ctx.lineWidth   = 1;

        for (let i = 0; i < 3; i++) {
            const a = t + i * (Math.PI * 2 / 3);
            const r = 7 + 3 * Math.sin(t + i);
            ctx.globalAlpha = 0.28;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.5, 0, Math.PI * 1.4);
            ctx.stroke();
        }
        ctx.restore();
    }

    // ── Footprints ─────────────────────────────────────────────────────────

    _drawFootprints(ctx, footprints, nowMs) {
        const t = this._theme;
        const w = t.footprint.width;

        ctx.save();
        for (const fp of footprints) {
            const opacity = Math.max(0, (STEP_FADE_MS - (nowMs - fp.spawnTime)) / STEP_FADE_MS);
            if (opacity <= 0) continue;

            ctx.globalAlpha              = opacity;
            ctx.globalCompositeOperation = t.blendMode;

            const img = fp.isRight ? this._ftImgs.right : this._ftImgs.left;

            ctx.save();
            ctx.translate(fp.x, fp.y);
            ctx.rotate(fp.angle);

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

    // ── All names: resolve label positions, draw with smoke effect ─────────

    _drawAllNames(ctx, engine, myUsername, nowMs, playerPosOverride) {
        const t = this._theme;

        // Gather all players with position + heading
        const players = [];

        for (const [username, rp] of engine.remotePlayers) {
            players.push({ name: username, x: rp.pos.x, y: rp.pos.y, heading: rp.heading, isLocal: false });
        }

        const localX = playerPosOverride?.x ?? engine.playerPos.x;
        const localY = playerPosOverride?.y ?? engine.playerPos.y;
        // Don't draw local player name during spawn offscreen phase
        if (localX > -100) {
            players.push({ name: myUsername, x: localX, y: localY, heading: engine.playerHeading, isLocal: true });
        }

        if (players.length === 0) return;

        // Resolve label positions with spring repulsion
        const labels = this._resolveLabels(players, t.labelAheadDist);

        // Draw swirl arcs between very-close label pairs
        ctx.save();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = t.colors.inkMid;
        for (let i = 0; i < labels.length - 1; i++) {
            for (let j = i + 1; j < labels.length; j++) {
                const d = Math.hypot(labels[j].x - labels[i].x, labels[j].y - labels[i].y);
                if (d < 40) {
                    const mx = (labels[i].x + labels[j].x) / 2;
                    const my = (labels[i].y + labels[j].y) / 2;
                    ctx.globalAlpha              = (1 - d / 40) * 0.35;
                    ctx.globalCompositeOperation = 'multiply';
                    ctx.beginPath();
                    ctx.arc(mx, my, 10 + (nowMs * 0.001 % 5), 0, Math.PI * 1.6);
                    ctx.stroke();
                }
            }
        }
        ctx.restore();

        // Draw each label
        for (let i = 0; i < players.length; i++) {
            this._drawPlayerName(ctx, players[i].name, labels[i].x, labels[i].y, players[i].isLocal);
        }
    }

    // ── Spring repulsion for label positions ───────────────────────────────

    _resolveLabels(players, aheadDist) {
        const L = players.map(p => ({
            x: p.x + Math.cos(p.heading) * aheadDist,
            y: p.y + Math.sin(p.heading) * aheadDist - 28,
        }));

        const MIN_D = 80;
        for (let iter = 0; iter < 4; iter++) {
            for (let i = 0; i < L.length; i++) {
                for (let j = i + 1; j < L.length; j++) {
                    const dx = L[j].x - L[i].x;
                    const dy = L[j].y - L[i].y;
                    const d  = Math.hypot(dx, dy);
                    if (d > 0 && d < MIN_D) {
                        const push = (MIN_D - d) / d * 0.5;
                        L[i].x -= dx * push;  L[i].y -= dy * push;
                        L[j].x += dx * push;  L[j].y += dy * push;
                    }
                }
            }
        }
        return L;
    }

    // ── Smoky player name label ────────────────────────────────────────────

    _drawPlayerName(ctx, name, x, y, isLocal) {
        const t = this._theme;
        ctx.save();
        ctx.globalCompositeOperation = t.blendMode;
        ctx.fillStyle    = t.colors.playerInk;
        ctx.font         = t.fonts.playerName;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';

        // Ghost / smoke pass — blurred, low alpha
        ctx.filter      = 'blur(5px)';
        ctx.globalAlpha = isLocal ? 0.22 : 0.16;
        ctx.fillText(name, x, y);

        // Crisp ink pass on top
        ctx.filter      = 'none';
        ctx.globalAlpha = isLocal ? 0.82 : 0.65;
        ctx.fillText(name, x, y);

        ctx.restore();
    }

    // ── Spawn sludge animation ─────────────────────────────────────────────
    // Looks like a thick ink brush sweeping left→right, leaving opaque bristle
    // strokes behind, with an organic leading glob and ink drips ahead of it.

    _drawSpawnSludge(ctx, engine, nowMs) {
        const sa = engine.spawnAnim;
        if (!sa?.active) return;

        const p     = sa.progress;
        const t     = nowMs * 0.003;
        const blobX = -220 + p * (MAP_DATA.width + 440);
        const blobY = sa.targetY;

        ctx.save();
        ctx.globalCompositeOperation = 'multiply';

        // ── 1. Opaque bristle trail left behind ──────────────────────────
        // Several horizontal brush strokes with wavy edges — looks like real ink
        if (blobX > 0) {
            const trailEnd = Math.min(blobX + 10, MAP_DATA.width);
            const ROWS = 7;
            for (let row = 0; row < ROWS; row++) {
                const centre  = blobY - 30 + row * 10;
                const halfH   = 5 + (row === 0 || row === ROWS - 1 ? 1 : 3);
                // Rows near the middle are more opaque — gives body to the stroke
                const alpha   = 0.72 - Math.abs(row - (ROWS - 1) / 2) * 0.07;
                const freqTop = 0.06 + row * 0.008;
                const freqBot = 0.06 + row * 0.009;
                const phTop   = row * 1.4;
                const phBot   = row * 1.4 + 2.0;

                ctx.globalAlpha = alpha;
                ctx.fillStyle   = this._theme.colors.inkDark;
                ctx.beginPath();

                // Top edge — wavy (bristle texture)
                ctx.moveTo(0, centre - halfH);
                for (let x = 0; x <= trailEnd; x += 18) {
                    ctx.lineTo(x, centre - halfH + Math.sin(x * freqTop + phTop) * 3.5);
                }
                // Right cap of trail
                ctx.lineTo(trailEnd, centre + halfH);
                // Bottom edge — wavy (independent phase from top)
                for (let x = trailEnd; x >= 0; x -= 18) {
                    ctx.lineTo(x, centre + halfH + Math.sin(x * freqBot + phBot) * 3.5);
                }
                ctx.closePath();
                ctx.fill();
            }
        }

        // ── 2. Leading ink glob — organic bezier shape ───────────────────
        const bw = 95 + 14 * Math.sin(t * 1.2);
        const bh = 40 + 9  * Math.sin(t * 1.8);

        ctx.globalAlpha = 0.94;
        ctx.fillStyle   = this._theme.colors.inkDark;
        ctx.beginPath();
        ctx.moveTo(blobX - bw * 0.55, blobY - bh * 0.18);
        ctx.bezierCurveTo(
            blobX - bw * 0.3,  blobY - bh,
            blobX + bw * 0.05, blobY - bh * 0.85,
            blobX + bw * 0.45, blobY - bh * 0.35
        );
        ctx.bezierCurveTo(
            blobX + bw * 0.75, blobY + bh * 0.05,
            blobX + bw * 0.85, blobY + bh * 0.4,
            blobX + bw * 0.5,  blobY + bh * 0.82
        );
        ctx.bezierCurveTo(
            blobX + bw * 0.1,  blobY + bh,
            blobX - bw * 0.25, blobY + bh * 0.9,
            blobX - bw * 0.55, blobY + bh * 0.18
        );
        ctx.closePath();
        ctx.fill();

        // ── 3. Ink drips at the leading edge ─────────────────────────────
        for (let i = 0; i < 5; i++) {
            const dx     = 20 + i * 28 + Math.sin(t + i * 1.7) * 8;
            const dy     = Math.sin(t * 1.3 + i * 2.1) * 18;
            const radius = Math.max(1, 5.5 - i * 0.8);
            ctx.globalAlpha = 0.68 - i * 0.1;
            ctx.beginPath();
            ctx.ellipse(blobX + bw * 0.5 + dx, blobY + dy,
                        radius * 0.7, radius, Math.sin(t + i) * 0.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Small scattered splat dots even further ahead
        for (let i = 0; i < 4; i++) {
            const sx = blobX + bw * 0.5 + 80 + i * 24 + Math.sin(t * 2.1 + i) * 12;
            const sy = blobY + Math.sin(t + i * 2.5) * 22;
            ctx.globalAlpha = 0.45 - i * 0.08;
            ctx.beginPath();
            ctx.arc(sx, sy, Math.max(0.5, 3.5 - i * 0.6), 0, Math.PI * 2);
            ctx.fill();
        }

        // ── 4. Player materialises at landing spot ────────────────────────
        if (p > 0.82) {
            const reveal = (p - 0.82) / 0.18;
            ctx.globalAlpha = reveal * 0.78;
            ctx.fillStyle   = this._theme.colors.inkDark;
            ctx.beginPath();
            ctx.arc(sa.targetX, sa.targetY, 24 * (1 - reveal) + 4, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    // ── Utility ────────────────────────────────────────────────────────────

    _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }
}
