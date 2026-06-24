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
- Added the first Asset Library slice: users can upload mixed files from the chat composer, the server stores and analyzes them per conversation, safely expands supported `.zip`, `.tar`, `.tgz`, and `.gz` bundles into individual analyzed assets, and Agent planning/build prompts receive a bounded hardware-focused asset summary plus an inferred product design brief.
- Embedded contract-safe passive Asset Library files into generated builds under `assets/uploaded/`, with automatic `manifest.json` declarations so uploaded images/audio/fonts/JSON/WebM assets survive preview, conversation snapshots, market publishing, and deployment while active HTML/CSS/JS remains reference-only.
- Expanded Asset Library intelligence so uploaded bundles now expose palette cues, component structure, CTA copy, data fields, interaction hints, and media plans to Agent prompts and the Assets UI summary.
- Added lightweight media profiling for Asset Library uploads, including image dimensions/aspect, WAV duration/sample rate, basic audio/video container hints, and media-profile lines in Agent context and the Assets UI.
- Added Asset Library product inference so uploaded bundles now produce product-intent, layout-plan, and completion-gap guidance, helping Agent/Codex modes use sensible defaults instead of repeatedly asking how to use obvious assets.
- Added lightweight document profiling for uploaded `.pdf`, `.docx`, `.pptx`, `.xlsx`, and related office files so Agent/Codex modes can use extracted text, slide/storyboard hints, and spreadsheet fields as hardware UI design references.
- Added lightweight design-source profiling for uploaded `.fig`, `.sketch`, `.psd`, `.ai`, `.xd`, design-token, and related files so Agent/Codex modes can use palette, component, spacing, and visual hierarchy cues without embedding proprietary design files.
- Added structured generation failure diagnostics and concurrency protection: `/api/generate`, `/api/agent` confirmed builds, uploads, publishing, and deploy failures now expose actionable `errorType`, `errorStage`, `userMessage`, `suggestion`, `nextActions`, and `technicalDetail`; overlapping generation requests return `409 generate_busy`; missing-model chat now returns Chinese quick-reply choices; `npm run smoke:generation` exercises random direct generation, Agent-confirmed generation, refresh-style preview restore, empty-prompt diagnostics, and concurrent task starts.
- Added model-driven pre-deploy auto-repair: after Agent generation, local L0-L3 validation failures are fed back to the configured DeepSeek/OpenAI-compatible model with the current files and hardware contract, retried up to `VIBEBOARD_AGENT_REPAIR_ATTEMPTS` times before asking the user; model auth/quota/network, asset, storage, and other user-actionable failures still stop with explicit guidance.
- Added an Agent implementation selector for self-developed VibeBoard Agent versus Codex hardware mode, with Codex mode routed through a dedicated `codex-hardware-agent` bridge, constrained by a code-level scope guard to embedded 480x360 hardware app design/generation/verification/deploy-confirmation, and exposed through backend `mode_boundary` plus `codex_bridge` contracts.
- Strengthened confirmed Codex builds with a Codex hardware execution package that preserves the raw user request while injecting hardware scope, Asset Library usage rules, contract-safe file requirements, local verification gates, and the no-auto-deploy boundary into generation.
- Surfaced Codex bridge status, scope-guard warnings, and inferred Assets design-brief priorities directly in the chat UI so users can see what the Agent understood and why a request was redirected.

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
npm run smoke:generation
npm run verify:digital-life
```

Known local note: in restricted Windows sandbox contexts, some tests that spawn Python or Playwright may fail with `spawn EPERM`. The syntax check and the gray-board profile regression test pass in the current workspace, and the real-board Golden Loop passed on the live gray board.
