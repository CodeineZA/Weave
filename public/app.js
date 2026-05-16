let ws = null;
let myUsername = null;
let roomPassword = null;
let pendingJoin = false;
let localStream = null;
let screenStream = null;
let isMuted = false;
let isScreenSharing = false;
let joined = false;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const peerConnections = new Map();
const screenVideos = new Map();
const voiceAnalysers = new Map();
let connectedUsers = [];
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const usersList = document.getElementById('users-list');
const userCount = document.getElementById('user-count');
const screenGrid = document.getElementById('screen-grid');
const emptyState = document.getElementById('empty-state');
const muteBtn = document.getElementById('mute-btn');
const muteIcon = document.getElementById('mute-icon');
const muteText = document.getElementById('mute-text');
const screenBtn = document.getElementById('screen-btn');
const screenIcon = document.getElementById('screen-icon');
const screenText = document.getElementById('screen-text');
const leaveBtn = document.getElementById('leave-btn');
const myUsernameDisplay = document.getElementById('my-username-display');
const hiddenAudio = document.getElementById('hidden-audio');

function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ['#00d4ff', '#ff00aa', '#00ff88', '#ffaa00', '#aa88ff'];
    return colors[Math.abs(hash) % colors.length];
}

function createAvatar(username) {
    const element = document.createElement('div');
    element.className = 'avatar';
    element.style.backgroundColor = getAvatarColor(username);
    element.textContent = username[0]?.toUpperCase() || '?';
    return element;
}

function updateUsersList() {
    usersList.innerHTML = '';
    connectedUsers.forEach((user) => {
        if (user === myUsername) {
            return;
        }

        const item = document.createElement('div');
        item.className = 'user-item';

        const avatar = createAvatar(user);
        const name = document.createElement('span');
        name.className = 'username';
        name.textContent = user;

        const speaking = document.createElement('span');
        speaking.id = `speaking-${user}`;
        speaking.className = 'speaking';
        speaking.style.display = 'none';
        speaking.innerHTML = '<span class="speaking-dot"></span> speaking';

        item.appendChild(avatar);
        item.appendChild(name);
        item.appendChild(speaking);
        usersList.appendChild(item);
    });

    userCount.textContent = connectedUsers.length.toString();
}

function addUser(username) {
    if (!connectedUsers.includes(username)) {
        connectedUsers.push(username);
        updateUsersList();
    }
}

function removeUser(username) {
    connectedUsers = connectedUsers.filter((user) => user !== username);
    updateUsersList();

    if (peerConnections.has(username)) {
        peerConnections.get(username).close();
        peerConnections.delete(username);
    }

    if (screenVideos.has(username)) {
        screenVideos.get(username).remove();
        screenVideos.delete(username);
    }

    if (voiceAnalysers.has(username)) {
        clearInterval(voiceAnalysers.get(username).interval);
        voiceAnalysers.delete(username);
    }

    checkEmptyState();
}

function checkEmptyState() {
    emptyState.style.display = screenVideos.size === 0 ? 'flex' : 'none';
}

function addScreenToGrid(username, stream) {
    if (screenVideos.has(username)) {
        return;
    }

    const container = document.createElement('div');
    container.className = 'screen-container';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;

    const label = document.createElement('div');
    label.className = 'screen-label';
    label.textContent = username === myUsername ? 'You (screen)' : username;

    container.appendChild(video);
    container.appendChild(label);
    screenGrid.appendChild(container);
    screenVideos.set(username, container);
    checkEmptyState();
}

function removeScreenFromGrid(username) {
    if (!screenVideos.has(username)) {
        return;
    }
    screenVideos.get(username).remove();
    screenVideos.delete(username);
    checkEmptyState();
}

function startVoiceActivityDetection(username, stream) {
    if (voiceAnalysers.has(username)) {
        return;
    }

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const speakingEl = document.getElementById(`speaking-${username}`);
    const check = () => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i];
        }
        const average = sum / data.length;
        if (speakingEl) {
            speakingEl.style.display = average > 24 ? 'flex' : 'none';
        }
    };

    const interval = setInterval(check, 180);
    voiceAnalysers.set(username, { context: audioContext, analyser, interval });
}

async function initLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        return true;
    } catch (err) {
        console.error('Microphone access denied', err);
        joinError.textContent = 'Microphone access is required for voice chat.';
        return false;
    }
}

function createPeerConnection(peerUsername) {
    if (peerConnections.has(peerUsername)) {
        return peerConnections.get(peerUsername);
    }

    const pc = new RTCPeerConnection({ iceServers });
    peerConnections.set(peerUsername, pc);

    if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ice_candidate',
                to: peerUsername,
                candidate: event.candidate
            }));
        }
    };

    pc.ontrack = (event) => {
        const track = event.track;
        const stream = event.streams[0] || new MediaStream([track]);

        if (track.kind === 'audio') {
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.srcObject = stream;
            hiddenAudio.appendChild(audio);
            startVoiceActivityDetection(peerUsername, stream);
        }

        if (track.kind === 'video') {
            addScreenToGrid(peerUsername, stream);
            track.onended = () => removeScreenFromGrid(peerUsername);
        }
    };

    pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            removeUser(peerUsername);
        }
    };

    return pc;
}

