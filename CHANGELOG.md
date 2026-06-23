# Changelog

## 2026-06-23 - Hardware Agent, Market, Digital Life, and Gray Board Release

### Highlights

- Added a unified Agent workflow for chat, clarification, project memory, generated file snapshots, local verification, and deploy confirmation.
- Split generation/build/deploy responsibilities into focused runtime modules under `src/`, including build, generate, preview, market, registry, and hardware-contract helpers.
- Added strict hardware contracts for generated apps: fixed 480x360 screen rules, relative assets, required runtime APIs, `hardware_app.py`, `manifest.json`, and `hardware-result.json`.
- Added persistent conversation snapshots so page refreshes restore the latest conversation, generated files, and active device preview.
- Changed empty device preview behavior to a pure black screen instead of a white iframe.
- Added a standalone Digital Life Companion at `/digital-life.html` with local-first state, memory, affect, cognition, autonomy, presence, speech/audio hooks, and smoke tests.
- Expanded the Application Market with curated static apps, previews, generated asset bundles, binary asset handling, publish flow, and deploy-from-market runtime.
- Fixed Taishan Gray deployment by defaulting `taishan-gray` to the deployable `linaro` account.
- Fixed Windows real-board deployment upload by sending bundle payloads through stdin instead of an overlong SSH command line.
- Improved Golden Loop verification so board HTTP build-id checks inspect `/`, `/index.html`, `/app.js`, and `/manifest.json`.
- Improved Agent UX so clarification uses structured `quick_replies` choice buttons, typed confirmations can start the pending build, and deploy intent such as "帮我部署吧" shows a deploy confirmation button for the current verified build instead of re-entering open-ended planning.
- Added the first Asset Library slice: users can upload mixed files from the chat composer, the server stores and analyzes them per conversation, safely expands supported `.zip` bundles into individual analyzed assets, and Agent planning/build prompts receive a bounded hardware-focused asset summary.
- Added an Agent implementation selector for self-developed VibeBoard Agent versus Codex hardware mode, with Codex mode constrained to embedded 480x360 hardware app design/generation/verification/deploy-confirmation and exposed through a backend `mode_boundary` contract.

### Gray Board Validation

The latest real-board deployment was verified on Taishan Gray:

- Device: `taishan-gray`
- Route: `frp:150.158.146.192:6278`
- User: `linaro`
- Build: `vb-mqqmu8pt-d296c7`
- Board hostname: `taishan-gray`
- Board IP: `172.20.10.14`
- Service: `taishan-screen.service` active
- Display geometry: `480x360`
- Kiosk flags: `--window-size=480,360` and `--force-device-scale-factor=1`
- Verification: `/api/verify?id=vb-mqqmu8pt-d296c7&deviceId=taishan-gray` returned `goldenLoop.ok: true`

### Verification

Run:

```powershell
npm run check
npm run verify:agent
npm run verify:offline
npm run verify:digital-life
```

Known local note: in restricted Windows sandbox contexts, some tests that spawn Python or Playwright may fail with `spawn EPERM`. The syntax check and the gray-board profile regression test pass in the current workspace, and the real-board Golden Loop passed on the live gray board.
