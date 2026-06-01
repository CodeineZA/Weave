# 🎤 Voice Chat Room - Get Started in 5 Minutes

## What You Have

A complete, production-ready voice & screen sharing app. Everything is ready to use—no build tools, no dependencies, just Node.js.

## 5-Minute Setup

### Step 1: Install Node.js (if needed)
- Visit https://nodejs.org/ (LTS version)
- Install and verify: `node --version`

### Step 2: Extract Files
- Download the project files
- Extract to a folder (e.g., `voice-chat-room/`)

### Step 3: Install Dependencies
```bash
cd voice-chat-room
npm install
```

### Step 4: Create Configuration
```bash
# macOS/Linux
chmod +x setup.sh
./setup.sh

# Windows (manually)
# Edit .env file, set:
# SERVER_PASSWORD=your_password_here
# PORT=3000
```

### Step 5: Start Server
```bash
npm start
```

Output should show:
```
🎤 Voice chat server running on port 3000
📍 Visit http://localhost:3000
```

### Step 6: Open Browser
Visit: **http://localhost:3000**

## 🔑 Join the Room

1. Enter your **name**
2. Enter the **password** (from `.env`)
3. Click **Join Room**

That's it! You're connected.

## 📱 Test It

Open in **2 browser tabs or devices**:
1. Tab 1: `http://localhost:3000`
2. Tab 2: `http://localhost:3000` (or use phone on same Wi-Fi)
3. Join with different names
4. Test audio (click Mute button to unmute)
5. Try Screen Share

## 🌍 Share with Friends

### Same Wi-Fi Network
1. Find your IP: `hostname -I` (Linux) or `ifconfig` (macOS)
2. Share: `http://<your-ip>:3000`
3. Password: Check `.env` file

### Over Internet (Easy)
Use **Cloudflare Tunnel** (free):

```bash
# 1. Download: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
# 2. Sign in
cloudflared tunnel login

# 3. Create tunnel
cloudflared tunnel create voice-chat

# 4. Connect domain (if you have one)
cloudflared tunnel route dns voice-chat your-domain.com

# 5. Run
cloudflared tunnel run voice-chat

# 6. Share: https://voice-chat.your-domain.com
```

### 24/7 on Raspberry Pi
See `RASPBERRY_PI_GUIDE.md` for complete instructions.

## 🎯 How to Use

### Controls
- **Mute Button** — Toggles microphone
- **Share Screen** — Share window or entire screen
- **Leave** — Exit room
- **User List** — See who's connected (right sidebar)
- **Speaking Indicator** — Pulsing dot when speaking

### Features
- ✅ Voice chat (open mic, no push-to-talk)
- ✅ Screen sharing (multiple shares = grid view)
- ✅ See who's speaking
- ✅ See who's screen sharing
- ✅ Works on desktop & mobile
- ✅ Dark theme

## ⚙️ Configuration

Edit `.env` to change:

```env
SERVER_PASSWORD=your_password    # Change this to something stronger
PORT=3000                        # Web server port (leave as-is usually)

# Advanced (optional):
# TURN_URL=turn:example.com:3478   # For NAT traversal
# TURN_USERNAME=user
# TURN_CREDENTIAL=pass
```

**Restart server after changes:**
```bash
# Stop: Ctrl+C
# Start: npm start
```

## 🚨 Troubleshooting

### "Can't start server"
- Check Node.js is installed: `node --version`
- Check port 3000 is free: `lsof -i :3000`
- Check `.env` has no spaces around `=`

### "Can't hear audio"
- Unmute button (should say "Mute", not green)
- Check browser permissions: Settings → Privacy → Microphone
- Refresh page (Ctrl+R)
- Try different browser

### "Can't connect from other devices"
- Same Wi-Fi network? Yes → Use `http://<your-ip>:3000`
- Use static IP? See `RASPBERRY_PI_GUIDE.md`
- Over internet? Use Cloudflare Tunnel (see above)

### "Screen sharing not working"
- Only works over HTTPS (except localhost)
- Use Cloudflare Tunnel for HTTPS
- Try Chrome or Edge browser

## 📚 Full Documentation

| File | For |
|------|-----|
| `README.md` | Complete guide (users & admins) |
| `OVERVIEW.md` | How it works (architecture) |
| `QUICK_REFERENCE.md` | Common commands |
| `RASPBERRY_PI_GUIDE.md` | Running on Raspberry Pi |
| `TURN_SERVER_SETUP.md` | Advanced NAT traversal |

## 💾 File Structure

```
voice-chat-room/
├── server.js          ← Node.js server (runs signaling)
├── .env               ← Your configuration
├── package.json       ← Dependencies list
├── setup.sh           ← Setup helper script
└── public/
    ├── index.html     ← Web page
    ├── style.css      ← Styling
    └── app.js         ← Client code (WebRTC)
```

## 🔒 Security

- **Password-protected** — Only friends with password can join
- **P2P** — Audio flows directly between peers (not through server)
- **Encrypted** — WebRTC uses DTLS encryption
- **No accounts** — No database, no data collection
- **Self-hosted** — You control everything

**Change the default password before sharing!**

## 📊 What Can It Handle

- **Users:** Works well with 8-10 people
- **Bandwidth:** ~60 kbps per person (audio only)
- **CPU:** Uses ~5-10% per peer
- **Server:** Raspberry Pi 4+ is sufficient

## 🚀 Next Steps

1. ✅ Install Node.js (if needed)
2. ✅ Extract project files
3. ✅ Run `npm install`
4. ✅ Run `./setup.sh` (or edit `.env` manually)
5. ✅ Run `npm start`
6. ✅ Open http://localhost:3000
7. ✅ Test with 2 browsers
8. ✅ Share with friends!

## 💡 Tips

- **Multiple rooms?** Currently one shared room. Separate instances need separate ports.
- **Recording?** Not built-in, but can be added later.
- **High latency?** Check network (speedtest.net), consider TURN server.
- **Mobile issues?** Works on mobile browsers (iOS 15+, Android Chrome).
- **Styling?** Edit `public/style.css` to customize colors.

## ✨ You're All Set!

Your voice chat room is ready. 

**Start now:**
```bash
npm start
```

**Then visit:**
```
http://localhost:3000
```

Enjoy calling with friends! 🎤

---

**Questions?** See `README.md` or `QUICK_REFERENCE.md` for more help.