async function renegotiateConnection(peerUsername, pc) {
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'offer',
                to: peerUsername,
                offer: pc.localDescription
            }));
        }
    } catch (err) {
        console.error('Renegotiation error', err);
    }
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        reconnectAttempts = 0;
        console.log('✅ WebSocket connected');
        if (myUsername && roomPassword) {
            ws.send(JSON.stringify({
                type: 'join',
                username: myUsername,
                password: roomPassword
            }));
            pendingJoin = false;
        }
    };

    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'join_ack') {
            joined = true;
            iceServers = msg.iceServers || iceServers;
            connectedUsers = msg.users.map((u) => u.username);

            const mediaReady = await initLocalMedia();
            if (!mediaReady) {
                return;
            }

            myUsernameDisplay.textContent = myUsername;
            updateUsersList();

            for (const user of connectedUsers) {
                if (user === myUsername) {
                    continue;
                }
                const pc = createPeerConnection(user);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: 'offer', to: user, offer: pc.localDescription }));
            }

            joinScreen.classList.add('hidden');
            roomScreen.classList.remove('hidden');
            checkEmptyState();
            return;
        }

        if (msg.type === 'join_rejected') {
            joinError.textContent = msg.reason || 'Join failed';
            return;
        }

        if (msg.type === 'user_joined') {
            addUser(msg.username);
            if (msg.username !== myUsername) {
                createPeerConnection(msg.username);
            }
            return;
        }

        if (msg.type === 'user_left') {
            removeUser(msg.username);
            return;
        }

        if (msg.type === 'offer') {
            const pc = createPeerConnection(msg.from);
            await pc.setRemoteDescription(msg.offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', to: msg.from, answer: pc.localDescription }));
            return;
        }

        if (msg.type === 'answer') {
            const pc = peerConnections.get(msg.from);
            if (pc) {
                await pc.setRemoteDescription(msg.answer);
            }
            return;
        }

        if (msg.type === 'ice_candidate') {
            const pc = peerConnections.get(msg.from);
            if (pc) {
                await pc.addIceCandidate(msg.candidate).catch(() => {});
            }
            return;
        }
    };

    ws.onclose = () => {
        console.log('WebSocket closed');
        if (joined && reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts += 1;
            setTimeout(connectWebSocket, reconnectAttempts * 2000);
        } else if (joined) {
            alert('Connection lost. Refresh to try again.');
        }
    };

    ws.onerror = (err) => console.error('WebSocket error', err);
}

async function startScreenShare() {
    if (isScreenSharing) {
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false
        });

        const screenTrack = screenStream.getVideoTracks()[0];
        for (const [username, pc] of peerConnections.entries()) {
            pc.addTrack(screenTrack, screenStream);
            await renegotiateConnection(username, pc);
        }

        addScreenToGrid(myUsername, screenStream);
        isScreenSharing = true;
        screenBtn.classList.add('active');
        screenIcon.textContent = '⏹️';
        screenText.textContent = 'Stop sharing';

        screenTrack.onended = () => stopScreenShare(true);
    } catch (err) {
        console.error('Screen share failed', err);
    }
}

function stopScreenShare(fromBrowser = false) {
    if (!isScreenSharing) {
        return;
    }

    if (screenStream) {
        screenStream.getTracks().forEach((track) => track.stop());
        screenStream = null;
    }

    removeScreenFromGrid(myUsername);
    isScreenSharing = false;
    screenBtn.classList.remove('active');
    screenIcon.textContent = '📺';
    screenText.textContent = 'Share screen';

    if (!fromBrowser) {
        // no extra cleanup needed; remote peers will stop receiving stream once track ends
    }
}

function toggleMute() {
    if (!localStream) {
        return;
    }
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
    });
    muteBtn.classList.toggle('active', isMuted);
    muteIcon.textContent = isMuted ? '🔇' : '🎤';
    muteText.textContent = isMuted ? 'Unmute' : 'Mute';
}

function leaveRoom() {
    if (ws) {
        ws.close();
    }
    joined = false;
    pendingJoin = false;

    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    screenVideos.forEach((container) => container.remove());
    screenVideos.clear();
    voiceAnalysers.forEach(({ interval }) => clearInterval(interval));
    voiceAnalysers.clear();

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach((track) => track.stop());
        screenStream = null;
    }

    roomScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
    joinError.textContent = '';
    connectedUsers = [];
    updateUsersList();
    checkEmptyState();
}

function init() {
    joinBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();

        if (!username) {
            joinError.textContent = 'Please enter a name';
            return;
        }
        if (!password) {
            joinError.textContent = 'Password required';
            return;
        }

        myUsername = username;
        roomPassword = password;
        joinError.textContent = '';
        pendingJoin = true;

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
        } else {
            ws.send(JSON.stringify({ type: 'join', username: myUsername, password: roomPassword }));
        }
    });

    muteBtn.addEventListener('click', toggleMute);
    screenBtn.addEventListener('click', () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            startScreenShare();
        }
    });
    leaveBtn.addEventListener('click', leaveRoom);

    document.addEventListener('keydown', (event) => {
        if (event.key === '/' && document.activeElement.tagName !== 'INPUT') {
            event.preventDefault();
            toggleMute();
        }
    });

    window.addEventListener('beforeunload', () => {
        if (ws) {
            ws.close();
        }
    });
}

window.addEventListener('load', init);
