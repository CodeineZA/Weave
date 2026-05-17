// public/app.js
// =============================================
// Lightweight Voice + Screen Sharing Web App
// WITH VERBOSE DEBUG LOGGING
// =============================================

const DEBUG = true; // Set to false in production

function clientLog(action, details = '') {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    if (typeof details === 'object') {
        console.log(`%c[CLIENT ${ts}] ${action.padEnd(35)}`, 'color:#00ffcc; font-weight:600', details);
    } else {
        console.log(`%c[CLIENT ${ts}] ${action.padEnd(35)} ${details}`, 'color:#00ffcc; font-weight:600');
    }
}

function clientError(action, error) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`%c[CLIENT ${ts}] ❌ ${action}`, 'color:#ff4444; font-weight:bold', error);
}

// State of things
let ws = null;
let myUsername = null;
let roomPassword = null;
let localStream = null;
let screenStream = null;
let isMuted = false;
let isScreenSharing = false;

let peerConnections = new Map();     // username → RTCPeerConnection
let screenVideos = new Map();        // username → DOM container
let voiceAnalysers = new Map();      // username → {context, analyser, interval}

let connectedUsers = [];
let iceServers = [];
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
let joined = false;

// DOM elements
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

// Utility functions
function getAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = ['#00d4ff', '#ff00aa', '#00ff88', '#ffaa00', '#aa88ff'];
    return colors[Math.abs(hash) % colors.length];
}

function createAvatar(username) {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.backgroundColor = getAvatarColor(username);
    div.textContent = username[0].toUpperCase();
    return div;
}

function updateUsersList() {
    clientLog('UI_UPDATE', `Users: ${connectedUsers.length} total`);
    usersList.innerHTML = '';
    connectedUsers.forEach(user => {
        if (user === myUsername) return;
        const item = document.createElement('div');
        item.className = 'user-item';
        item.innerHTML = `
            ${createAvatar(user).outerHTML}
            <span class="username">${user}</span>
            <span id="speaking-${user}" class="speaking" style="display: none;">
                <span class="speaking-dot"></span> speaking
            </span>
        `;
        usersList.appendChild(item);
    });
    userCount.textContent = connectedUsers.length;
}

// ==================== WEBRTC HELPERS ====================

