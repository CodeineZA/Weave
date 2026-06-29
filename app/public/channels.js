// channels.js — Single source of truth for Weave channel config.
// Loaded as a classic script before app.js and map/map.js (ES module).
// Array order = sidebar display order.

window.CHANNELS = [
    { channelId: 'lobby',           label: 'Lobby'          },
    { channelId: 'room:dungeon',    label: 'The Dungeon'    },
    { channelId: 'room:great-hall', label: 'The Great Hall' },
    { channelId: 'room:library',    label: 'The Library'    },
    { channelId: 'room:lounge',     label: 'The Lounge'     },
    { channelId: 'room:war-room',   label: 'The War Room'   },
];
