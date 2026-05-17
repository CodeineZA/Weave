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
  if (logs.length > 500) logs.shift();
}

window.showClientLogs = () => {
  console.log('=== CLIENT LOGS ===');
  logs.forEach(log => console.log(log));
  console.log('=== END LOGS ===');
};

window.getDiagnostics = async () => {
  console.log('=== WEAVE DIAGNOSTICS ===');
  console.log('WebSocket:', { readyState: ws?.readyState, connected: ws?.readyState === 1 });
  console.log('Local Stream:', { id: localStream?.id, tracks: localStream?.getTracks().length });
  console.log('Connected Users:', connectedUsers);
  console.log('Peer Connections:', peerConnections.size);
  
  for (const [username, pc] of peerConnections.entries()) {
    console.log(`Peer: ${username}`);
    console.log('  Signaling State:', pc.signalingState);
    console.log('  Connection State:', pc.connectionState);
    console.log('  ICE Connection State:', pc.iceConnectionState);
    console.log('  Senders:', pc.getSenders().length);
    console.log('  Receivers:', pc.getReceivers().length);
  }
  
  console.log('Audio Elements:', hiddenAudio.children.length);
  for (let i = 0; i < hiddenAudio.children.length; i++) {
    const audio = hiddenAudio.children[i];
    console.log(`  Audio ${i}: paused=${audio.paused}, muted=${audio.muted}, volume=${audio.volume}`);
  }
  console.log('=== END DIAGNOSTICS ===');
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
        clientLog('MIC_CONNECTED', `Got ${audioTracks.length} audio track(s), streamID=${localStream.id}`);
        
        audioTracks.forEach((track, idx) => {
          clientLog('AUDIO_TRACK', `Track ${idx}: id=${track.id}, label="${track.label}", enabled=${track.enabled}, state=${track.readyState}, kind=${track.kind}`);
        });
        
        if (audioTracks.length === 0) {
          clientLog('MIC_WARNING', 'No audio tracks in stream');
        }
        
        return true;
    } catch (err) {
        clientLog('MIC_FAILED', `${err.name}: ${err.message}`);
        joinError.textContent = 'Microphone access is required for voice chat.';
        return false;
    }
}

