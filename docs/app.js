// ============================================================================
// Voice Chat Room - WebRTC Client
// ============================================================================

// Configuration
const CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
  audioConstraints: {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  },
};

// State management
const state = {
  userId: null,
  username: null,
  ws: null,
  localStream: null,
  screenStream: null,
  peers: new Map(), // userId -> { pc, audioStream, screenStream }
  users: new Map(), // userId -> { username, isSpeaking, isScreenSharing }
  isMuted: false,
  isScreenSharing: false,
  wsReconnectAttempts: 0,
  wsReconnectDelay: 3000,
};

// DOM elements
const joinScreen = document.getElementById('joinScreen');
const roomScreen = document.getElementById('roomScreen');
const joinForm = document.getElementById('joinForm');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const joinError = document.getElementById('joinError');

const muteBtn = document.getElementById('muteBtn');
const screenShareBtn = document.getElementById('screenShareBtn');
const leaveBtn = document.getElementById('leaveBtn');

const usersList = document.getElementById('usersList');
const userCount = document.getElementById('userCount');
const screensContainer = document.getElementById('screensContainer');
const noScreenMessage = document.getElementById('noScreenMessage');
const audioContainer = document.getElementById('audioContainer');

// ============================================================================
// WebSocket Signaling
// ============================================================================

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('Connected to signaling server');
    state.wsReconnectAttempts = 0;
    state.wsReconnectDelay = 3000;
  };

  state.ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      await handleSignalingMessage(message);
    } catch (error) {
      console.error('Error handling signaling message:', error);
    }
  };

  state.ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  state.ws.onclose = () => {
    console.log('Disconnected from signaling server');
    if (state.username) {
      attemptReconnect();
    }
  };
}

function attemptReconnect() {
  if (state.wsReconnectAttempts >= 5) {
    console.error('Failed to reconnect after 5 attempts');
    showJoinError('Connection lost. Please refresh and try again.');
    leaveRoom();
    return;
  }

  state.wsReconnectAttempts++;
  console.log(`Attempting to reconnect (${state.wsReconnectAttempts}/5)...`);

  setTimeout(() => {
    initWebSocket();
    if (state.userId && state.username) {
      // Re-join after reconnecting
      sendSignalingMessage({
        type: 'join',
        userId: state.userId,
        username: state.username,
        password: passwordInput.value,
      });
    }
  }, state.wsReconnectDelay);

  state.wsReconnectDelay = Math.min(state.wsReconnectDelay * 1.5, 10000);
}

function sendSignalingMessage(message) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(message));
  } else {
    console.warn('WebSocket not ready, message queued:', message);
  }
}

async function handleSignalingMessage(message) {
  switch (message.type) {
    case 'join_ack':
      await handleJoinAck(message);
      break;
    case 'join_rejected':
      handleJoinRejected(message);
      break;
    case 'user_joined':
      await handleUserJoined(message);
      break;
    case 'user_left':
      handleUserLeft(message);
      break;
    case 'offer':
      await handleOffer(message);
      break;
    case 'answer':
      await handleAnswer(message);
      break;
    case 'ice_candidate':
      await handleIceCandidate(message);
      break;
    case 'screen_share_started':
      handleScreenShareStarted(message);
      break;
    case 'screen_share_stopped':
      handleScreenShareStopped(message);
      break;
    default:
      console.warn('Unknown message type:', message.type);
  }
}

// ============================================================================
// Join/Leave Room
// ============================================================================

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username) {
    showJoinError('Please enter a username');
    return;
  }

  if (!password) {
    showJoinError('Please enter the room password');
    return;
  }

  state.username = username;
  state.userId = generateUserId();

  // Initialize WebSocket and audio
  initWebSocket();

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia(
      CONFIG.audioConstraints
    );
    setupVoiceActivityDetection();

    // Send join message
    sendSignalingMessage({
      type: 'join',
      userId: state.userId,
      username,
      password,
    });
  } catch (error) {
    console.error('Error getting user media:', error);
    showJoinError('Unable to access microphone. Please check permissions.');
  }
});