function createPeerConnection(targetUsername) {
    clientLog('PEER_CREATE', `Target: ${targetUsername}`);
    
    const pc = new RTCPeerConnection({ iceServers });
    peerConnections.set(targetUsername, pc);

    pc.onicecandidate = (e) => {
        if (e.candidate && ws?.readyState === WebSocket.OPEN) {
            clientLog('ICE_CANDIDATE', `→ ${targetUsername} | ${e.candidate.type}`);
            ws.send(JSON.stringify({
                type: 'ice_candidate',
                to: targetUsername,
                candidate: e.candidate
            }));
        }
    };

    pc.ontrack = (event) => {
        const track = event.track;
        clientLog('REMOTE_TRACK', `${track.kind} from ${targetUsername}`);

        if (track.kind === 'audio') {
            const audioEl = document.createElement('audio');
            audioEl.autoplay = true;
            audioEl.srcObject = new MediaStream([track]);
            hiddenAudio.appendChild(audioEl);
            startVoiceActivityDetection(targetUsername, audioEl.srcObject);
        } 
        else if (track.kind === 'video') {
            clientLog('SCREEN_SHARE', `Received from ${targetUsername}`);
            addScreenToGrid(targetUsername, new MediaStream([track]));
        }
    };

    pc.onconnectionstatechange = () => {
        clientLog('PEER_STATE', `${targetUsername} → ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            clientError('PEER_FAILED', targetUsername);
            removeUser(targetUsername);
        }
    };

    pc.oniceconnectionstatechange = () => {
        clientLog('ICE_STATE', `${targetUsername} → ${pc.iceConnectionState}`);
    };

    // Add local audio if available
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
            clientLog('LOCAL_TRACK_ADDED', `${track.kind} to ${targetUsername}`);
        });
    }

    return pc;
}

async function renegotiate(pc, targetUsername) {
    try {
        clientLog('RENEGOTIATE', `Starting for ${targetUsername}`);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
            type: 'offer',
            to: targetUsername,
            offer: pc.localDescription
        }));
        clientLog('RENEGOTIATE', `Offer sent to ${targetUsername}`);
    } catch (err) {
        clientError('RENEGOTIATE_FAILED', err);
    }
}

// Screen grid
function addScreenToGrid(username, stream) {
    if (screenVideos.has(username)) return;
    
    clientLog('SCREEN_ADD', username);
    
    const container = document.createElement('div');
    container.className = 'screen-container';
    
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    
    const label = document.createElement('div');
    label.className = 'screen-label';
    label.textContent = username === myUsername ? `You (screen)` : username;
    
    container.append(video, label);
    screenGrid.appendChild(container);
    screenVideos.set(username, container);
    
    checkEmptyState();
}

function removeScreenFromGrid(username) {
    if (screenVideos.has(username)) {
        clientLog('SCREEN_REMOVE', username);
        screenVideos.get(username).remove();
        screenVideos.delete(username);
        checkEmptyState();
    }
}

function checkEmptyState() {
    const visible = screenVideos.size === 0;
    emptyState.style.display = visible ? 'flex' : 'none';
}

// Voice Activity Detection
function startVoiceActivityDetection(username, stream) {
    if (voiceAnalysers.has(username)) return;
    
    clientLog('VAD_START', username);
    
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    
    const speakingEl = document.getElementById(`speaking-${username}`);
    
    const interval = setInterval(() => {
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        
        if (speakingEl) {
            speakingEl.style.display = (avg > 28) ? 'flex' : 'none';
        }
    }, 180);
    
    voiceAnalysers.set(username, { context: audioContext, analyser, interval });
}

// Local media
async function initLocalMedia() {
    clientLog('MIC_REQUEST', 'Asking for microphone...');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        clientLog('MIC_SUCCESS', 'Microphone acquired');
        return true;
    } catch (err) {
        clientError('MIC_FAILED', err);
        alert('Microphone access is required.');
        return false;
    }
}

// ==================== SIGNALING ====================

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.on('ping', () => ws.pong ? ws.pong() : null);  // Some browsers need this
    
    ws.onopen = () => {
        clientLog('WS_CONNECTED', 'WebSocket open');
        reconnectAttempts = 0;
        
        if (joined && myUsername && roomPassword) {
            clientLog('WS_REJOIN', 'Auto re-joining after reconnect');
            ws.send(JSON.stringify({
                type: 'join',
                username: myUsername,
                password: roomPassword
            }));
        }
    };
    
    ws.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            clientError('INVALID_MESSAGE', e);
            return;
        }
        
        clientLog(`WS_${msg.type.toUpperCase()}`, msg.from ? `from ${msg.from}` : '');
        
        switch (msg.type) {
            case 'join_ack':
                joined = true;
                iceServers = msg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
                connectedUsers = msg.users.map(u => u.username);
                
                clientLog('JOIN_SUCCESS', `Room users: ${connectedUsers.join(', ')}`);
                
                if (!localStream) {
                    const ok = await initLocalMedia();
                    if (!ok) return;
                }
                
                myUsernameDisplay.textContent = myUsername;
                
                // Create peer connections + offers
                for (const user of connectedUsers) {
                    if (user === myUsername) continue;
                    const pc = createPeerConnection(user);
                    
                    try {
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        ws.send(JSON.stringify({
                            type: 'offer',
                            to: user,
                            offer: pc.localDescription
                        }));
                        clientLog('OFFER_SENT', `to ${user}`);
                    } catch (e) {
                        clientError('OFFER_FAILED', e);
                    }
                }
                
                updateUsersList();
                joinScreen.classList.add('hidden');
                roomScreen.classList.remove('hidden');
                checkEmptyState();
                break;
                
            case 'user_joined':
                if (msg.username !== myUsername) {
                    clientLog('USER_JOINED', msg.username);
                    addUser(msg.username);
                    createPeerConnection(msg.username); // others wait for offer
                }
                break;
                
            case 'user_left':
                clientLog('USER_LEFT', msg.username);
                removeUser(msg.username);
                break;
                
            case 'offer':
                let pc = peerConnections.get(msg.from);
                if (!pc) pc = createPeerConnection(msg.from);
                
                await pc.setRemoteDescription(msg.offer);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                
                ws.send(JSON.stringify({
                    type: 'answer',
                    to: msg.from,
                    answer: pc.localDescription
                }));
                clientLog('ANSWER_SENT', `to ${msg.from}`);
                break;
                
            case 'answer':
                const pcAnswer = peerConnections.get(msg.from);
                if (pcAnswer) {
                    await pcAnswer.setRemoteDescription(msg.answer);
                    clientLog('ANSWER_RECEIVED', `from ${msg.from}`);
                }
                break;
                
            case 'ice_candidate':
                const pcIce = peerConnections.get(msg.from);
                if (pcIce) {
                    await pcIce.addIceCandidate(msg.candidate);
                    clientLog('ICE_ADDED', `from ${msg.from}`);
                }
                break;
                
            case 'join_rejected':
                clientError('JOIN_REJECTED', msg.reason);
                joinError.textContent = msg.reason || 'Join failed';
                break;
        }
    };
    
    ws.onclose = () => {
        clientLog('WS_CLOSED', `Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT}`);
        if (joined && reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts++;
            setTimeout(connectWebSocket, reconnectAttempts * 2000);
        }
    };
    
    ws.onerror = (err) => clientError('WS_ERROR', err);
}

// ==================== MEDIA CONTROLS ====================

async function startScreenShare() {
    clientLog('SCREEN_START_REQUEST');
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' }
        });
        
        const screenTrack = screenStream.getVideoTracks()[0];
        clientLog('SCREEN_ACQUIRED', `Track: ${screenTrack.label}`);
        
        for (const [username, pc] of peerConnections) {
            pc.addTrack(screenTrack, screenStream);
            clientLog('SCREEN_TRACK_ADDED', `to ${username}`);
            await renegotiate(pc, username);
        }
        
        addScreenToGrid(myUsername, screenStream);
        
        isScreenSharing = true;
        screenIcon.textContent = '⏹️';
        screenText.textContent = 'Stop sharing';
        
        screenTrack.onended = () => {
            clientLog('SCREEN_ENDED_BY_BROWSER');
            stopScreenShare(true);
        };
        
    } catch (err) {
        clientError('SCREEN_SHARE_CANCELLED', err);
    }
}

function stopScreenShare(fromBrowser = false) {
    clientLog('SCREEN_STOP', fromBrowser ? '(browser stop button)' : '');
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    removeScreenFromGrid(myUsername);
    isScreenSharing = false;
    screenIcon.textContent = '📺';
    screenText.textContent = 'Share screen';
}

// Toggle mute
function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    
    clientLog('MUTE_TOGGLE', isMuted ? 'MUTED' : 'UNMUTED');
    
    if (isMuted) {
        muteIcon.textContent = '🔇';
        muteText.textContent = 'Unmute';
        muteBtn.classList.add('active');
    } else {
        muteIcon.textContent = '🎤';
        muteText.textContent = 'Mute';
        muteBtn.classList.remove('active');
    }
}

function removeUser(username) {
    clientLog('USER_REMOVE', username);
    connectedUsers = connectedUsers.filter(u => u !== username);
    updateUsersList();
    
    if (peerConnections.has(username)) {
        peerConnections.get(username).close();
        peerConnections.delete(username);
    }
    removeScreenFromGrid(username);
    
    if (voiceAnalysers.has(username)) {
        clearInterval(voiceAnalysers.get(username).interval);
        voiceAnalysers.delete(username);
    }
}

// Leave room
function leaveRoom() {
    clientLog('LEAVE_ROOM', 'User initiated');
    if (ws) ws.close();
    joined = false;
    
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
    screenVideos.forEach(c => c.remove());
    screenVideos.clear();
    voiceAnalysers.forEach(v => clearInterval(v.interval));
    voiceAnalysers.clear();
    
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (screenStream) screenStream.getTracks().forEach(t => t.stop());
    
    roomScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
}

// ==================== INIT ====================

function init() {
    joinBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();
        
        if (!username || !password) {
            joinError.textContent = 'Name and password required';
            return;
        }
        
        myUsername = username;
        roomPassword = password;
        joinError.textContent = '';
        
        clientLog('JOIN_ATTEMPT', username);
        
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
        } else {
            ws.send(JSON.stringify({ type: 'join', username, password }));
        }
    });
    
    muteBtn.addEventListener('click', toggleMute);
    screenBtn.addEventListener('click', () => {
        isScreenSharing ? stopScreenShare() : startScreenShare();
    });
    
    leaveBtn.addEventListener('click', leaveRoom);
    
    document.addEventListener('keydown', e => {
        if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
            e.preventDefault();
            toggleMute();
        }
    });
    
    window.addEventListener('beforeunload', () => {
        if (ws) ws.close();
    });
    
    clientLog('APP_READY', 'Voice + Screen app initialized with full logging');
}

window.onload = init;