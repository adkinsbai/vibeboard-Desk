# Gray Board Runbook

Use this runbook when a VibeBoard deployment claims success but the physical gray board does not visibly match the PC preview.

## Fast Triage

1. Check transport:
   - LAN: `Test-NetConnection 192.168.1.49 -Port 22`
   - FRP: `Test-NetConnection 150.158.146.192 -Port 6278`
   - Prefer LAN when both exist.

2. Check board service:
   - `curl -fsS http://127.0.0.1:8765/api/status`
   - `systemctl is-active taishan-screen.service`

3. Check deployed build:
   - `curl -fsS http://127.0.0.1:8765/ | grep -o 'vb-[a-z0-9-]*' | head -1`
   - `grep -o 'vb-[a-z0-9-]*' /home/linaro/workspace/taishan-screen/static/index.html | head -1`

4. Check display geometry:
   - `DISPLAY=:0 XAUTHORITY=/home/linaro/.Xauthority xwininfo -root`
   - Expected: root window `480x360` at `0,0`.

5. Check kiosk process:
   - `pgrep -a chromium | head -10`
   - Expected args include `--window-size=480,360`, `--window-position=0,0`, `--force-device-scale-factor=1`.

## If PC Preview Is Different From Board

- Confirm PC iframe uses `/generated/current/index.html`.
- Confirm generated HTML uses relative `./style.css` and `./app.js`.
- Confirm local `GET /api/status` proxies to the board.
- Compare build ids in local generated HTML and board HTTP HTML.

## If Right Side Is Clipped

- Do not first assume the panel resolution is wrong.
- Re-check X root geometry.
- Kill stale Chromium processes before relaunching kiosk.
- Use a dedicated Chromium profile and fixed window parameters.
- Keep generated CSS fixed at `480px x 360px`, with `overflow: hidden`.

## If SSH Fails

- `Connection refused` on FRP means the tunnel is unavailable; try LAN.
- Public key auth can fail while password auth works.
- Reduce connection count: upload bundle in one connection and execute deploy in one connection.
- Do not rely on `scp` for this MVP if it closes unexpectedly.