async function handleJoinAck(message) {
  state.userId = message.userId;

  // Update UI
  showRoomScreen();

  // Handle existing users
  for (const user of message.users) {
    if (user.id !== state.userId) {
      state.users.set(user.id, {
        username: user.username,
        isSpeaking: false,
        isScreenSharing: false,
      });
      await createPeerConnection(user.id);
    }
  }

  updateUsersList();

  // Store TURN config for later use
  if (message.turnConfig && message.turnConfig.url) {
    CONFIG.iceServers.push({
      urls: message.turnConfig.url,
      username: message.turnConfig.username,
      credential: message.turnConfig.credential,
    });
  }
}

function handleJoinRejected(message) {
  showJoinError(`Join rejected: ${message.reason}`);
  state.username = null;
  state.userId = null;
}

async function handleUserJoined(message) {
  if (message.userId === state.userId) return;

  state.users.set(message.userId, {
    username: message.username,
    isSpeaking: false,
    isScreenSharing: false,
  });

  await createPeerConnection(message.userId);
  updateUsersList();
}

function handleUserLeft(message) {
  if (message.userId === state.userId) return;

  closePeerConnection(message.userId);
  state.users.delete(message.userId);
  updateUsersList();
}

function leaveRoom() {
  // Close all peer connections
  for (const [userId] of state.peers) {
    closePeerConnection(userId);
  }

  // Close local stream
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }

  // Close screen stream
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((track) => track.stop());
    state.screenStream = null;
  }

  // Close WebSocket
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  // Reset state
  state.userId = null;
  state.username = null;
  state.users.clear();
  state.peers.clear();
  state.isMuted = false;
  state.isScreenSharing = false;

  // Clear UI
  usersList.innerHTML = '';
  screensContainer.innerHTML = '';
  audioContainer.innerHTML = '';

  // Show join screen
  showJoinScreen();
}

// ============================================================================
// WebRTC Peer Connections
// ============================================================================

async function createPeerConnection(peerId) {
  // Prevent duplicate peer connections
  if (state.peers.has(peerId)) {
    console.warn(`Peer connection already exists for ${peerId}`);
    return;
  }

  const peerConfig = {
    iceServers: CONFIG.iceServers,
  };

  const pc = new RTCPeerConnection(peerConfig);
  const peerState = {
    pc,
    audioStream: null,
    screenStream: null,
  };

  state.peers.set(peerId, peerState);

  // Add local audio track
  if (state.localStream) {
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (audioTrack) {
      pc.addTrack(audioTrack, state.localStream);
    }
  }

  // Handle remote tracks
  pc.ontrack = (event) => {
    console.log('Received remote track from', peerId, event.track.kind);
    handleRemoteTrack(peerId, event);
  };

  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage({
        type: 'ice_candidate',
        to: peerId,
        data: event.candidate,
      });
    }
  };

  // Handle connection state changes
  pc.onconnectionstatechange = () => {
    console.log(`Connection state with ${peerId}:`, pc.connectionState);
    if (
      pc.connectionState === 'failed' ||
      pc.connectionState === 'disconnected' ||
      pc.connectionState === 'closed'
    ) {
      closePeerConnection(peerId);
    }
  };

  // Create and send offer
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignalingMessage({
      type: 'offer',
      to: peerId,
      data: offer,
    });
  } catch (error) {
    console.error('Error creating offer for', peerId, error);
    closePeerConnection(peerId);
  }
}

async function handleOffer(message) {
  const peerId = message.from;

  let peerState = state.peers.get(peerId);
  if (!peerState) {
    // Peer connection doesn't exist yet, create it
    await createPeerConnection(peerId);
    peerState = state.peers.get(peerId);
  }

  const pc = peerState.pc;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(message.data));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignalingMessage({
      type: 'answer',
      to: peerId,
      data: answer,
    });
  } catch (error) {
    console.error('Error handling offer from', peerId, error);
    closePeerConnection(peerId);
  }
}

