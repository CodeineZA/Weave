# Weave — Claude Code Setup Instructions

This file contains step-by-step instructions for a Claude Code instance to perform a complete first-time setup of Weave on a new machine. When the user asks you to set up Weave (or says anything equivalent like "install this", "get this running", "help me set this up"), read this file in full and execute the phases below in order.

Do not skip phases. Do not assume a phase is complete without verifying it. Ask the user for input wherever indicated — do not guess or use placeholder values.

---

## Context

Weave is a self-hosted voice chat application. It runs as a Docker container. The setup involves:
1. Verifying prerequisites (Git, Docker)
2. Collecting the user's environment values and writing `.env`
3. Creating a required `logs/` directory
4. Explaining the router port forwarding step (you cannot do this — the user must do it)
5. Optionally configuring a Cloudflare Tunnel
6. Starting the containers with `docker compose`
7. Bootstrapping the first admin user inside the container
8. Verifying the app is accessible

---

## Phase 1 — Check prerequisites

Run the following checks and report the results to the user before proceeding.

**Check Git:**
```bash
git --version
```

**Check Docker:**
```bash
docker --version
docker compose version
```

**Check Docker is running:**
```bash
docker info
```

If any of these fail:
- Git not installed → direct the user to https://git-scm.com/downloads (Windows) or `sudo apt install git` (Linux/Pi)
- Docker not installed → direct the user to https://www.docker.com/products/docker-desktop/ (Windows/Mac) or `curl -fsSL https://get.docker.com | sh` (Linux/Pi)
- Docker not running → ask the user to start Docker Desktop (Windows/Mac) or run `sudo systemctl start docker` (Linux)

Do not proceed until all three checks pass.

---

## Phase 2 — Collect environment values

Ask the user the following questions. Collect all answers before writing the `.env` file.

Ask these questions using AskUserQuestion where possible, or by asking them one at a time in conversation:

1. **ANNOUNCED_IP** — "What is your server's public hostname or IP address? This is what remote clients use to connect for voice. If your IP changes (most home connections), use a DuckDNS domain (free at https://www.duckdns.org). Example: `my-weave.duckdns.org` or `89.x.x.x`"

2. **LOCAL_ANNOUNCED_IP** — "What is your server's LAN IP address? (Optional — leave blank if you don't need same-network clients to connect directly.) Run `hostname -I` on Linux or `ipconfig` on Windows to find it. Example: `192.168.1.50`"

3. **HTTP_PORT** — "Which host port should Weave's web interface use? Default is `3000`. Change this if port 3000 is already in use on this machine."

4. **RTC_MIN_PORT / RTC_MAX_PORT** — "What UDP port range should mediasoup use? Default is 10000–10100. Only change this if those ports are already in use. You will need to forward this range on your router regardless."

5. **WEAVE_TUNNEL_TOKEN** — "Are you using a Cloudflare Tunnel? If yes, paste your tunnel token here. If no, leave this blank. (See README Step 6 for how to create a tunnel.)"

Once you have all values, write `.env`:

**Linux / Mac / Pi:**
```bash
cp .env.example .env
```

**Windows:**
```
copy .env.example .env
```

Then edit `.env` to fill in the collected values. Use the Edit tool to replace the placeholder values with the user's answers.

---

## Phase 3 — Create required directories

Weave mounts a `logs/` directory from the host. Create it:

**Linux / Mac / Pi:**
```bash
mkdir -p logs
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force logs
```

Confirm the directory exists before continuing.

---

## Phase 4 — Router port forwarding (user action required)

You cannot do this step — the user must log into their router admin panel. Present the following block clearly and ask the user to confirm when done:

---

**Action required: Forward UDP ports on your router**

You must add a port forwarding rule in your router's admin panel before Weave's voice will work.

| Protocol | External port range | Internal port range | Destination |
|---|---|---|---|
| UDP | `{RTC_MIN_PORT}`–`{RTC_MAX_PORT}` | `{RTC_MIN_PORT}`–`{RTC_MAX_PORT}` | `{LOCAL_ANNOUNCED_IP or server LAN IP}` |

