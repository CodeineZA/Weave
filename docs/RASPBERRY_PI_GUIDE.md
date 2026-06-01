# Deploying Voice Chat Room on Raspberry Pi

## Hardware Requirements

- **Raspberry Pi 4** (2GB+ RAM recommended)
- **Micro SD Card** (16GB+)
- **Power Supply** (USB-C, 5.1V/3A+)
- **Network** (Ethernet or Wi-Fi)

## Step-by-Step Setup

### 1. Prepare Raspberry Pi

```bash
# Update system
sudo apt update
sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install nodejs -y

# Verify installation
node --version  # Should be v18+
npm --version   # Should be v8+
```

### 2. Install the App

```bash
# Navigate to your home directory
cd ~

# Clone or download the project
git clone <your-repo> voice-chat-room
# OR: unzip voice-chat-room.zip

# Enter directory
cd voice-chat-room

# Install dependencies
npm install
```

### 3. Configure

```bash
# Edit .env file
nano .env
```

Set strong password:
```env
SERVER_PASSWORD=your_secure_password_here
PORT=3000
```

Save (Ctrl+X, then Y, then Enter)

### 4. Test Locally

```bash
npm start
```

Open browser: `http://localhost:3000`

### 5. Run as Background Service (systemd)

Create a service file:

```bash
sudo nano /etc/systemd/system/voice-chat.service
```

Paste:

```ini
[Unit]
Description=Voice Chat Room Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/voice-chat-room
ExecStart=/usr/bin/node /home/pi/voice-chat-room/server.js
Restart=always
RestartSec=10
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable voice-chat.service
sudo systemctl start voice-chat.service

# Check status
sudo systemctl status voice-chat.service

# View logs
sudo journalctl -u voice-chat.service -f
```

### 6. Access from Another Device

Find your Pi's IP:

```bash
hostname -I
```

Example: `192.168.1.100`

On another device, open: `http://192.168.1.100:3000`

## Network Setup

### Static IP (Optional)

Edit `/etc/dhcpcd.conf`:

```bash
sudo nano /etc/dhcpcd.conf
```

Add at the end:

```
interface wlan0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=8.8.8.8 8.8.4.4
```

Restart networking:

```bash
sudo systemctl restart dhcpcd
```

### Port Forwarding (Router)

To access from outside your network:

1. Log into router (usually `192.168.1.1`)
2. Find "Port Forwarding" settings
3. Forward port `3000` (external) → `192.168.1.100:3000` (internal)
4. Access via your public IP: `http://your-public-ip:3000`

**Warning:** This exposes your app to the internet. Use a strong password!

### Better: Cloudflare Tunnel

No port forwarding needed:

```bash
# Install cloudflared
curl -L --output cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.tgz
tar -xzf cloudflared.tgz
sudo mv cloudflared /usr/local/bin/
rm cloudflared.tgz

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create voice-chat

# Point domain to tunnel
cloudflared tunnel route dns voice-chat your-domain.com

# Run tunnel
cloudflared tunnel run voice-chat
```

Create systemd service for cloudflared:

```bash
sudo nano /etc/systemd/system/cloudflared.service
```

```ini
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
Type=simple
User=cloudflared
ExecStart=/usr/local/bin/cloudflared tunnel run voice-chat
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo useradd -r -s /bin/false cloudflared
sudo systemctl enable cloudflared.service
sudo systemctl start cloudflared.service
```

## Monitoring

### Check CPU/Memory

```bash
# Real-time stats
top

# Memory usage
free -h

# Disk usage
df -h
```

### Optimize for Low-Spec Pi

If using Pi 3 or older, optimize Node.js:

```bash
# Limit max memory
export NODE_OPTIONS="--max-old-space-size=512"
npm start
```

Or in the systemd service:

```ini
Environment="NODE_OPTIONS=--max-old-space-size=512"
```

## Troubleshooting

### Service won't start

```bash
# Check logs
sudo journalctl -u voice-chat.service -n 50

# Check syntax of service file
systemd-analyze verify /etc/systemd/system/voice-chat.service

# Restart after changes
sudo systemctl daemon-reload
sudo systemctl restart voice-chat.service
```

### Can't connect from other devices

```bash
# Test server is running
curl http://localhost:3000

# Check firewall
sudo ufw status
sudo ufw allow 3000  # If needed

# Check if port is open
sudo netstat -tulpn | grep 3000
```

### High CPU usage

- Reduce audio bitrate in `.env` (future version)
- Limit number of concurrent users to 5-8
- Use Pi 4 with active cooling

### Audio issues

- Ensure USB audio device (Pi doesn't have audio in by default)
- Test with external USB microphone:

```bash
arecord -l  # List devices
arecord -D plughw:1,0 -d 5 test.wav  # Record 5 seconds
```

## Auto-Restart on Reboot

The systemd service automatically starts on boot. Verify:

```bash
sudo systemctl is-enabled voice-chat.service  # Should be enabled
```

## Update the App

```bash
cd ~/voice-chat-room
git pull  # Or manually download latest
npm install
sudo systemctl restart voice-chat.service
```

## Backup Configuration

```bash
# Backup .env file
cp .env .env.backup

# Backup all files
tar -czf voice-chat-backup-$(date +%Y%m%d).tar.gz ~/voice-chat-room/
```

## Performance Tips

1. **Use wired Ethernet** — More stable than Wi-Fi
2. **Thermal paste** — Add to Pi CPU for better cooling
3. **Active cooling** — Use fan case (Pi 4+)
4. **Limit users** — 8-10 max for Pi 4
5. **Monitor temps** — `vcgencmd measure_temp`

## Security Checklist

- [ ] Change SSH password: `passwd`
- [ ] Use strong room password
- [ ] Enable UFW firewall: `sudo ufw enable`
- [ ] Only open port 3000: `sudo ufw allow 3000`
- [ ] Use HTTPS (Cloudflare Tunnel does this)
- [ ] Regular updates: `sudo apt update && sudo apt upgrade`

---

Your voice chat server is now running 24/7 on your Raspberry Pi! 🎤🍓
