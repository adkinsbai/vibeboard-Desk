# VibeBoard Agent Acceptance

This checklist validates the Agent rewrite when the Taishan board is not connected.
It separates offline L0-L3 acceptance from the later L4 real-board golden loop.

## Current Acceptance Scope

- L0 contract checks: generated files, required runtime hooks, relative assets.
- L1 syntax checks: `node --check app.js` and `python -m py_compile hardware_app.py`.
- L2 hardware simulation: `hardware_app.py` runs locally and emits JSON with `build_id`, `runtime`, and `available_apis`.
- L3 render verification: local HTTP render at `480x360`, no blank screen, no overflow, no console/page/network errors.
- Offline hardware handling: board deploy and golden loop return explicit `skipped` results instead of pretending real deploy succeeded.

## Commands

Run from `C:\tmp\vibeboard-linux-prototype`.

```powershell
npm run check
npm run verify:agent
```

Start or restart the local service:

```powershell
$conn = Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pidValue in $pids) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
}
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList 'server.mjs' -WorkingDirectory 'C:\tmp\vibeboard-linux-prototype'
```

Then run:

```powershell
npm run verify:offline
```

Expected result:

- `npm run check`: exits 0.
- `npm run verify:agent`: `10 passed, 0 skipped, 0 failed`.
- `npm run verify:offline`: JSON output with `"ok": true`, `"deployMode": "offline-simulated"`, and `"verifyMode": "offline-simulated"`.

## Manual UI Smoke

Open:

```text
http://127.0.0.1:8789
```

Steps:

1. Enter a prompt such as `Build an ASCII system dashboard for the 480x360 VibeBoard screen`.
2. Click `生成 / 编译 / 写入硬件`.
3. Confirm the app generates without model credentials through template fallback.
4. Expand `Verification Evidence`.
5. Confirm it shows `L0-L3 local verification passed`.
6. Click deploy only if needed; without hardware it should show `Hardware deploy skipped`, not real deploy success.

## API Checks

```powershell
Invoke-RestMethod http://127.0.0.1:8789/api/status
Invoke-RestMethod http://127.0.0.1:8789/api/verify
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' http://127.0.0.1:8789/api/deploy
```

Offline expectations:

- `/api/status` includes `mode: offline-simulated`, `connected: false`, `skipped: true`.
- `/api/verify` includes `skipped: true` and `goldenLoop.mode: offline-simulated`.
- `/api/deploy` returns HTTP 200 with `skipped: true`, `deployed: false`, `buildEvidence.ok: true`.

## L4 Real Board Acceptance

Run this only after SSH/FRP credentials and the Taishan board route are restored.

1. Confirm `/api/status` returns `connected: true` and `mode: real`.
2. Generate a fresh app from the UI.
3. Call `/api/deploy`.
4. Call `/api/verify?id=<build_id>`.
5. Require `goldenLoop.ok: true`.

L4 checks must pass:

- Board program executed and `hardware-result.json` contains the matching `build_id`.
- Board HTTP app build id matches the generated build id.
- Static deployed files have the same build id.
- `taishan-screen.service` is active.
- Display geometry is `480x360`.
- Kiosk process uses `--window-size=480,360` and `--force-device-scale-factor=1`.

Do not mark L4 passed from offline mode.
