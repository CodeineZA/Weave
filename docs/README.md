# 🎤 Voice Chat Room

A lightweight, self-hosted voice and screen sharing web app for small groups. No accounts, no sign-ups—just a username, password, and you're in.

## Features

✅ **Voice Chat** — Real-time peer-to-peer audio via WebRTC  
✅ **Screen Sharing** — Share your screen with the group  
✅ **No Accounts** — Just a username and room password  
✅ **Simple UI** — Dark theme, minimal interface  
✅ **Voice Activity Detection** — See who's speaking  
✅ **Responsive Design** — Works on desktop and mobile  
✅ **Self-Hosted** — Full control, no third-party services  

## Quick Start

### 1. Prerequisites

- **Node.js** (v14 or later)
- **npm** (comes with Node.js)
- A modern web browser (Chrome, Firefox, Edge, Safari)

### 2. Installation

```bash
# Clone or download the project
cd voice-chat-room

# Install dependencies
npm install
```

### 3. Configure

Edit `.env` file:

```env
SERVER_PASSWORD=friends123
PORT=3000

# Optional: TURN server for NAT traversal
# TURN_URL=turn:your-turn-server.com:3478
# TURN_USERNAME=username
# TURN_CREDENTIAL=credential
```

### 4. Run

```bash
npm start
```

The server starts on `http://localhost:3000`

### 5. Join

1. Open `http://localhost:3000` in your browser
2. Enter your name
3. Enter the room password (`friends123` by default)
4. Click **Join Room**

## Usage

### Controls

- **Mute Button** — Toggle your microphone on/off
- **Share Screen Button** — Start/stop screen sharing
- **Leave Button** — Exit the room

### Features in Action

- **User List** — See who's in the room on the right sidebar
- **Speaking Indicator** — Pulsing dot appears when someone speaks
- **Screen Sharing** — Full-screen or windowed capture, displayed in the main area
- **Multiple Screens** — If 2+ people share, they appear in a grid

## Architecture

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML, CSS, JavaScript |
| Signaling | Node.js + WebSocket (ws) |
| Media | WebRTC (RTCPeerConnection) |
| Hosting | Any server (Raspberry Pi, cloud, etc.) |

### Data Flow

```
Client A                 Signaling Server              Client B
   |                           |                          |
   |--------join msg--------->|                          |
   |                           |<-------join msg---------| 
   |                           |------user_joined------->|
   |<----------user_joined-----|                          |
   |                           |                          |
   |----------offer--------->|                           |
   |                           |----------offer--------->|
   |<---------answer---------|<----------answer---------|
   |                           |                          |
   |========ICE candidates====|=========ICE candidates===|
   |                           |                          |
   |<--------audio (P2P)-------->|<--------audio (P2P)-------->|
   |                           |                          |
```

**Key Points:**
- WebSocket only for signaling (join, offers, answers, ICE candidates)
- Media (audio/video) flows peer-to-peer, not through the server
- Server is lightweight and stateless

### File Structure

```
voice-chat-room/
├── server.js           # WebSocket signaling server
├── package.json        # Node.js dependencies
├── .env                # Configuration (password, port)
└── public/
    ├── index.html      # Single-page app shell
    ├── style.css       # Dark theme styling
    └── app.js          # Complete WebRTC + signaling logic
```

## Deployment

### Local Network

1. Find your machine's IP: `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux)
2. Change `localhost:3000` to `<your-ip>:3000`
3. Share the URL with friends on your network

### Raspberry Pi

```bash
# On Raspberry Pi
sudo apt update
sudo apt install nodejs npm
cd /path/to/voice-chat-room
npm install
npm start
```

### With Cloudflare Tunnel (Public Internet)

```bash
# Install cloudflared
# macOS: brew install cloudflare/cloudflare/cloudflared
# Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/

# Create tunnel
cloudflared tunnel create voice-chat
cloudflared tunnel route dns voice-chat <your-domain.com>

# Run tunnel
cloudflared tunnel run voice-chat
```

Your app is now public at `https://voice-chat.your-domain.com`

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY . .
RUN npm install

EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t voice-chat .
docker run -e SERVER_PASSWORD=friends123 -p 3000:3000 voice-chat
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|------------|
| `SERVER_PASSWORD` | `password` | Shared password for joining |
| `PORT` | `3000` | Server port |
| `TURN_URL` | (none) | TURN server URL (optional) |
| `TURN_USERNAME` | (none) | TURN username (optional) |
| `TURN_CREDENTIAL` | (none) | TURN credential (optional) |

### STUN/TURN

The app uses Google's free STUN servers by default:
- `stun.l.google.com:19302`
- `stun1.l.google.com:19302`
- `stun2.l.google.com:19302`

For self-hosting with double NAT, add a TURN server:

```env
TURN_URL=turn:example.com:3478
TURN_USERNAME=user
TURN_CREDENTIAL=pass
```

Popular TURN servers:
- [Coturn](https://github.com/coturn/coturn) — Open source
- [AWS ICE](https://aws.amazon.com/kinesisvideo/) — Managed service
- [Xirsys](https://xirsys.com/) — Commercial

## Troubleshooting

### "Cannot connect to server"
- Ensure server is running: `npm start`
- Check port is accessible: `curl http://localhost:3000`
- Try accessing from another machine on same network

### "Microphone not working"
- Check browser permissions (allow audio access)
- Try `about:permissions` in browser (Firefox) or Settings > Privacy (Chrome)
- Ensure no other app is using the microphone

### "No audio after joining"
- Check WebRTC connection in browser DevTools (F12 → Connection tab)
- Verify both users are connected to the same server
- Try reloading the page

### "Screen share not working"
- HTTPS only works with screen sharing (except localhost)
- Use `https://` if deployed to public internet
- Try different browser (Chrome, Edge, Firefox all support it)

### "Can't hear someone"
- Check their mute status in the user list
- Verify their browser has audio output enabled
- Try Firefox instead (different audio handling)

### "High latency/lag"
- Check network connection (ping server)
- Reduce audio quality or use headphones
- Consider TURN server if using double NAT

## Performance

### Bandwidth

- **Audio only**: ~40-60 kbps per peer
- **Screen share**: ~500 kbps - 2 Mbps (depends on resolution/movement)
- **For 8 people**: ~320-480 kbps per person (upload + download)

### CPU

- **Audio processing**: ~5-10% CPU per peer
- **Screen capture**: ~15-25% CPU

### Server Requirements

- **Minimum**: 512 MB RAM, 1 CPU core
- **Recommended**: 2 GB RAM, 2 CPU cores
- **For 8 people**: Raspberry Pi 4+ is sufficient

## Browser Support

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome/Edge | ✅ Full | Best performance |
| Firefox | ✅ Full | Good performance |
| Safari | ✅ Full | iOS requires iOS 15+ |
| Opera | ✅ Full | Based on Chromium |

## Security Notes

1. **Password** — Use a strong, unique password in `.env`
2. **HTTPS** — Use HTTPS in production (for screen sharing and security)
3. **Network** — Only accessible to people you give the URL/password to
4. **Data** — All media flows peer-to-peer; server never sees it
5. **No Logging** — Server doesn't record audio, video, or content

## Advanced Configuration

### Custom STUN Servers

Edit `app.js` in the `CONFIG` object:

```javascript
const CONFIG = {
  iceServers: [
    { urls: 'stun:your-stun-server.com:3478' },
    { urls: 'stun:another-server.com:3478' },
  ],
  // ...
};
```

### Increase Voice Activity Detection Sensitivity

In `app.js`, adjust the threshold in `isUserSpeaking()`:

```javascript
function isUserSpeaking(peerId) {
  // ...
  const average = context.array.reduce((a, b) => a + b) / context.array.length;
  return average > 20; // Lower = more sensitive
}
```

### Custom Room Themes

Edit `public/style.css` CSS variables:

```css
:root {
  --primary-color: #5865f2; /* Change to your color */
  --bg-primary: #36393f;
  /* ... other colors ... */
}
```

## Limitations

- **Maximum Users** — Works well with 8-10 people; scales to ~20 with lower quality
- **Single Room** — All users join the same room (no multiple rooms)
- **No Recording** — No built-in recording (can be added if needed)
- **No Encryption** — WebRTC uses DTLS (encrypted), but transport depends on HTTPS
- **No Profile Pictures** — Uses initials instead

## FAQ

**Q: Can I use this over the internet?**  
A: Yes, via Cloudflare Tunnel or a VPS. Use HTTPS for security.

**Q: Can I record conversations?**  
A: Not built-in, but you can add MediaRecorder API to `app.js`.

**Q: How many people can join?**  
A: Works best with 8-10. Each person uploads to all others, so bandwidth/CPU increases with group size.

**Q: Can I change the password?**  
A: Yes, edit `.env` and restart the server.

**Q: Can I host on a Raspberry Pi?**  
A: Yes! Pi 4 or later recommended. The signaling server uses minimal resources.

**Q: Is this GDPR/HIPAA compliant?**  
A: Since it's self-hosted, you control all data. No third-party tracking.

## Contributing

Found a bug? Have an idea? Feel free to:
1. Open an issue
2. Submit a pull request
3. Fork and customize for your needs

## License

MIT License — Use freely, commercially or personally.

## Support

For issues, questions, or improvements:
1. Check the troubleshooting section
2. Review browser console (F12) for errors
3. Verify network connectivity
4. Test with a simpler setup (same Wi-Fi network)

---

**Built for small groups, friends, and teams. Enjoy!** 🎤✨
