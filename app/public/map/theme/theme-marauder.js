// theme-marauder.js — ALL visual configuration for the Marauder's Map theme.
// To swap the theme: create a new file with the same export shape and change
// the import in map.js. Zero engine or renderer logic lives here.

export const theme = {

    // ── Fonts ─────────────────────────────────────────────────────────────
    fonts: {
        playerName:  '600 20px "Cinzel Decorative", "Palatino Linotype", serif',
        roomLabel:   'italic 700 22px "Cinzel Decorative", "Palatino Linotype", serif',
        objectLabel: '500 14px "IM Fell English", "Georgia", serif',
        uiLabel:     '500 16px "IM Fell English", "Georgia", serif',
        spawnLabel:  'italic 600 18px "Cinzel Decorative", "Palatino Linotype", serif',
        overlay:     '500 15px "IM Fell English", "Georgia", serif',
    },

    // ── Colours ───────────────────────────────────────────────────────────
    colors: {
        inkDark:     '#1a0d05',
        inkMid:      '#3b1f0a',
        inkLight:    '#6b3a1f',
        inkFaint:    'rgba(59,31,10,0.25)',

        parchmentDark:  '#c8a96e',
        parchmentMid:   '#e4c98a',
        parchmentLight: '#f5e6c8',

        roomFill:    'rgba(59,31,10,0.07)',
        roomStroke:  '#3b1f0a',

        corridorFill: 'rgba(200,169,110,0.15)',

        door:        '#c8a96e',

        bookFill:    'rgba(90,50,15,0.18)',
        bookStroke:  '#3b1f0a',
        paintingFill:   'rgba(30,15,5,0.25)',
        paintingStroke: '#1a0d05',
        exitFill:    'rgba(180,130,60,0.20)',
        exitStroke:  '#6b3a1f',

        playerInk:   '#1a0d05',

        hover:       'rgba(180,120,40,0.35)',

        stationFill:   'rgba(59,31,10,0.12)',
        stationStroke: '#3b1f0a',
    },

    // ── Blend mode ────────────────────────────────────────────────────────
    blendMode: 'multiply',

    // ── Background ────────────────────────────────────────────────────────
    backgroundImage: 'assets/parchment.jpg',
    backgroundFallbackColor: '#f5e6c8',

    // ── Object sprites ────────────────────────────────────────────────────
    objectSprites: {
        'book':      null,
        'painting':  null,
        'exit-door': null,
    },

    // ── Footprint images ──────────────────────────────────────────────────
    footprintImages: {
        left:  'assets/footstep-left.svg',
        right: 'assets/footstep-right.svg',
    },

    // ── Footprint visual settings ─────────────────────────────────────────
    footprint: {
        width:          22,   // was 16 — thicker, more ink-like stamps
        usePlaceholder: true,
    },

    // ── Room wall style ───────────────────────────────────────────────────
    wall: {
        lineWidth:    3.5,    // was 2.5 — heavier ink lines
        dash:         [],
        cornerRadius: 4,
    },

    // ── Room label offset above room top wall ─────────────────────────────
    roomLabelOffsetY: -14,

    // ── Camera ────────────────────────────────────────────────────────────
    // viewFraction: fraction of MAP_WIDTH shown at once (0.25 = 500 world units wide)
    camera: {
        viewFraction: 0.50,   // show 50% of MAP_WIDTH — wider view (was 0.25)
        lerpSpeed:    0.08,
    },

    // ── Name label ────────────────────────────────────────────────────────
    labelAheadDist: 45,       // world units to lead name ahead of body direction

    // ── Transition effect between OVERWORLD and ROOM ──────────────────────
    transition: {
        style:      'zoom',
        durationMs: 380,
    },

    // ── Room view inner padding (fraction of canvas) ──────────────────────
    roomPadding: 0.06,
};
