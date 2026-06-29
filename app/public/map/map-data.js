// map-data.js — Pure floor plan data. No imports, no visuals, no logic.
// To add a room object: append an entry to the room's `objects` array.
// To add a room: append to MAP_DATA.rooms and channels.js.

const _ch = Object.fromEntries((window.CHANNELS || []).map(c => [c.channelId, c.label]));

export const MAP_DATA = {
    // World space dimensions (landscape)
    width:  2000,
    height: 1100,

    spawnPoint: { x: 1000, y: 960, label: 'The Train Station' },

    // Walkable corridor band between the two room rows
    corridor: { y: 340, h: 180 },

    rooms: [
        {
            id:    'lounge',
            label: _ch['room:lounge'] ?? 'The Lounge',
            channelId: 'room:lounge',
            x: 60,   y: 60,  w: 380, h: 260,
            doorSide:   'bottom',
            doorOffset: 0.5,   // fraction along that wall where the door gap sits
            doorWidth:  80,
            objects: [
                {
                    id:        'lounge-book',
                    type:      'book',
                    x:         0.25, y: 0.65,
                    w:         0.12, h: 0.14,
                    label:     'General Chat',
                    action:    'openTextChannel',
                    payload:   { channelId: 'lounge-general' },
                    condition: null,
                },
                {
                    id:        'lounge-painting-1',
                    type:      'painting',
                    x:         0.68, y: 0.20,
                    w:         0.14, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 0 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'lounge-painting-2',
                    type:      'painting',
                    x:         0.85, y: 0.20,
                    w:         0.10, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 1 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'lounge-exit',
                    type:      'exit-door',
                    x:         0.44, y: 0.88,
                    w:         0.12, h: 0.10,
                    label:     'Exit',
                    action:    'exitRoom',
                    payload:   {},
                    condition: null,
                },
            ],
        },

        {
            id:    'war-room',
            label: _ch['room:war-room'] ?? 'The War Room',
            channelId: 'room:war-room',
            x: 500,  y: 60,  w: 360, h: 260,
            doorSide:   'bottom',
            doorOffset: 0.5,
            doorWidth:  80,
            objects: [
                {
                    id:        'warroom-book',
                    type:      'book',
                    x:         0.20, y: 0.65,
                    w:         0.12, h: 0.14,
                    label:     'Strategy',
                    action:    'openTextChannel',
                    payload:   { channelId: 'war-room-strategy' },
                    condition: null,
                },
                {
                    id:        'warroom-painting-1',
                    type:      'painting',
                    x:         0.65, y: 0.20,
                    w:         0.14, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 0 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'warroom-painting-2',
                    type:      'painting',
                    x:         0.82, y: 0.20,
                    w:         0.10, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 1 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'warroom-exit',
                    type:      'exit-door',
                    x:         0.44, y: 0.88,
                    w:         0.12, h: 0.10,
                    label:     'Exit',
                    action:    'exitRoom',
                    payload:   {},
                    condition: null,
                },
            ],
        },

        {
            id:    'library',
            label: _ch['room:library'] ?? 'The Library',
            channelId: 'room:library',
            x: 920,  y: 60,  w: 380, h: 260,
            doorSide:   'bottom',
            doorOffset: 0.5,
            doorWidth:  80,
            objects: [
                {
                    id:        'library-book',
                    type:      'book',
                    x:         0.22, y: 0.65,
                    w:         0.12, h: 0.14,
                    label:     'Reading Room',
                    action:    'openTextChannel',
                    payload:   { channelId: 'library-reading' },
                    condition: null,
                },
                {
                    id:        'library-painting-1',
                    type:      'painting',
                    x:         0.66, y: 0.20,
                    w:         0.14, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 0 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'library-painting-2',
                    type:      'painting',
                    x:         0.83, y: 0.20,
                    w:         0.10, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 1 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'library-exit',
                    type:      'exit-door',
                    x:         0.44, y: 0.88,
                    w:         0.12, h: 0.10,
                    label:     'Exit',
                    action:    'exitRoom',
                    payload:   {},
                    condition: null,
                },
            ],
        },

        {
            id:    'dungeon',
            label: _ch['room:dungeon'] ?? 'The Dungeon',
            channelId: 'room:dungeon',
            x: 60,   y: 540, w: 380, h: 280,
            doorSide:   'top',
            doorOffset: 0.5,
            doorWidth:  80,
            objects: [
                {
                    id:        'dungeon-book',
                    type:      'book',
                    x:         0.25, y: 0.65,
                    w:         0.12, h: 0.14,
                    label:     'Dark Arts',
                    action:    'openTextChannel',
                    payload:   { channelId: 'dungeon-dark' },
                    condition: null,
                },
                {
                    id:        'dungeon-painting-1',
                    type:      'painting',
                    x:         0.70, y: 0.20,
                    w:         0.14, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 0 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'dungeon-exit',
                    type:      'exit-door',
                    x:         0.44, y: 0.05,
                    w:         0.12, h: 0.10,
                    label:     'Exit',
                    action:    'exitRoom',
                    payload:   {},
                    condition: null,
                },
            ],
        },

        {
            id:    'great-hall',
            label: _ch['room:great-hall'] ?? 'The Great Hall',
            channelId: 'room:great-hall',
            x: 500,  y: 540, w: 1440, h: 280,
            doorSide:   'top',
            doorOffset: 0.18,
            doorWidth:  80,
            objects: [
                {
                    id:        'hall-book-1',
                    type:      'book',
                    x:         0.18, y: 0.65,
                    w:         0.07, h: 0.14,
                    label:     'Announcements',
                    action:    'openTextChannel',
                    payload:   { channelId: 'hall-announcements' },
                    condition: null,
                },
                {
                    id:        'hall-book-2',
                    type:      'book',
                    x:         0.28, y: 0.65,
                    w:         0.07, h: 0.14,
                    label:     'General',
                    action:    'openTextChannel',
                    payload:   { channelId: 'hall-general' },
                    condition: null,
                },
                {
                    id:        'hall-painting-1',
                    type:      'painting',
                    x:         0.55, y: 0.15,
                    w:         0.08, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 0 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'hall-painting-2',
                    type:      'painting',
                    x:         0.66, y: 0.15,
                    w:         0.08, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 1 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'hall-painting-3',
                    type:      'painting',
                    x:         0.77, y: 0.15,
                    w:         0.08, h: 0.28,
                    label:     '',
                    action:    'openStream',
                    payload:   { streamSlot: 2 },
                    condition: 'hasActiveStream',
                },
                {
                    id:        'hall-exit',
                    type:      'exit-door',
                    x:         0.17, y: 0.05,
                    w:         0.06, h: 0.10,
                    label:     'Exit',
                    action:    'exitRoom',
                    payload:   {},
                    condition: null,
                },
            ],
        },
    ],
};

// Derive door hitbox rects in world space for collision checks.
// Returns { x, y, w, h } in world coordinates.
export function getDoorHitbox(room) {
    const GAP = room.doorWidth;
    const DEPTH = 30; // how deep into the corridor the hitbox extends
    const cx = room.x + room.w * room.doorOffset;
    if (room.doorSide === 'bottom') {
        return { x: cx - GAP / 2, y: room.y + room.h - 2, w: GAP, h: DEPTH };
    }
    return { x: cx - GAP / 2, y: room.y - DEPTH + 2, w: GAP, h: DEPTH };
}
