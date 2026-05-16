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
  console.log('🔌 Client connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'join') {
      const { username, password } = msg;
      if (password !== SERVER_PASSWORD) {
        ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Wrong password' }));
        return;
      }

      const usernameTaken = Array.from(users.values()).some(u => u.username === username);
      if (usernameTaken) {
        ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Username already taken' }));
        return;
      }

      users.set(ws, { username });

      const userList = Array.from(users.values()).map((u) => ({ username: u.username }));
      ws.send(JSON.stringify({ type: 'join_ack', users: userList, iceServers: ICE_SERVERS }));

      const joinedMessage = JSON.stringify({ type: 'user_joined', username });
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === client.OPEN) {
          client.send(joinedMessage);
        }
      }
      return;
    }

    if (!users.has(ws)) {
      return;
    }

    if (['offer', 'answer', 'ice_candidate'].includes(msg.type)) {
      const fromUser = users.get(ws).username;
      const targetEntry = Array.from(users.entries()).find(([, u]) => u.username === msg.to);
      if (!targetEntry) {
        return;
      }

      const [targetWs] = targetEntry;
      if (targetWs.readyState !== targetWs.OPEN) {
        return;
      }

      const forwarded = { ...msg, from: fromUser };
      targetWs.send(JSON.stringify(forwarded));
    }
  });

  ws.on('close', () => {
    if (!users.has(ws)) {
      return;
    }

    const { username } = users.get(ws);
    users.delete(ws);

    const leftMessage = JSON.stringify({ type: 'user_left', username });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(leftMessage);
      }
    }
    console.log(`👋 ${username} left`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Voice Room server running on http://localhost:${PORT}`);
  console.log(`   Password: ${SERVER_PASSWORD}`);
  console.log(`   STUN/TURN: configured`);
});