(Replace the values above with the ports and IP from your `.env`.)

To find your router admin panel: open a browser and go to `http://192.168.1.1` or `http://192.168.0.1` (common defaults). Log in with your router's admin credentials. Look for "Port Forwarding", "Virtual Server", or "NAT" in the settings.

For router-specific guides: https://portforward.com

---

Ask the user: "Have you added the UDP port forwarding rule on your router? Type yes to continue."

Do not proceed until the user confirms.

---

## Phase 5 — Start Weave

If `WEAVE_TUNNEL_TOKEN` is set, use the tunnel override. Otherwise use the standard compose file.

**Without tunnel:**
```bash
docker compose up -d
```

**With tunnel:**
```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

The first run builds the Docker image from source. This takes 2–5 minutes. After running the command, tail the logs and wait for `SFU_READY`:

```bash
docker logs weave-voice --tail 50 -f
```

Once you see `SFU_READY`, press Ctrl+C and continue.

If the container exits immediately, run `docker logs weave-voice` and report the error to the user.

---

## Phase 6 — Bootstrap the first admin user

Registration in Weave is invite-only. No one can register without an invite code, and no invite code can be generated without an existing user. This phase creates the first admin user directly inside the container.

Ask the user for the following values:

1. **full_name** — "Choose a login name. This is what you'll type at the login screen. Example: `Alice`"
2. **nick_name** — "Choose a display name shown to other users in the app. Example: `alice`"
3. **password** — "Choose a strong password for your account."
4. **profile_picture** — "Choose a single emoji for your avatar. Example: 🎯 🌊 🔥 🎭 🐉"
5. **secret_phrase** — "Choose a secret phrase used for password recovery. This is like a security question answer. Example: `my first dog was called rex`"

Once you have the values, create the bootstrap script. Write this file to the repository directory as `bootstrap_admin.mjs`, substituting the user's values:

```js
import { createUser } from '/app/db.js';
import Database from 'better-sqlite3';

const r = createUser({
  full_name:      'PLACEHOLDER_FULL_NAME',
  nick_name:      'PLACEHOLDER_NICK_NAME',
  password:       'PLACEHOLDER_PASSWORD',
  profile_picture: 'PLACEHOLDER_EMOJI',
  secret_phrase:  'PLACEHOLDER_SECRET'
});

if (!r.ok) {
  console.error('Failed to create user:', r.error);
  process.exit(1);
}

const raw = new Database('/app/data/weave.db');
raw.prepare('UPDATE weave_users SET is_admin=1 WHERE id=?').run(r.id);
raw.close();

console.log('Admin user created. ID:', r.id);
```

Copy it into the container and run it:

```bash
docker cp bootstrap_admin.mjs weave-voice:/tmp/bootstrap_admin.mjs
docker exec -it weave-voice node /tmp/bootstrap_admin.mjs
```

If the output shows `Admin user created.`, delete the script:

**Linux / Mac / Pi:**
```bash
rm bootstrap_admin.mjs
```

**Windows:**
```powershell
Remove-Item bootstrap_admin.mjs
```

If it fails, report the error message to the user.

---

## Phase 7 — Verify

Tell the user to open Weave in their browser:
- Same machine: http://localhost:{HTTP_PORT}
- Another device on the LAN: `http://{LOCAL_ANNOUNCED_IP}:{HTTP_PORT}`
- Via Cloudflare Tunnel: the hostname configured in the tunnel dashboard

Ask them to log in with the `full_name` and `password` from Phase 6 and confirm they can see the app.

---

## Phase 8 — Done

Summarise what was set up:
- Weave is running at [URL]
- Admin user: `{full_name}` / `{nick_name}`
- Data is stored in Docker volume `weave_data` and persists across restarts

Remind the user:
- To update Weave: `git pull && docker compose build && docker compose down && docker compose up -d`
- To invite other users: log in, click the brand menu, and use **Invite a Friend** to generate an invite code
- The `logs/` directory on this machine contains server logs
- Do not run `docker compose down -v` — that wipes all user data