async function handleAnswer(message) {
  const peerId = message.from;
  const peerState = state.peers.get(peerId);

  if (!peerState) {
    console.warn('Received answer from unknown peer:', peerId);
    return;
  }

  try {
    await peerState.pc.setRemoteDescription(
      new RTCSessionDescription(message.data)
    );
  } catch (error) {
    console.error('Error handling answer from', peerId, error);
    closePeerConnection(peerId);
  }
}

async function handleIceCandidate(message) {
  const peerId = message.from;
  const peerState = state.peers.get(peerId);

  if (!peerState) {
    console.warn('Received ICE candidate from unknown peer:', peerId);
    return;
  }

  try {
    await peerState.pc.addIceCandidate(
      new RTCIceCandidate(message.data)
    );
  } catch (error) {
    console.error('Error adding ICE candidate from', peerId, error);
  }
}

function closePeerConnection(peerId) {
  const peerState = state.peers.get(peerId);
  if (!peerState) return;

  peerState.pc.close();

  // Remove audio element
  const audioEl = audioContainer.querySelector(`[data-peer-id="${peerId}"]`);
  if (audioEl) {
    audioEl.remove();
  }

  // Remove screen share
  const screenEl = screensContainer.querySelector(`[data-peer-id="${peerId}"]`);
  if (screenEl) {
    screenEl.remove();
  }

  state.peers.delete(peerId);
  updateScreensDisplay();
}

function handleRemoteTrack(peerId, event) {
  const { track, streams } = event;
  const stream = streams[0];

  if (!stream) {
    console.warn('Received track without stream');
    return;
  }

  const peerState = state.peers.get(peerId);
  if (!peerState) return;

  if (track.kind === 'audio') {
    peerState.audioStream = stream;

    // Create or update audio element
    let audioEl = audioContainer.querySelector(`[data-peer-id="${peerId}"]`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.setAttribute('data-peer-id', peerId);
      audioEl.autoplay = true;
      audioEl.playsinline = true;
      audioContainer.appendChild(audioEl);
    }
    audioEl.srcObject = stream;

    // Monitor voice activity
    setupVoiceActivityMonitoring(peerId, stream);
  } else if (track.kind === 'video') {
    peerState.screenStream = stream;
    updateScreensDisplay();
  }
}

// ============================================================================
// Screen Sharing
// ============================================================================

screenShareBtn.addEventListener('click', async () => {
  if (!state.isScreenSharing) {
    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
        },
        audio: false,
      });

      const videoTrack = state.screenStream.getVideoTracks()[0];

      // Add screen share track to all peer connections
      for (const [peerId, peerState] of state.peers) {
        const sender = peerState.pc
          .getSenders()
          .find((s) => s.track && s.track.kind === 'video');

        if (sender) {
          await sender.replaceTrack(videoTrack);
        } else {
          peerState.pc.addTrack(videoTrack, state.screenStream);
        }
      }

      // Handle user stopping share via browser UI
      videoTrack.onended = () => {
        stopScreenShare();
      };

      state.isScreenSharing = true;
      screenShareBtn.classList.add('active');

      sendSignalingMessage({
        type: 'screen_share_start',
      });

      // Add our own screen share to display
      updateScreensDisplay();
    } catch (error) {
      if (error.name !== 'NotAllowedError') {
        console.error('Error getting display media:', error);
      }
      // User cancelled, do nothing
    }
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  if (!state.screenStream) return;

  state.screenStream.getTracks().forEach((track) => track.stop());
  state.screenStream = null;
  state.isScreenSharing = false;
  screenShareBtn.classList.remove('active');

  // Remove screen track from all peer connections
  for (const [, peerState] of state.peers) {
    const sender = peerState.pc
      .getSenders()
      .find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      sender.replaceTrack(null);
    }
  }

  sendSignalingMessage({
    type: 'screen_share_stop',
  });

  updateScreensDisplay();
}

function handleScreenShareStarted(message) {
  const user = state.users.get(message.userId);
  if (user) {
    user.isScreenSharing = true;
    updateUsersList();
    updateScreensDisplay();
  }
}

