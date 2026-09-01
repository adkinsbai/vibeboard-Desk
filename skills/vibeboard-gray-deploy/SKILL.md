---
name: vibeboard-gray-deploy
description: Use when working on the VibeBoard Linux MVP for the Taishan gray RK3566 board, including generating a 480x360 web app, deploying it into /home/linaro/workspace/taishan-screen/static, restarting the board kiosk, diagnosing FRP/SSH access, fixing right-edge screen clipping, or keeping the PC preview and the small hardware screen consistent.
---

# VibeBoard Gray Deploy

Use this skill as the default operating memory for the VibeBoard gray-board MVP.

## Current Target

- Board id: `taishan-gray`
- Board label: `Taishan Gray`
- OS user: `linaro`
- Local LAN SSH observed earlier: `192.168.1.49:22`
- FRP SSH fallback: `150.158.146.192:6278`
- Wi-Fi observed: `1-306`
- App root: `/home/linaro/workspace/taishan-screen`
- Static deploy target: `/home/linaro/workspace/taishan-screen/static`
- Service: `taishan-screen.service`
- Kiosk URL on board: `http://127.0.0.1:8765/`
- Board status API: `http://127.0.0.1:8765/api/status`
- Screen size: `480x360`

Probe LAN and FRP before deciding the route. LAN IP is mutable; the same gray board has also reported `172.20.10.14` after network changes. Prefer a reachable LAN endpoint when available, but fall back to FRP `150.158.146.192:6278` automatically when the old LAN address times out.

## Product Workspace

The current local prototype lives at:

`C:\tmp\vibeboard-linux-prototype`

Important files:

- `server.mjs`: backend, generation, build check, board status proxy, deploy pipeline.
- `index.html`, `styles.css`, `app.js`: Web MVP UI.
- `runtime/start-kiosk.sh`: board-side Chromium kiosk launcher.
- `generated/current/`: current generated 480x360 app.
- `mvp-gray-final.png`: latest local visual verification screenshot.

Start or restart the local Web MVP:

```powershell
$listeners = Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listeners) {
  if ($conn.OwningProcess -gt 0) { Stop-Process -Id $conn.OwningProcess -Force }
}
$env:VIBEBOARD_BOARD_PASSWORD = "<board-password>"
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'server.mjs' -WorkingDirectory 'C:\tmp\vibeboard-linux-prototype'
```

Open: `http://127.0.0.1:8789/`

Do not store the board password in source code. Pass it through `VIBEBOARD_BOARD_PASSWORD` for local MVP runs.

## Deployment Workflow

1. Generate the app from the chat prompt.
2. Build-check `app.js` with Node syntax validation and write `manifest.json`.
3. Upload `index.html`, `style.css`, `app.js`, and `runtime/start-kiosk.sh`.
4. Copy generated files into `/home/linaro/workspace/taishan-screen/static`.
5. Restart `taishan-screen.service`.
6. Kill existing Chromium processes before kiosk restart.
7. Launch kiosk with `480x360`, `position=0,0`, and `device-scale-factor=1`.
8. Verify local preview, board HTTP, and board file build ids match.

The deployed release is backed up under:

`/home/linaro/workspace/vibeboard-deploy/backups/static-<build-id>`

## Screen Clipping Rule

The gray board display reports exactly `480x360` through X/fbdev. The right-edge clipping problem is not usually an X mode issue. It is most likely caused by Chromium startup state, stale kiosk profile/window placement, or mismatched PC preview markup.

Keep generated screen apps fixed-size:

- `html, body`: `width: 480px; height: 360px; overflow: hidden`
- Main screen root: `width: 480px; height: 360px`
- Avoid viewport-based layout for the deployed app.
- Use relative asset links in generated HTML: `./style.css` and `./app.js`, not `/style.css` or `/app.js`.
- PC preview should iframe the same generated HTML, not redraw a separate simulated DOM.

The kiosk launcher must include:

```sh
--force-device-scale-factor=1 \
--window-position=0,0 \
--window-size=480,360 \
--kiosk http://127.0.0.1:8765/
```

Prefer `/usr/bin/chromium` or `/usr/lib/chromium/chromium-wrapper` over direct `/usr/lib/chromium/chromium-bin`; direct `chromium-bin` can fail to load bundled libraries such as `libc++.so.1`.

## Preview Consistency Rule

The PC Web preview and board screen must render the same generated app.

On PC:

- Right panel iframe source: `/generated/current/index.html`
- Local backend must proxy `/api/status` to the board so the iframe sees the same Wi-Fi/IP/temp/memory data as the board.

On board:

- Static files are served from `/home/linaro/workspace/taishan-screen/static`
- The same generated app fetches `/api/status` from the board service.

Expected final consistency check:

- Local generated id equals board HTTP id.
- Board HTTP id equals board static file id.
- `xwininfo -root` reports `Width: 480` and `Height: 360`.
- Chromium process includes `--window-size=480,360` and `--force-device-scale-factor=1`.

## Verification Commands

Local API status:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8789/api/status' -Method Get -TimeoutSec 60 | ConvertTo-Json -Depth 8
```

Board checks over SSH:

```sh
hostname
curl -fsS http://127.0.0.1:8765/api/status
curl -fsS http://127.0.0.1:8765/ | grep -o 'vb-[a-z0-9-]*' | head -1
grep -o 'vb-[a-z0-9-]*' /home/linaro/workspace/taishan-screen/static/index.html | head -1
DISPLAY=:0 XAUTHORITY=/home/linaro/.Xauthority xwininfo -root | grep -E 'Absolute upper-left|Width|Height'
pgrep -a chromium | head -10
systemctl is-active taishan-screen.service
```

Expected observed values from the working run:

- Build id: `vb-mpwx00rf-314bbe`
- Wi-Fi: `1-306`
- IP: `192.168.1.49`
- Service: `active`
- Kiosk PID from final run: `12474`

Treat these as reference values, not permanent truth; re-check current runtime before reporting status.

## Known Pitfalls

- LAN IP can change; do not assume `192.168.1.49` is current.
- FRP `150.158.146.192:6278` can refuse connections while LAN SSH works, and the reverse can also happen when the board moves networks.
- Platform deployment must use the resolved board config consistently across route probe, upload, remote command execution, status readback, and golden-loop verification. Do not hard-code `BOARD.frpHost` / `BOARD.frpPort` in stdin upload, and do not hard-code `http://127.0.0.1:8765/api/status` in board status checks when `BOARD.statusUrl` is configured.
- Prefer configured/LAN endpoints before FRP fallback when both are present. A cached heartbeat or L0-L3 local verification is not deployability proof; verify SSH route, authentication, target write access, board-side compile/run, service restart, HTTP build id, geometry, and kiosk process separately.
- Bound devices marked `connection.mode: "preview"` must not inherit the default gray-board SSH route. Keep them simulated or return an explicit preview-only deployment message.
- OpenSSH public key over FRP can fail even when Paramiko password auth works.
- Multiple SSH connections in one deployment are brittle through FRP; bundle uploads into fewer connections.
- `scp` may fail with connection-closed behavior; base64/Paramiko upload is more reliable for this MVP.
- Killing Chromium with only TERM may not restart the kiosk; use explicit `pkill -9 chromium-bin` and `pkill -9 chromium` before launching the kiosk.
- Direct `chromium-bin` can fail without its wrapper-managed `LD_LIBRARY_PATH`.
- Absolute generated asset URLs (`/style.css`, `/app.js`) make PC preview load the wrong files from the platform root.
- Without a local `/api/status` proxy, the PC iframe renders the same app but not the same board data.
- Board-side screenshot tools may not be installed; verify with HTTP, X geometry, process args, and PC Playwright screenshots.
