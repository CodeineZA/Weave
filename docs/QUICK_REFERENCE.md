# Voice Chat Room - Quick Reference

## 🚀 First Time Setup

```bash
# 1. Install dependencies
npm install

# 2. Auto-generate config (macOS/Linux)
chmod +x setup.sh
./setup.sh

# 3. Start server
npm start

# 4. Open browser
# http://localhost:3000
```

## 📝 Common Commands

### Start/Stop Server
```bash
npm start                  # Start (Ctrl+C to stop)
npm run dev               # Same as start
sudo systemctl start voice-chat   # Systemd (Pi)
sudo systemctl stop voice-chat    # Systemd stop
```

### Configuration
```bash
nano .env                 # Edit password/port
# Change: SERVER_PASSWORD=new_password
# Restart server for changes to apply
```

### Monitoring
```bash
sudo journalctl -u voice-chat.service -f    # Live logs (Pi)
sudo systemctl status voice-chat.service    # Check status (Pi)
curl http://localhost:3000                   # Test server running
```

### Network
```bash
hostname -I              # Find IP address (Linux)
ifconfig | grep inet     # Find IP (macOS)
ipconfig                 # Find IP (Windows)

# Test on another device
# http://<your-ip>:3000
```

## 🔧 Troubleshooting

### Server Won't Start
```bash
# Check Node.js installed
node --version          # Should be v14+

# Check port available
lsof -i :3000          # Should be empty
# If not: kill $(lsof -t -i:3000)

# Check .env syntax
cat .env                # No spaces around =

# Run with errors visible
npm start
```

### Can't Hear Audio
```
1. Mute button green?       → Click to unmute
2. Microphone permissions?  → Check browser settings
3. Both users connected?    → Check user list
4. Try different browser    → Test in Firefox/Chrome
```

### Peer Connection Failing
```
1. Same network?           → Use ping or traceroute
2. Firewall blocking?      → Check router firewall
3. Double NAT?             → Set up TURN server
4. Restart both peers      → Refresh page
```

### High CPU/Memory
```bash
# Check usage
top                     # Press 'q' to quit
free -h                # RAM usage

# Pi optimization
export NODE_OPTIONS="--max-old-space-size=512"
npm start

# Limit users to 5-8 on low-spec Pi
```

## 🌐 Deployment Quick Links

### Cloudflare Tunnel (Recommended for Public)
```bash
# 1. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
# 2. Authenticate
cloudflared tunnel login

# 3. Create tunnel
cloudflared tunnel create voice-chat

# 4. Route domain
cloudflared tunnel route dns voice-chat your-domain.com

# 5. Run tunnel
cloudflared tunnel run voice-chat

# Access: https://voice-chat.your-domain.com
```

### Docker Quick Start
```bash
docker build -t voice-chat .
docker run -e SERVER_PASSWORD=friends123 -p 3000:3000 voice-chat
# http://localhost:3000
```

### Raspberry Pi Service
```bash
sudo systemctl enable voice-chat.service    # Auto-start on boot
sudo systemctl start voice-chat.service     # Start now
sudo systemctl status voice-chat.service    # Check status
sudo journalctl -u voice-chat -f            # View logs
```

## 🎨 Quick Customization

### Change Password
```bash
# Edit .env
SERVER_PASSWORD=newpassword123

# Restart server
npm start
```

### Change Theme Colors
```bash
# Edit public/style.css, change :root colors:
--primary-color: #YOUR_COLOR;
--bg-primary: #YOUR_COLOR;
--text-primary: #YOUR_COLOR;
```

### Change Room Settings
```bash
# Max users per connection (app.js)
// Edit voice activity threshold (lower = more sensitive)
return average > 20;  // Try: return average > 10;

# Audio quality
CONFIG.audioConstraints.audio.echoCancellation = false; // Disable if unwanted
```

## 📊 Status Checks

### Is Server Running?
```bash
curl http://localhost:3000
# Should return HTML (not error)
```

### Check Port
```bash
netstat -tulpn | grep 3000
# Should show Node process listening
```

### Test Peer Connection
1. Open http://localhost:3000 in 2 browsers
2. Use same password
3. Enter different usernames
4. Check "In Room" count
5. Test audio (unmute button)

## 🔒 Security Quick Tips

### Change Default Password
```bash
# Before deploying!
nano .env
SERVER_PASSWORD=<VERY_STRONG_PASSWORD>
```

### Limit Network Access
```bash
# Only allow from specific IP
sudo ufw allow from 192.168.1.100 to any port 3000
```

### Run as Non-Root (Linux)
```bash
# Don't run as sudo! Instead:
whoami                           # Check user
npm start                        # Run as regular user
```

## 📈 Performance Benchmarks

| Setup | Max Users | CPU | RAM | Bandwidth |
|-------|----------|-----|-----|-----------|
| Laptop | 10 | 20% | 300 MB | 10 Mbps |
| Raspberry Pi 4 | 8 | 60% | 256 MB | 8 Mbps |
| VPS (2GB) | 20+ | 40% | 512 MB | 20 Mbps |

## 🆘 Emergency Procedures

### Force Kill Server
```bash
# If npm start won't stop
pkill -f "node server.js"
# Or: kill $(lsof -t -i:3000)
```

### Reset to Defaults
```bash
rm .env
./setup.sh
npm start
```

### Clear Corrupted State
```bash
# Stop server
# Clear everything except code
rm -rf node_modules package-lock.json
npm install
npm start
```

### Emergency Restore from Backup
```bash
tar -xzf voice-chat-backup-*.tar.gz
cd voice-chat-room
npm install
npm start
```

## 📞 Support Resources

- **README.md** — Full documentation
- **OVERVIEW.md** — Architecture details
- **RASPBERRY_PI_GUIDE.md** — Pi setup
- **TURN_SERVER_SETUP.md** — NAT traversal
- **Browser DevTools** — F12 for errors (Network tab for connection issues)

## 🎯 Testing Checklist

Before sharing with friends:

- [ ] Server starts without errors
- [ ] Can access http://localhost:3000
- [ ] Join with valid password
- [ ] See own name in user list
- [ ] Microphone icon works (mute/unmute)
- [ ] Can hear audio from test device
- [ ] Screen share button works
- [ ] Can access from another device on same network
- [ ] Password works correctly
- [ ] Wrong password is rejected
- [ ] Leaving room cleans up properly

## 🚀 One-Liner Deployment

```bash
# Full setup, start, and ready
npm install && npm start
```

## 🔄 Regular Maintenance

### Weekly
```bash
# Check logs for errors
sudo journalctl -u voice-chat.service -n 100

# Monitor resource usage
top
```

### Monthly
```bash
# Backup config
cp .env .env.backup.$(date +%Y%m%d)

# Update Node.js
node --version
npm --version
```

### Quarterly
```bash
# Check for Node security updates
npm audit
npm audit fix

# Test audio quality with friends
# Get user feedback on lag/quality
```

---

**Need more help?** See full README.md or deployment-specific guides.

**Quick start recap:** `npm install && npm start` → http://localhost:3000 ✨
