// server.js
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const SERVER_PASSWORD = process.env.SERVER_PASSWORD || 'password123';
const PORT = parseInt(process.env.PORT) || 3000;

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

function serverLog(username = 'SYSTEM', action, details = '') {
    const timestamp = getTimestamp();
    const logEntry = `[${timestamp}] ${username.padEnd(15)} | ${action.padEnd(25)} | ${details}`;
    console.log(logEntry);
    logStream.write(logEntry + '\n');
}

function formatUserList() {
    return Array.from(users.values()).map(u => u.username).join(', ') || 'empty';
}
// ===== END LOGGING =====

const users = new Map(); // WebSocket → { username, joinedAt }

const httpServer = http.createServer((req, res) => {
    let filePath = path.join(process.cwd(), 'public', req.url === '/' ? 'index.html' : req.url);
    
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'text/html';
    if (ext === '.css') contentType = 'text/css';
    else if (ext === '.js') contentType = 'text/javascript';

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

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    serverLog('SYSTEM', 'CONNECTION_OPEN', `IP: ${ip} | Total clients: ${wss.clients.size}`);
    
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (e) {
            serverLog('SYSTEM', 'INVALID_JSON', `From ${ip}`);
            return;
        }

        if (msg.type === 'join') {
            const { username, password } = msg;
            const cleanUsername = (username || '').trim();

            serverLog(cleanUsername || 'UNKNOWN', 'JOIN_ATTEMPT', `Password correct: ${password === SERVER_PASSWORD}`);

            if (password !== SERVER_PASSWORD) {
                serverLog(cleanUsername, 'JOIN_REJECTED', 'Wrong password');
                ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Wrong password' }));
                return;
            }

            if (!cleanUsername || cleanUsername.length < 2) {
                serverLog(cleanUsername, 'JOIN_REJECTED', 'Invalid username');
                ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Invalid username' }));
                return;
            }

            // Check duplicate username
            const taken = Array.from(users.values()).some(u => u.username === cleanUsername);
            if (taken) {
                serverLog(cleanUsername, 'JOIN_REJECTED', 'Username already taken');
                ws.send(JSON.stringify({ type: 'join_rejected', reason: 'Username already taken' }));
                return;
            }

            // Accept join
            users.set(ws, { 
                username: cleanUsername,
                joinedAt: new Date()
            });

            const userList = Array.from(users.values()).map(u => ({ username: u.username }));

            serverLog(cleanUsername, 'JOIN_SUCCESS', `Room now: ${formatUserList()}`);

            ws.send(JSON.stringify({
                type: 'join_ack',
                users: userList,
                iceServers: ICE_SERVERS
            }));

            // Broadcast to others
            const joinedMsg = JSON.stringify({ type: 'user_joined', username: cleanUsername });
            for (const [client, data] of users) {
                if (client !== ws && client.readyState === 1) {
                    client.send(joinedMsg);
                    serverLog(cleanUsername, 'BROADCAST', `user_joined → ${data.username}`);
                }
            }
        } 
        else if (['offer', 'answer', 'ice_candidate'].includes(msg.type)) {
            const senderData = users.get(ws);
            if (!senderData) {
                serverLog('SYSTEM', 'SIGNALING_BEFORE_JOIN', msg.type);
                return;
            }

            const { username: from } = senderData;
            const { to } = msg;

            serverLog(from, msg.type.toUpperCase(), `→ ${to} | ${msg.type === 'ice_candidate' ? 'candidate' : 'SDP'}`);

            const targetWs = Array.from(users.entries())
                .find(([_, u]) => u.username === to)?.[0];

            if (targetWs && targetWs.readyState === 1) {
                const forward = { ...msg, from };
                targetWs.send(JSON.stringify(forward));
                serverLog(from, 'FORWARDED', `${msg.type} to ${to}`);
            } else {
                serverLog(from, 'TARGET_NOT_FOUND', `Tried to send ${msg.type} to ${to}`);
            }
        }
    });

    ws.on('close', (code, reason) => {
        const userData = users.get(ws);
        if (userData) {
            const { username } = userData;
            const duration = Math.round((Date.now() - userData.joinedAt) / 1000);

            serverLog(username, 'DISCONNECT', `Code: ${code} | Duration: ${duration}s | Remaining: ${formatUserList()}`);

            users.delete(ws);

            // Broadcast leave
            const leftMsg = JSON.stringify({ type: 'user_left', username });
            for (const [client, data] of users) {
                if (client.readyState === 1) {
                    client.send(leftMsg);
                    serverLog(username, 'BROADCAST', `user_left → ${data.username}`);
                }
            }
        } else {
            serverLog('SYSTEM', 'DISCONNECT', `Anonymous client (code ${code})`);
        }
    });

    ws.on('error', (err) => {
        serverLog('SYSTEM', 'WEBSOCKET_ERROR', err.message);
    });
});

httpServer.listen(PORT, () => {
    serverLog('SYSTEM', 'SERVER_START', `Listening on port ${PORT} | Password protected`);
});

console.log(`\n🚀 Voice Room server started with verbose logging!`);
console.log(`📁 Logs are being written to: ./logs/server.log\n`);