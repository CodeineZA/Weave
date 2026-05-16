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

// ===== CLIENT LOGGING =====
const logs = [];
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

function clientLog(action, details = '') {
  const entry = `[${getTimestamp()}] ${myUsername || 'joining'} - ${action} ${details}`;
  console.log(`%c${entry}`, 'color: #00d4ff; font-weight: bold;');
  logs.push(entry);
  if (logs.length > 500) logs.shift(); // Keep last 500 logs
}

window.showClientLogs = () => {
  console.log('=== CLIENT LOGS ===');
  logs.forEach(log => console.log(log));
  console.log('=== END LOGS ===');
};
// ===== END LOGGING =====

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
        clientLog('USER_JOINED', username);
        updateUsersList();
    }
}

function removeUser(username) {
    connectedUsers = connectedUsers.filter((user) => user !== username);
    clientLog('USER_LEFT', username);
    updateUsersList();

    if (peerConnections.has(username)) {
        peerConnections.get(username).close();
        peerConnections.delete(username);
        clientLog('PEER_CLOSED', username);
    }

    if (screenVideos.has(username)) {
        screenVideos.get(username).remove();
        screenVideos.delete(username);
        clientLog('SCREEN_REMOVED', username);
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
    clientLog('SCREEN_ADDED', username);
    checkEmptyState();
}

function removeScreenFromGrid(username) {
    if (!screenVideos.has(username)) {
        return;
    }
    screenVideos.get(username).remove();
    screenVideos.delete(username);
    clientLog('SCREEN_STOPPED', username);
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
    clientLog('VAD_STARTED', username);
}

async function initLocalMedia() {
    try {
        clientLog('MIC_REQUEST', 'Requesting microphone access');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        const audioTracks = localStream.getAudioTracks();
        clientLog('MIC_CONNECTED', `Got ${audioTracks.length} audio track(s)`);
        
        audioTracks.forEach((track, idx) => {
          clientLog('AUDIO_TRACK', `Track ${idx}: ${track.label}, enabled=${track.enabled}`);
        });
        
        return true;
    } catch (err) {
        clientLog('MIC_FAILED', err.message);
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
    clientLog('PEER_CREATED', peerUsername);

    if (localStream) {
        localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
            clientLog('TRACK_ADDED', `${track.kind} to ${peerUsername}`);
        });
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

        clientLog('TRACK_RECEIVED', `${track.kind} from ${peerUsername}`);

        if (track.kind === 'audio') {
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.muted = false; // CRITICAL: Ensure audio is not muted
            audio.volume = 1.0;  // Ensure full volume
            audio.srcObject = stream;
            
            audio.onloadedmetadata = () => {
              clientLog('AUDIO_READY', `${peerUsername} audio elem ready, playing`);
            };
            
            audio.onerror = (e) => {
              clientLog('AUDIO_ERROR', `${peerUsername}: ${e.message}`);
            };
            
            audio.play().catch(err => {
              clientLog('AUDIO_PLAY_FAILED', `${peerUsername}: ${err.message}`);
            });
            
            hiddenAudio.appendChild(audio);
            clientLog('AUDIO_ELEMENT_CREATED', `${peerUsername} elem added, playing`);
            startVoiceActivityDetection(peerUsername, stream);
        }

        if (track.kind === 'video') {
            addScreenToGrid(peerUsername, stream);
            track.onended = () => {
              clientLog('VIDEO_TRACK_ENDED', peerUsername);
              removeScreenFromGrid(peerUsername);
            };
        }
    };

    pc.onconnectionstatechange = () => {
        clientLog('PEER_STATE_CHANGE', `${peerUsername}: ${pc.connectionState}`);
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            clientLog('PEER_DISCONNECTED', peerUsername);
            removeUser(peerUsername);
        }
    };

    pc.onicegatheringstatechange = () => {
      clientLog('ICE_GATHERING', `${peerUsername}: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      clientLog('ICE_CONNECTION', `${peerUsername}: ${pc.iceConnectionState}`);
    };

    return pc;
}

async function renegotiateConnection(peerUsername, pc) {
    try {
        clientLog('RENEGOTIATE_START', peerUsername);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'offer',
                to: peerUsername,
                offer: pc.localDescription
            }));
            clientLog('RENEGOTIATE_OFFER_SENT', peerUsername);
        }
    } catch (err) {
        clientLog('RENEGOTIATE_ERROR', `${peerUsername}: ${err.message}`);
    }
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    clientLog('WS_CONNECTING', `${protocol}//${window.location.host}`);
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        reconnectAttempts = 0;
        clientLog('WS_CONNECTED', 'Ready to join');
        if (myUsername && roomPassword) {
            ws.send(JSON.stringify({
                type: 'join',
                username: myUsername,
                password: roomPassword
            }));
            clientLog('JOIN_SENT', myUsername);
            pendingJoin = false;
        }
    };

    ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        clientLog('MSG_RECEIVED', msg.type);

        if (msg.type === 'join_ack') {
            joined = true;
            iceServers = msg.iceServers || iceServers;
            connectedUsers = msg.users.map((u) => u.username);
            clientLog('JOIN_ACK', `Users in room: ${connectedUsers.join(', ')}`);

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
                clientLog('OFFER_CREATING', user);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: 'offer', to: user, offer: pc.localDescription }));
                clientLog('OFFER_SENT', user);
            }

            joinScreen.classList.add('hidden');
            roomScreen.classList.remove('hidden');
            checkEmptyState();
            return;
        }

        if (msg.type === 'join_rejected') {
            clientLog('JOIN_REJECTED', msg.reason);
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
            clientLog('OFFER_RECEIVED', msg.from);
            await pc.setRemoteDescription(msg.offer);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', to: msg.from, answer: pc.localDescription }));
            clientLog('ANSWER_SENT', msg.from);
            return;
        }

        if (msg.type === 'answer') {
            const pc = peerConnections.get(msg.from);
            if (pc) {
                clientLog('ANSWER_RECEIVED', msg.from);
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

    ws.onclose = (event) => {
        clientLog('WS_CLOSED', `Code: ${event.code}, Clean: ${event.wasClean}`);
        if (joined && reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts += 1;
            const delay = reconnectAttempts * 2000;
            clientLog('WS_RECONNECT', `Attempt ${reconnectAttempts}, waiting ${delay}ms`);
            setTimeout(connectWebSocket, delay);
        } else if (joined) {
            clientLog('WS_RECONNECT_FAILED', 'Max attempts reached');
            alert('Connection lost. Refresh to try again.');
        }
    };

    ws.onerror = (err) => {
      clientLog('WS_ERROR', err.message || 'Unknown');
      console.error('WebSocket error', err);
    };
}

async function startScreenShare() {
    if (isScreenSharing) {
        return;
    }

    try {
        clientLog('SCREEN_SHARE_REQUEST', 'Starting');
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false
        });

        clientLog('SCREEN_SHARE_GRANTED', 'Got display stream');
        const screenTrack = screenStream.getVideoTracks()[0];
        for (const [username, pc] of peerConnections.entries()) {
            pc.addTrack(screenTrack, screenStream);
            clientLog('SCREEN_TRACK_ADDED', username);
            await renegotiateConnection(username, pc);
        }

        addScreenToGrid(myUsername, screenStream);
        isScreenSharing = true;
        screenBtn.classList.add('active');
        screenIcon.textContent = '⏹️';
        screenText.textContent = 'Stop sharing';

        screenTrack.onended = () => {
            clientLog('SCREEN_STOPPED_BY_BROWSER', 'User clicked browser stop');
            stopScreenShare(true);
        };
    } catch (err) {
        clientLog('SCREEN_SHARE_FAILED', err.message);
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
    clientLog('SCREEN_SHARE_STOPPED', fromBrowser ? 'browser_button' : 'user_button');
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
    clientLog('MUTE_TOGGLE', isMuted ? 'muted' : 'unmuted');
}

function leaveRoom() {
    clientLog('LEAVE_ROOM', 'User initiated');
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
        clientLog('LOCAL_MEDIA_STOPPED', 'All tracks stopped');
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
    clientLog('APP_INIT', 'Page loaded');
    
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
        clientLog('JOIN_BUTTON_CLICKED', username);

        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
        } else {
            ws.send(JSON.stringify({ type: 'join', username: myUsername, password: roomPassword }));
            clientLog('JOIN_SENT', myUsername);
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
            clientLog('MUTE_HOTKEY', '/');
        }
    });

    window.addEventListener('beforeunload', () => {
        if (ws) {
            ws.close();
        }
    });
}

window.addEventListener('load', init);