function handleScreenShareStopped(message) {
  const user = state.users.get(message.userId);
  if (user) {
    user.isScreenSharing = false;
    updateUsersList();
    updateScreensDisplay();
  }

  // Remove screen element
  const screenEl = screensContainer.querySelector(
    `[data-peer-id="${message.userId}"]`
  );
  if (screenEl) {
    screenEl.remove();
  }

  updateScreensDisplay();
}

function updateScreensDisplay() {
  screensContainer.innerHTML = '';

  // Count active screen shares
  let screenShareCount = state.isScreenSharing ? 1 : 0;
  for (const [, user] of state.users) {
    if (user.isScreenSharing) screenShareCount++;
  }

  // Show/hide no screen message
  if (screenShareCount === 0) {
    noScreenMessage.style.display = 'block';
    screensContainer.classList.remove('multiple');
    screensContainer.classList.remove('single');
  } else {
    noScreenMessage.style.display = 'none';

    if (screenShareCount === 1) {
      screensContainer.classList.add('single');
      screensContainer.classList.remove('multiple');
    } else {
      screensContainer.classList.remove('single');
      screensContainer.classList.add('multiple');
    }

    // Our screen share
    if (state.isScreenSharing && state.screenStream) {
      const container = document.createElement('div');
      container.className = 'screen-share';
      container.setAttribute('data-peer-id', state.userId);

      const label = document.createElement('div');
      label.className = 'screen-share-label';
      label.textContent = `📺 ${state.username} (You)`;

      const video = document.createElement('video');
      video.srcObject = state.screenStream;
      video.autoplay = true;
      video.muted = true;
      video.playsinline = true;

      container.appendChild(label);
      container.appendChild(video);
      screensContainer.appendChild(container);
    }

    // Peer screen shares
    for (const [peerId, peerState] of state.peers) {
      const user = state.users.get(peerId);
      if (user && user.isScreenSharing && peerState.screenStream) {
        const container = document.createElement('div');
        container.className = 'screen-share';
        container.setAttribute('data-peer-id', peerId);

        const label = document.createElement('div');
        label.className = 'screen-share-label';
        label.textContent = `📺 ${user.username}`;

        const video = document.createElement('video');
        video.srcObject = peerState.screenStream;
        video.autoplay = true;
        video.playsinline = true;

        container.appendChild(label);
        container.appendChild(video);
        screensContainer.appendChild(container);
      }
    }
  }
}

// ============================================================================
// Mute/Unmute
// ============================================================================

muteBtn.addEventListener('click', () => {
  if (!state.localStream) return;

  state.isMuted = !state.isMuted;

  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !state.isMuted;
  });

  muteBtn.classList.toggle('active', state.isMuted);
  muteBtn.querySelector('.label').textContent = state.isMuted
    ? 'Unmute'
    : 'Mute';
});

// ============================================================================
// Voice Activity Detection
// ============================================================================

const audioContexts = new Map(); // peerId -> { analyser, array }

function setupVoiceActivityDetection() {
  if (!state.localStream) return;

  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = audioContext.createAnalyser();
  const source = audioContext.createMediaStreamSource(state.localStream);

  source.connect(analyser);
  analyser.fftSize = 256;

  audioContexts.set(state.userId, {
    analyser,
    array: new Uint8Array(analyser.frequencyBinCount),
  });
}

function setupVoiceActivityMonitoring(peerId, stream) {
  try {
    const audioContext = new (window.AudioContext ||
      window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);

    source.connect(analyser);
    analyser.fftSize = 256;

    audioContexts.set(peerId, {
      analyser,
      array: new Uint8Array(analyser.frequencyBinCount),
    });
  } catch (error) {
    console.warn('Error setting up voice activity monitoring:', error);
  }
}

function isUserSpeaking(peerId) {
  const context = audioContexts.get(peerId);
  if (!context) return false;

  context.analyser.getByteFrequencyData(context.array);

  // Calculate average frequency
  const average = context.array.reduce((a, b) => a + b) / context.array.length;

  // Threshold for detecting speech (adjust based on your needs)
  return average > 20;
}

