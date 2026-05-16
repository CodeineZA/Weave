import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const SERVER_PASSWORD = process.env.SERVER_PASSWORD || 'password123';
const PORT = parseInt(process.env.PORT, 10) || 3000;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }
];

if (process.env.TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL,
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL
  });
}

// ===== LOGGING INFRASTRUCTURE =====
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function serverLog(username, action, details = '') {
  const timestamp = getTimestamp();
  const logEntry = `[${timestamp}] ${username || 'SYSTEM'} - ${action} ${details}`;
  console.log(logEntry);
  logStream.write(logEntry + '\n');
}

function formatUserList() {
  return Array.from(users.values()).map(u => u.username).join(', ') || 'empty';
}
// ===== END LOGGING =====

const users = new Map(); // WebSocket -> { username }
const publicRoot = path.join(process.cwd(), 'public');

const httpServer = http.createServer((req, res) => {
  const cleanUrl = req.url?.split('?')[0] || '/';
  let filePath = path.join(publicRoot, cleanUrl === '/' ? 'index.html' : cleanUrl);

  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  serverLog('SYSTEM', 'WS_CONNECT', `New connection. Total users: ${users.size}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      serverLog('SYSTEM', 'MSG_PARSE_ERROR', e.message);
      return;
    }

    if (msg.type === 'join') {
      const { username, password } = msg;
      
      if (password !== SERVER_PASSWORD) {
        serverLog(username, 'JOIN_FAILED', 'Wrong password');
        ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Wrong password' }));
        return;
      }

      const usernameTaken = Array.from(users.values()).some(u => u.username === username);
      if (usernameTaken) {
        serverLog(username, 'JOIN_FAILED', 'Username already taken');
        ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Username already taken' }));
        return;
      }

      users.set(ws, { username });
      serverLog(username, 'JOIN_SUCCESS', `Room now has: ${formatUserList()}`);

      const userList = Array.from(users.values()).map((u) => ({ username: u.username }));
      ws.send(JSON.stringify({ type: 'join_ack', users: userList, iceServers: ICE_SERVERS }));

      const joinedMessage = JSON.stringify({ type: 'user_joined', username });
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === client.OPEN) {
          client.send(joinedMessage);
          serverLog(username, 'BROADCAST_JOIN', `Notified ${users.get(client)?.username || 'unknown'}`);
        }
      }
      return;
    }

    if (!users.has(ws)) {
      serverLog('SYSTEM', 'UNAUTH_MSG', `Message from unjoined client: ${msg.type}`);
      return;
    }

    const fromUser = users.get(ws).username;

    if (msg.type === 'offer') {
      const targetEntry = Array.from(users.entries()).find(([, u]) => u.username === msg.to);
      if (!targetEntry) {
        serverLog(fromUser, 'OFFER_FAILED', `Target ${msg.to} not found`);
        return;
      }
      
      const [targetWs] = targetEntry;
      if (targetWs.readyState !== targetWs.OPEN) {
        serverLog(fromUser, 'OFFER_FAILED', `Target ${msg.to} connection closed`);
        return;
      }

      targetWs.send(JSON.stringify({ ...msg, from: fromUser }));
      serverLog(fromUser, 'OFFER_SENT', `to ${msg.to}`);
      return;
    }

    if (msg.type === 'answer') {
      const targetEntry = Array.from(users.entries()).find(([, u]) => u.username === msg.to);
      if (!targetEntry) {
        serverLog(fromUser, 'ANSWER_FAILED', `Target ${msg.to} not found`);
        return;
      }
      
      const [targetWs] = targetEntry;
      if (targetWs.readyState !== targetWs.OPEN) {
        serverLog(fromUser, 'ANSWER_FAILED', `Target ${msg.to} connection closed`);
        return;
      }

      targetWs.send(JSON.stringify({ ...msg, from: fromUser }));
      serverLog(fromUser, 'ANSWER_SENT', `to ${msg.to}`);
      return;
    }

    if (msg.type === 'ice_candidate') {
      const targetEntry = Array.from(users.entries()).find(([, u]) => u.username === msg.to);
      if (!targetEntry) {
        serverLog(fromUser, 'ICE_CANDIDATE_FAILED', `Target ${msg.to} not found`);
        return;
      }

      const [targetWs] = targetEntry;
      if (targetWs.readyState !== targetWs.OPEN) {
        serverLog(fromUser, 'ICE_CANDIDATE_FAILED', `Target ${msg.to} connection closed`);
        return;
      }

      targetWs.send(JSON.stringify({ ...msg, from: fromUser }));
      serverLog(fromUser, 'ICE_CANDIDATE_FWD', `to ${msg.to} - candidate type: ${msg.candidate?.candidate?.split(' ')[7] || 'unknown'}`);
      return;
    }

    if (msg.type === 'audio_diagnostic') {
      const diagnostic = JSON.stringify(msg, null, 2);
      serverLog(fromUser, 'AUDIO_DIAGNOSTIC', diagnostic);
      return;
    }

    if (msg.type === 'rtc_stats') {
      const stats = JSON.stringify(msg.stats, null, 2);
      serverLog(fromUser, 'RTC_STATS', `Peer: ${msg.peer} - ${stats}`);
      return;
    }
  });

  ws.on('close', () => {
    if (!users.has(ws)) {
      serverLog('SYSTEM', 'WS_CLOSE', 'Unjoined connection closed');
      return;
    }

    const { username } = users.get(ws);
    users.delete(ws);
    serverLog(username, 'DISCONNECT', `Intentional close. Room now has: ${formatUserList()}`);

    const leftMessage = JSON.stringify({ type: 'user_left', username });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(leftMessage);
        serverLog(username, 'BROADCAST_LEAVE', `Notified ${users.get(client)?.username || 'unknown'}`);
      }
    }
  });

  ws.on('error', (err) => {
    const username = users.get(ws)?.username || 'UNKNOWN';
    serverLog(username, 'WS_ERROR', err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Voice Room server running on http://localhost:${PORT}`);
  console.log(`   Password: ${SERVER_PASSWORD}`);
  console.log(`   STUN/TURN: configured`);
  console.log(`   Logs: ${logFile}`);
  serverLog('SYSTEM', 'SERVER_START', `Listening on port ${PORT}`);
});

process.on('exit', () => {
  logStream.end();
});
