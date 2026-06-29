# Weave

A self-hosted voice chat application built on [mediasoup](https://mediasoup.org/), an open-source WebRTC SFU (Selective Forwarding Unit). Discord-like voice rooms, private channels, text chat, and screen share — running entirely on your own hardware.

---

## Features

- Voice rooms with full channel isolation — users only hear people in their channel
- Private invite-only ephemeral channels — created on demand, self-destruct when empty
- Text chat with image uploads, link previews, and paginated message history
- Screen share with audio
- Per-user volume controls, noise gate, and mic processing toggles
- Invite-only registration — no open sign-ups, no email required
- SQLite-backed user auth (login, password reset, admin panel)
- Bug report submission
- Admin DB console

---

## Stack

| Layer | Technology |
|---|---|
| Application | Node.js (ES modules) |
| Media server | mediasoup SFU |
| Signalling | WebSocket |
| Database | SQLite via better-sqlite3 |
| Frontend | Vanilla JS / HTML / CSS |
| Container runtime | Docker + Docker Compose |

---

## Table of Contents

- [Quick-Start Checklist](#quick-start-checklist)
- [Step 1 — Install prerequisites](#step-1--install-prerequisites)
- [Step 2 — Forward router ports (UDP)](#step-2--forward-router-ports-udp)
- [Step 3 — Set up a public hostname](#step-3--set-up-a-public-hostname)
- [Step 4 — Clone the repository](#step-4--clone-the-repository)
- [Step 5 — Configure .env](#step-5--configure-env)
- [Step 6 — Optional: Cloudflare Tunnel](#step-6--optional-cloudflare-tunnel)
- [Step 7 — Start Weave](#step-7--start-weave)
- [Step 8 — Create the first admin user](#step-8--create-the-first-admin-user)
- [Updating Weave](#updating-weave)
- [Troubleshooting](#troubleshooting)

---

## Quick-Start Checklist

Use this as your progress tracker. Each item maps to a numbered step below.

- [ ] Git installed
- [ ] Docker installed and running
- [ ] Router UDP ports 10000–10100 forwarded to this server's LAN IP
- [ ] Public hostname or IP decided (`ANNOUNCED_IP`)
- [ ] Repository cloned
- [ ] `.env` file created and filled in
- [ ] `logs/` directory created
- [ ] (Optional) Cloudflare Tunnel token obtained and set
- [ ] `docker compose up -d` ran successfully
- [ ] First admin user created via bootstrap script
- [ ] Logged in and confirmed working

---

## Step 1 — Install prerequisites

### Git

**Windows:** Download and run the installer from [git-scm.com/downloads](https://git-scm.com/downloads). Accept all defaults.

**Linux / Raspberry Pi:**
```bash
sudo apt update && sudo apt install -y git
```

Verify:
```bash
git --version
```

---

### Docker

**Windows / Mac:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). It includes Docker Engine and Compose. After installation, start Docker Desktop and confirm the whale icon appears in your system tray before proceeding.

**Linux / Raspberry Pi:** Use the official install script. Do **not** use `apt install docker.io` — that package is often severely outdated.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Then install the Compose plugin:
```bash
sudo apt install -y docker-compose-plugin
```

Verify both are working:
```bash
docker --version
docker compose version
```

> **Raspberry Pi:** Weave has been tested on a Pi 5 running Raspberry Pi OS (64-bit). Docker Engine 24+ and Compose v2+ are required — the script above installs the latest.

---

## Step 2 — Forward router ports (UDP)

mediasoup handles all WebRTC media server-side. When users speak or share audio, their browser sends UDP packets directly to your server — this traffic does **not** go through Cloudflare or any other proxy. Without port forwarding, remote users will be unable to hear anyone.

You need to forward this port range on your router:

| Protocol | External port range | Internal port range | Destination |
|---|---|---|---|
| **UDP** | 10000–10100 | 10000–10100 | Your server's LAN IP |

**How to find your server's LAN IP:**

Linux / Raspberry Pi:
```bash
hostname -I | awk '{print $1}'
```

Windows:
```
ipconfig
```
Look for `IPv4 Address` under your active adapter (e.g. `192.168.1.50`).

**How to set up the rule:** Every router admin panel is different. Go to [portforward.com](https://portforward.com), search for your router model, and follow the guide for UDP port ranges. The rule type is typically called "Port Forwarding" or "Virtual Server".

> If you change `RTC_MIN_PORT` or `RTC_MAX_PORT` in `.env`, update the router rule to match.

---

## Step 3 — Set up a public hostname

mediasoup needs to tell clients where to send WebRTC packets. You configure this as `ANNOUNCED_IP` in `.env`. It must be reachable from the public internet.

**Option A — Static public IP**

If your ISP provides a static public IP, use it directly:
```
ANNOUNCED_IP=89.x.x.x
```

**Option B — Dynamic IP (most home connections)**

Use a free dynamic DNS (DDNS) service. [DuckDNS](https://www.duckdns.org) is recommended:

1. Create a free account at [duckdns.org](https://www.duckdns.org)
2. Create a subdomain (e.g. `my-weave.duckdns.org`)
3. Follow the [DuckDNS install guide](https://www.duckdns.org/install.jsp) to set up a cron job or scheduled task that keeps your domain pointed at your current IP
4. Set your domain as `ANNOUNCED_IP`:
```
ANNOUNCED_IP=my-weave.duckdns.org
```

---

## Step 4 — Clone the repository

**Linux / Raspberry Pi / Mac:**
```bash
git clone https://github.com/CodeineZA/Weave.git
cd Weave
```

**Windows (Command Prompt or PowerShell):**
```
git clone https://github.com/CodeineZA/Weave.git
cd Weave
```

---

## Step 5 — Configure `.env`

Copy the template to create your environment file:

**Linux / Raspberry Pi / Mac:**
```bash
cp .env.example .env
```

**Windows (Command Prompt):**
```
copy .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Open `.env` in any text editor and fill in your values:

| Variable | Required | Description | Example |
|---|---|---|---|
| `ANNOUNCED_IP` | **Yes** | Your public hostname or IP for WebRTC ICE candidates | `my-weave.duckdns.org` |
| `LOCAL_ANNOUNCED_IP` | No | Your server's LAN IP — advertised as a 2nd ICE candidate for same-network clients. Leave blank if not needed. | `192.168.1.50` |
| `RTC_MIN_PORT` | **Yes** | Start of the UDP port range. Must match your router rule. Default: `10000` | `10000` |
| `RTC_MAX_PORT` | **Yes** | End of the UDP port range. Default: `10100` | `10100` |
| `HTTP_PORT` | **Yes** | Host port that maps to Weave's web server. Default: `3000` | `3000` |
| `WEAVE_TUNNEL_TOKEN` | Tunnel only | Cloudflare tunnel connector token. Only needed if using `docker-compose.tunnel.yml`. | *(see Step 6)* |

Create the logs directory that Weave writes to:

**Linux / Raspberry Pi / Mac:**
```bash
mkdir -p logs
```

**Windows:**
```
mkdir logs
```

---

## Step 6 — Optional: Cloudflare Tunnel

### What it is

A Cloudflare Tunnel lets your server reach the internet without opening any inbound TCP port on your router. Cloudflare handles HTTPS and WebSocket (WSS) termination. Users connect to `https://weave.yourdomain.com`; Cloudflare forwards the traffic to your local server.

### What this project uses

A `cloudflared` Docker container runs alongside Weave and maintains the tunnel connection. This is defined in `docker-compose.tunnel.yml` and is opt-in — the main `docker-compose.yml` does not include it.

> **Important:** Even with the tunnel, WebRTC UDP ports (10000–10100) still need to be forwarded on your router. The tunnel only carries the HTTP/WebSocket signalling — media bypasses it entirely.

### Setting it up

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. Add your domain to Cloudflare (or use an existing Cloudflare-managed domain)
3. Go to the [Zero Trust dashboard](https://one.dash.cloudflare.com) → Networks → Tunnels → **Create a tunnel**
4. Choose **Cloudflared** as the connector type
5. Name the tunnel (e.g. `weave-tunnel`) and click Save
6. Copy the tunnel token shown — paste it as `WEAVE_TUNNEL_TOKEN` in your `.env`
7. In the tunnel's **Public Hostname** settings, add a route:
   - Subdomain: `weave` (or whatever you want)
   - Domain: your domain
   - Service: `http://weave-voice:3000`

### Starting with the tunnel

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

### Starting without the tunnel

```bash
docker compose up -d
```

Without the tunnel, Weave is accessible at `http://<server-ip>:3000`. TCP port 3000 must be reachable from your clients (add a router forwarding rule if accessing from outside your LAN).

---

## Step 7 — Start Weave

The first startup builds the Docker image from source. This takes 2–5 minutes depending on your hardware.

**Without Cloudflare Tunnel:**
```bash
docker compose up -d
```

**With Cloudflare Tunnel:**
```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

Confirm the container is running:
```bash
docker ps
```

Watch the logs and wait for `SFU_READY` (press `Ctrl+C` to stop following — the container keeps running):
```bash
docker logs weave-voice --tail 50 -f
```

**Access Weave:**
- Same machine: [http://localhost:3000](http://localhost:3000)
- Another device on your LAN: `http://<server-lan-ip>:3000`
- Via Cloudflare Tunnel: the public hostname you configured

---

## Step 8 — Create the first admin user

Registration in Weave is invite-only. Invite codes are generated by logged-in users — which creates a problem on first boot: no users exist, so no codes can be generated, so no one can register.

The solution is to bootstrap the first admin user directly inside the container.

**Step 8a — Create the bootstrap script**

Create a file called `bootstrap_admin.mjs` in the repository directory and fill in your own values:

```js
import { createUser } from '/app/db.js';
import Database from 'better-sqlite3';

const r = createUser({
  full_name:      'YourFullName',       // login name (used at the login screen)
  nick_name:      'YourNick',           // display name shown to others
  password:       'YourPassword',       // login password
  profile_picture: '🎯',               // any single emoji
  secret_phrase:  'A phrase only you know'  // used for password recovery
});

if (!r.ok) {
  console.error('Failed to create user:', r.error);
  process.exit(1);
}

const raw = new Database('/app/data/weave.db');
raw.prepare('UPDATE weave_users SET is_admin=1 WHERE id=?').run(r.id);
raw.close();

console.log('Admin user created successfully. ID:', r.id);
console.log('You can now log in with your full_name and password.');
```

**Step 8b — Run it inside the container**

**Linux / Raspberry Pi / Mac:**
```bash
docker cp bootstrap_admin.mjs weave-voice:/tmp/bootstrap_admin.mjs
docker exec -it weave-voice node /tmp/bootstrap_admin.mjs
rm bootstrap_admin.mjs
```

**Windows (PowerShell):**
```powershell
docker cp bootstrap_admin.mjs weave-voice:/tmp/bootstrap_admin.mjs
docker exec -it weave-voice node /tmp/bootstrap_admin.mjs
Remove-Item bootstrap_admin.mjs
```

You should see `Admin user created successfully.`

**Step 8c — Log in and invite others**

Open Weave in your browser, log in with the `full_name` and `password` you set, and use the **Invite a Friend** panel to generate invite codes for other users.

---

## Updating Weave

Pull the latest changes and rebuild:

**Linux / Raspberry Pi / Mac:**
```bash
git pull
docker compose build
docker compose down
docker compose up -d
```

**Windows:**
```
git pull
docker compose build
docker compose down
docker compose up -d
```

User data, messages, and uploaded files are stored in a named Docker volume (`weave_data`) and persist across rebuilds and restarts. `docker compose down` does **not** delete volumes — only `docker compose down -v` does (do not run this unless you intend to wipe all data).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No audio in voice channels | UDP ports not forwarded | Confirm your router forwards UDP 10000–10100 to this server's LAN IP |
| Voice connects but audio drops / ICE failure | `ANNOUNCED_IP` unreachable | Verify the domain/IP resolves to your server's public IP and the UDP range is open |
| Page won't load at all | TCP 3000 blocked, or tunnel misconfigured | Without tunnel: confirm TCP 3000 is reachable. With tunnel: `docker logs weave-cloudflared` |
| Container exits immediately on start | Config error or port conflict | `docker logs weave-voice` — read the error message |
| `docker compose up` fails with "port already in use" | Another process uses port 3000 or the RTC range | Change `HTTP_PORT` in `.env`, or stop the conflicting service |
| "Name already taken" on rejoin after network drop | Reconnect race condition | Wait a few seconds and rejoin — the server clears stale sessions automatically |
| First login fails after restart | Expected — sessions survive restarts, but if data was wiped: re-run the bootstrap script | Check that the `weave_data` volume still exists: `docker volume ls` |