// Update speaking indicators
setInterval(() => {
  // Check local user
  if (isUserSpeaking(state.userId)) {
    const user = state.users.get(state.userId);
    if (user && !user.isSpeaking) {
      user.isSpeaking = true;
      updateUsersList();
    }
  } else {
    const user = state.users.get(state.userId);
    if (user && user.isSpeaking) {
      user.isSpeaking = false;
      updateUsersList();
    }
  }

  // Check remote peers
  for (const [peerId] of state.peers) {
    if (isUserSpeaking(peerId)) {
      const user = state.users.get(peerId);
      if (user && !user.isSpeaking) {
        user.isSpeaking = true;
        updateUsersList();
      }
    } else {
      const user = state.users.get(peerId);
      if (user && user.isSpeaking) {
        user.isSpeaking = false;
        updateUsersList();
      }
    }
  }
}, 100);

// ============================================================================
// UI Updates
// ============================================================================

function updateUsersList() {
  usersList.innerHTML = '';

  // Add self
  const selfUser = document.createElement('div');
  selfUser.className = 'user-item';

  const avatar = document.createElement('div');
  avatar.className = 'user-avatar';
  avatar.textContent = getInitials(state.username);

  const info = document.createElement('div');
  info.className = 'user-info';

  const name = document.createElement('div');
  name.className = 'user-name';
  name.textContent = `${state.username} (You)`;

  const status = document.createElement('div');
  status.className = 'user-status';
  status.textContent = state.isMuted ? '🔇 Muted' : '🔊 Connected';

  const user = state.users.get(state.userId) || {};
  if (user.isScreenSharing) {
    const badge = document.createElement('div');
    badge.className = 'screen-share-badge';
    badge.textContent = '📺 Sharing';
    status.appendChild(badge);
  }

  info.appendChild(name);
  info.appendChild(status);

  selfUser.appendChild(avatar);
  selfUser.appendChild(info);

  if (user.isSpeaking) {
    const indicator = document.createElement('div');
    indicator.className = 'speaking-indicator';
    selfUser.appendChild(indicator);
  }

  usersList.appendChild(selfUser);

  // Add remote users
  for (const [peerId, user] of state.users) {
    const userEl = document.createElement('div');
    userEl.className = 'user-item';

    const avatarEl = document.createElement('div');
    avatarEl.className = 'user-avatar';
    avatarEl.textContent = getInitials(user.username);

    const infoEl = document.createElement('div');
    infoEl.className = 'user-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'user-name';
    nameEl.textContent = user.username;

    const statusEl = document.createElement('div');
    statusEl.className = 'user-status';
    statusEl.textContent = '🔊 Connected';

    if (user.isScreenSharing) {
      const badge = document.createElement('div');
      badge.className = 'screen-share-badge';
      badge.textContent = '📺 Sharing';
      statusEl.appendChild(badge);
    }

    infoEl.appendChild(nameEl);
    infoEl.appendChild(statusEl);

    userEl.appendChild(avatarEl);
    userEl.appendChild(infoEl);

    if (user.isSpeaking) {
      const indicator = document.createElement('div');
      indicator.className = 'speaking-indicator';
      userEl.appendChild(indicator);
    }

    usersList.appendChild(userEl);
  }

  // Update user count
  const totalUsers = state.users.size + 1; // +1 for self
  userCount.textContent = totalUsers;
}

function getInitials(name) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function showRoomScreen() {
  joinScreen.classList.remove('screen-active');
  roomScreen.classList.add('screen-active');
}

function showJoinScreen() {
  roomScreen.classList.remove('screen-active');
  joinScreen.classList.add('screen-active');
  joinForm.reset();
  joinError.style.display = 'none';
}

function showJoinError(message) {
  joinError.textContent = message;
  joinError.style.display = 'block';
}

// ============================================================================
// Leave Button
// ============================================================================

leaveBtn.addEventListener('click', () => {
  leaveRoom();
});

// ============================================================================
// Utility
// ============================================================================

function generateUserId() {
  return Math.random().toString(36).substr(2, 9);
}

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (state.username) {
    leaveRoom();
  }
});