function createPeerConnection(peerUsername) {
    if (peerConnections.has(peerUsername)) {
        return peerConnections.get(peerUsername);
    }

    clientLog('PEER_CREATE_START', `${peerUsername}, iceServers=${JSON.stringify(iceServers)}`);
    const pc = new RTCPeerConnection({ iceServers });
    peerConnections.set(peerUsername, pc);
    clientLog('PEER_CREATED', `${peerUsername}, signalingState=${pc.signalingState}`);

    if (localStream) {
        clientLog('LOCAL_STREAM_INFO', `streamID=${localStream.id}, tracks=${localStream.getTracks().length}`);
        localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
            clientLog('TRACK_ADDED', `${track.kind} (id=${track.id}, enabled=${track.enabled}) to ${peerUsername}`);
        });
    } else {
        clientLog('LOCAL_STREAM_MISSING', `${peerUsername} peer has no local stream yet`);
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            clientLog('ICE_CANDIDATE_LOCAL', `${peerUsername}: ${event.candidate.candidate.split(' ')[7] || 'unknown'}`);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ice_candidate',
                    to: peerUsername,
                    candidate: event.candidate
                }));
                clientLog('ICE_CANDIDATE_SENT', `${peerUsername}`);
            } else {
                clientLog('ICE_CANDIDATE_QUEUE_FAIL', `${peerUsername}: ws not open (state=${ws?.readyState})`);
            }
        } else {
            clientLog('ICE_GATHERING_COMPLETE', peerUsername);
        }
    };

    pc.ontrack = (event) => {
        const track = event.track;
        const stream = event.streams[0] || new MediaStream([track]);

        clientLog('TRACK_RECEIVED', `${track.kind} from ${peerUsername}, track.id=${track.id}, stream.id=${stream.id}`);

        if (track.kind === 'audio') {
            clientLog('AUDIO_TRACK_RECEIVED', `${peerUsername}: enabled=${track.enabled}, readyState=${track.readyState}`);
            
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.muted = false;
            audio.volume = 1.0;
            audio.srcObject = stream;
            
            clientLog('AUDIO_ELEMENT_CONFIG', `${peerUsername}: autoplay=${audio.autoplay}, muted=${audio.muted}, volume=${audio.volume}`);
            
            audio.onloadedmetadata = () => {
              clientLog('AUDIO_LOADED_METADATA', `${peerUsername}: duration=${audio.duration}, readyState=${audio.readyState}`);
            };
            
            audio.onplay = () => {
              clientLog('AUDIO_PLAY_EVENT', `${peerUsername}: currentTime=${audio.currentTime}`);
            };
            
            audio.onerror = (e) => {
              clientLog('AUDIO_ERROR', `${peerUsername}: code=${audio.error?.code}, message=${audio.error?.message}`);
            };
            
            audio.play().then(() => {
              clientLog('AUDIO_PLAY_SUCCESS', `${peerUsername}`);
            }).catch(err => {
              clientLog('AUDIO_PLAY_FAILED', `${peerUsername}: ${err.name}: ${err.message}`);
            });
            
            hiddenAudio.appendChild(audio);
            clientLog('AUDIO_ELEMENT_APPENDED', `${peerUsername}: hiddenAudio.children=${hiddenAudio.children.length}`);
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
        clientLog('PEER_STATE_CHANGE', `${peerUsername}: ${pc.connectionState}, signalingState=${pc.signalingState}`);
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
      if (pc.iceConnectionState === 'connected') {
        clientLog('ICE_CONNECTED', `${peerUsername}: ICE connectivity established`);
      }
    };

    pc.onsignalingstatechange = () => {
      clientLog('SIGNALING_STATE_CHANGE', `${peerUsername}: ${pc.signalingState}`);
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
        clientLog('WS_CONNECTED', 'WebSocket open, readyState=1');
        if (myUsername && roomPassword) {
            clientLog('SEND_JOIN_MESSAGE', `username=${myUsername}`);
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
        clientLog('MSG_RECEIVED', `${msg.type}${msg.from ? ` from ${msg.from}` : ''}`);

        if (msg.type === 'join_ack') {
            joined = true;
            iceServers = msg.iceServers || iceServers;
            connectedUsers = msg.users.map((u) => u.username);
            clientLog('JOIN_ACK_RECEIVED', `Users: [${connectedUsers.join(', ')}], iceServers=${JSON.stringify(iceServers)}`);

            const mediaReady = await initLocalMedia();
            if (!mediaReady) {
                clientLog('JOIN_FAILED', 'Media init failed');
                return;
            }

            myUsernameDisplay.textContent = myUsername;
            updateUsersList();

            for (const user of connectedUsers) {
                if (user === myUsername) {
                    continue;
                }
                clientLog('CREATING_INITIAL_PEER', user);
                const pc = createPeerConnection(user);
                clientLog('OFFER_CREATING', user);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                clientLog('LOCAL_DESCRIPTION_SET', `${user}: signalingState=${pc.signalingState}`);
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
            clientLog('OFFER_RECEIVED_START', `from ${msg.from}`);
            const pc = createPeerConnection(msg.from);
            clientLog('OFFER_RECEIVED_PROCESS', `${msg.from}: signalingState=${pc.signalingState}`);
            await pc.setRemoteDescription(msg.offer);
            clientLog('REMOTE_DESCRIPTION_SET', `${msg.from}: signalingState=${pc.signalingState}`);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            clientLog('ANSWER_CREATED', `${msg.from}: signalingState=${pc.signalingState}`);
            ws.send(JSON.stringify({ type: 'answer', to: msg.from, answer: pc.localDescription }));
            clientLog('ANSWER_SENT', msg.from);
            return;
        }

        if (msg.type === 'answer') {
            const pc = peerConnections.get(msg.from);
            if (pc) {
                clientLog('ANSWER_RECEIVED', `${msg.from}: signalingState=${pc.signalingState}`);
                await pc.setRemoteDescription(msg.answer);
                clientLog('ANSWER_REMOTE_DESCRIPTION_SET', `${msg.from}: signalingState=${pc.signalingState}`);
            } else {
                clientLog('ANSWER_RECEIVED_NO_PEER', msg.from);
            }
            return;
        }

        if (msg.type === 'ice_candidate') {
            const pc = peerConnections.get(msg.from);
            if (pc) {
                clientLog('ICE_CANDIDATE_RECEIVED', `${msg.from}: ${msg.candidate.candidate.split(' ')[7] || 'unknown'}`);
                await pc.addIceCandidate(msg.candidate).catch((err) => {
                  clientLog('ICE_CANDIDATE_ADD_FAILED', `${msg.from}: ${err.message}`);
                });
            } else {
                clientLog('ICE_CANDIDATE_NO_PEER', msg.from);
            }
            return;
        }
    };

    ws.onclose = (event) => {
        clientLog('WS_CLOSED', `Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}`);
        if (joined && reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts += 1;
            const delay = reconnectAttempts * 2000;
            clientLog('WS_RECONNECT', `Attempt ${reconnectAttempts}/${MAX_RECONNECT}, waiting ${delay}ms`);
            setTimeout(connectWebSocket, delay);
        } else if (joined) {
            clientLog('WS_RECONNECT_FAILED', 'Max attempts reached');
            alert('Connection lost. Refresh to try again.');
        }
    };

    ws.onerror = (err) => {
      clientLog('WS_ERROR', `${err.message || 'Unknown error'} (readyState=${ws.readyState})`);
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

    for (const [username, pc] of peerConnections.entries()) {
        const senders = pc.getSenders();
        for (const sender of senders) {
            if (sender.track && sender.track.kind === 'video') {
                pc.removeTrack(sender);
            }
        }
        renegotiateConnection(username, pc);
    }

    removeScreenFromGrid(myUsername);
    isScreenSharing = false;
    screenBtn.classList.remove('active');
    screenIcon.textContent = '📺';
    screenText.textContent = 'Share screen';
    clientLog('SCREEN_SHARE_STOPPED', fromBrowser ? 'by browser' : 'by user');
}

function toggleMute() {
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        audioTracks.forEach((track) => {
            track.enabled = !track.enabled;
            isMuted = !track.enabled;
        });

        muteBtn.classList.toggle('active');
        muteIcon.textContent = isMuted ? '🔇' : '🎤';
        muteText.textContent = isMuted ? 'Unmute' : 'Mute';
        clientLog('MUTE_TOGGLED', isMuted ? 'MUTED' : 'UNMUTED');
    }
}

// ===== EVENT LISTENERS =====
joinBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username) {
        joinError.textContent = 'Please enter a username';
        return;
    }

    if (!password) {
        joinError.textContent = 'Please enter the room password';
        return;
    }

    myUsername = username;
    roomPassword = password;
    clientLog('JOIN_ATTEMPT', username);
    connectWebSocket();
});

leaveBtn.addEventListener('click', () => {
    if (ws) {
        clientLog('LEAVE_REQUESTED', myUsername);
        ws.close();
    }
    location.reload();
});

muteBtn.addEventListener('click', toggleMute);
screenBtn.addEventListener('click', () => {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
});

// Prevent form submission on enter
document.getElementById('password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        joinBtn.click();
    }
});

clientLog('INIT_COMPLETE', 'App ready');
