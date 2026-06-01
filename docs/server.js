const express = require('express');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SERVER_PASSWORD = process.env.SERVER_PASSWORD || 'password';

// In-memory room state
const room = {
  users: new Map(), // userId -> { username, ws, id }
};

// Generate unique user ID
function generateUserId() {
  return Math.random().toString(36).substr(2, 9);
}

// Broadcast message to all connected users
function broadcast(message, excludeWs = null) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(JSON.stringify(message));
    }
  });
}

// Get current user list
function getUserList() {
  return Array.from(room.users.values()).map(user => ({
    id: user.id,
    username: user.username,
  }));
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  let userId = null;
  let username = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'join': {
          // Validate password
          if (message.password !== SERVER_PASSWORD) {
            ws.send(
              JSON.stringify({
                type: 'join_rejected',
                reason: 'Invalid password',
              })
            );
            ws.close();
            return;
          }

          // Store user info
          userId = message.userId;
          username = message.username;
          room.users.set(userId, { id: userId, username, ws });

          // Send join acknowledgement with current user list
          ws.send(
            JSON.stringify({
              type: 'join_ack',
              userId,
              users: getUserList(),
              turnConfig: {
                url: process.env.TURN_URL || null,
                username: process.env.TURN_USERNAME || null,
                credential: process.env.TURN_CREDENTIAL || null,
              },
            })
          );

          // Broadcast that a new user joined
          broadcast({
            type: 'user_joined',
            userId,
            username,
            users: getUserList(),
          });

          break;
        }

        case 'offer':
        case 'answer':
        case 'ice_candidate': {
          // Route signaling messages to specific peer
          const targetUser = room.users.get(message.to);
          if (targetUser && targetUser.ws.readyState === WebSocket.OPEN) {
            targetUser.ws.send(
              JSON.stringify({
                type: message.type,
                from: userId,
                data: message.data,
              })
            );
          }
          break;
        }

        case 'screen_share_start': {
          broadcast({
            type: 'screen_share_started',
            userId,
            username,
          });
          break;
        }

        case 'screen_share_stop': {
          broadcast({
            type: 'screen_share_stopped',
            userId,
          });
          break;
        }

        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    if (userId) {
      room.users.delete(userId);

      // Broadcast that user left
      broadcast({
        type: 'user_left',
        userId,
        username,
        users: getUserList(),
      });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

server.listen(PORT, () => {
  console.log(`🎤 Voice chat server running on port ${PORT}`);
  console.log(`📍 Visit http://localhost:${PORT}`);
});
