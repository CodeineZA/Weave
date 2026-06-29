// VoIPBridge.js — Translates game engine channel events into mediasoup actions.
// Calls window.weave hooks that are exposed by app.js.
// The engine calls switchChannel(); this file handles everything else.

export class VoIPBridge {
    constructor() {
        this._currentChannelId = 'lobby';
    }

    // Called by GameEngine via map.js whenever view state changes
    switchChannel(newChannelId) {
        if (newChannelId === this._currentChannelId) return;
        this._currentChannelId = newChannelId;
        if (window.weave?.localChannelChange) {
            window.weave.localChannelChange(newChannelId);
        }
    }

    // Called when a user clicks a painting/portal object in a room.
    // producerId comes from the active stream list maintained by app.js.
    openStream(producerId) {
        if (window.weave?.consumeStream) {
            window.weave.consumeStream(producerId);
        }
    }

    // Returns the currently active streams (producer entries) for a given channelId.
    // Returns an array of { producerId, username } for paintings to bind to.
    getActiveStreams(channelId) {
        if (window.weave?.getActiveStreams) {
            return window.weave.getActiveStreams(channelId) || [];
        }
        return [];
    }

    getCurrentChannelId() {
        return this._currentChannelId;
    }
}
