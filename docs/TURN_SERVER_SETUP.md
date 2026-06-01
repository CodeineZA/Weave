# TURN Server Setup Guide

TURN servers are needed when both peers are behind strict NAT/firewalls. This guide covers Coturn, the most popular open-source TURN server.

## When You Need TURN

TURN is required if:
- Users can't hear each other (peers behind corporate firewalls)
- Connection always shows "failed" or "closed" in DevTools
- Using multiple nested networks (VPN + corporate firewall)

STUN alone (included by default) works for most home/office networks.

## Option 1: Coturn on Linux VPS

### Minimal VPS Requirements

- **OS**: Ubuntu 20.04 LTS
- **RAM**: 512 MB
- **CPU**: 1 core
- **Bandwidth**: ~50 GB/month for 8 users

Cost: $3-5/month (DigitalOcean, Linode, Hetzner)

### Installation

```bash
# Install Coturn
sudo apt update
sudo apt install coturn -y

# Create config directory
sudo mkdir -p /etc/coturn
sudo chown -R turnserver:turnserver /etc/coturn
```

### Configuration

Create `/etc/coturn/turnserver.conf`:

```bash
sudo nano /etc/coturn/turnserver.conf
```

Paste:

```ini
# TURN server configuration

# Listen on all interfaces
listening-port=3478
listening-ip=0.0.0.0
relay-ip=YOUR_PUBLIC_IP

# Enable both UDP and TCP
listening-port=3478
listening-port=3479

# Realm (domain for auth)
realm=your-domain.com

# User credentials (add more as needed)
user=voice-chat:yourpassword

# Performance
bps-capacity=0
max-bps=0
max-allocate-lifetime=3600
max-concurrent-client-connections=10000

# Verbosity (info, info, verbose, etc)
log-file=/var/log/coturn/turnserver.log
new-log-file-period=86400
verbose

# Enable fingerprints
fingerprint

# Enable extended TURN security
auth-secret=your-secret-key-here
```

Replace:
- `YOUR_PUBLIC_IP` — Your VPS's public IP
- `yourpassword` — Strong password
- `your-domain.com` — Your domain
- `your-secret-key-here` — Random string (`openssl rand -hex 16`)

### Enable and Start

```bash
# Enable at boot
sudo systemctl enable coturn

# Start service
sudo systemctl start coturn

# Check status
sudo systemctl status coturn

# View logs
sudo tail -f /var/log/coturn/turnserver.log
```

### Firewall Configuration

```bash
# Allow TURN ports (UDP)
sudo ufw allow 3478/udp
sudo ufw allow 3479/udp

# Allow TURN ports (TCP)
sudo ufw allow 3478/tcp
sudo ufw allow 3479/tcp

# Allow SSH
sudo ufw allow 22/tcp

# Enable firewall
sudo ufw enable
```

### Configure Voice Chat App

Update your `.env`:

```env
SERVER_PASSWORD=friends123
PORT=3000
TURN_URL=turn:your-domain.com:3478
TURN_USERNAME=voice-chat
TURN_CREDENTIAL=yourpassword
```

Restart the app:

```bash
sudo systemctl restart voice-chat.service
```

### Test TURN Server

```bash
# Install trickle-ice test
curl -sL https://github.com/pion/webrtc/raw/master/examples/play-from-disk/main.go

# Or use online tool: https://webrtc.github.io/samples/web/content/peerconnection/trickle-ice/
```

## Option 2: TURN on Raspberry Pi (Advanced)

For small deployments on the same Pi:

```bash
# Install
sudo apt install coturn -y

# Edit config (local variant)
sudo nano /etc/coturn/turnserver.conf
```

Use same config as above, but:
- `listening-ip=127.0.0.1` (for local network only)
- Or set to your Pi's static IP

## Option 3: Docker TURN Server

Quick deployment with Docker:

```bash
docker run -d \
  --name coturn \
  -p 3478:3478/udp \
  -p 3478:3478/tcp \
  -p 3479:3478/udp \
  -p 3479:3478/tcp \
  -e TURNSERVER_REALM=your-domain.com \
  -e TURNSERVER_USERNAME=voice-chat \
  -e TURNSERVER_PASSWORD=yourpassword \
  coturn/coturn
```

## Option 4: Public TURN Services (No Setup)

Use a managed TURN service (quick but not free):

### Xirsys (Recommended)

1. Sign up: https://xirsys.com
2. Get credentials from dashboard
3. Update `.env`:

```env
TURN_URL=turn:us1.xirsys.com:443?transport=tcp
TURN_USERNAME=your-xirsys-username
TURN_CREDENTIAL=your-xirsys-password
```

### Google Cloud ICE

Free 5GB/month:

```env
TURN_URL=turn:turn.googlevideo.com:19305?transport=tcp
```

## Monitoring TURN Server

### Check Active Connections

```bash
sudo netstat -tulpn | grep coturn
ss -tulpn | grep 3478
```

### View Performance

```bash
# CPU/Memory
top -p $(pgrep turnserver)

# Bandwidth (if vnstat installed)
vnstat -i eth0
```

### Log Analysis

```bash
# Last 100 lines
sudo tail -100 /var/log/coturn/turnserver.log

# Errors
sudo grep "ERROR\|ERROR" /var/log/coturn/turnserver.log

# Connections
sudo grep "new allocation" /var/log/coturn/turnserver.log | wc -l
```

## Troubleshooting

### TURN Server Not Responding

```bash
# Check if running
sudo systemctl status coturn

# Check listening ports
sudo netstat -ulpn | grep coturn

# Test from another machine
telnet your-server-ip 3478  # Should connect
```

### Authentication Issues

```bash
# Check credentials in config
grep "^user=" /etc/coturn/turnserver.conf

# Restart after config change
sudo systemctl restart coturn
```

### High Memory/CPU

```bash
# Limit connections in config
max-concurrent-client-connections=1000

# Restart
sudo systemctl restart coturn
```

### Firewall Blocking

```bash
# Verify ports are open
sudo ufw status
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw reload
```

## Advanced Configuration

### Multiple Realms (Advanced)

For multiple domains:

```ini
realm=domain1.com
realm=domain2.com

user=domain1:password1
user=domain2:password2
```

### Rate Limiting

Prevent abuse:

```ini
# Max bytes per second per user
user-quota=512000

# Max total bps
bps-capacity=1000000

# Max concurrent connections
max-concurrent-client-connections=100
```

### Statistics

Enable stats reporting:

```ini
# Prometheus metrics (port 9090)
prometheus-ports=9090
```

## Performance Tuning

For 8-10 users:

```ini
# Increase file descriptor limit
# In /etc/security/limits.conf add:
# turnserver soft nofile 100000
# turnserver hard nofile 100000

# Socket send buffer
# In /etc/sysctl.conf add:
# net.core.rmem_max=134217728
# net.core.wmem_max=134217728
```

Then apply:

```bash
sudo sysctl -p
```

## Cost Estimation

| Setup | Bandwidth/mo | Cost/mo | Notes |
|-------|-------------|---------|-------|
| Self-hosted VPS | 50 GB | $3-5 | Cheapest for teams |
| Xirsys | 5-100 GB | $10-20 | Managed, no setup |
| AWS | 100 GB | $20+ | For large scale |
| Free Google | 5 GB | Free | Limited, shared IPs |

## Bandwidth Calculation

Per peer:
- **Audio only**: 40-60 kbps
- **8 users**: ~400 kbps × 8 = ~3.2 Mbps = 12 GB/hour

For **100 hours/month**:
- Audio only: ~1.2 TB outbound (overkill, but realistic)
- TURN relay: 50-100 GB (only when needed)

## Production Checklist

- [ ] TURN server running on public IP
- [ ] Firewall rules allowing ports 3478/3479
- [ ] TLS certificates (optional but recommended)
- [ ] Monitoring enabled (logs, metrics)
- [ ] Rate limiting configured
- [ ] Credentials changed from defaults
- [ ] Backups of config file
- [ ] Tested with actual peers
- [ ] Client `.env` updated with TURN credentials

## Backup and Recovery

```bash
# Backup config
sudo cp /etc/coturn/turnserver.conf ~/turnserver.conf.backup

# Restore
sudo cp ~/turnserver.conf.backup /etc/coturn/turnserver.conf
sudo systemctl restart coturn
```

## Security Best Practices

1. **Change defaults** — Never use example credentials
2. **Rotate passwords** — Update credentials monthly
3. **Monitor logs** — Check for unauthorized access
4. **Firewall** — Only expose needed ports
5. **TLS** — Use TURNS (encrypted) in production
6. **Audit** — Regular security reviews

---

TURN server setup is optional but highly recommended for production deployments. Test with STUN first, add TURN only if needed.
