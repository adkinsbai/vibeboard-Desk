# Changelog

## 2026-06-27 - File Explorer Asset Manager

- Reworked the Asset Library drawer into a Windows File Explorer-style asset manager with a project sidebar, command bar, breadcrumb, system folder grid, and compact file rows.
- Added automatic asset folders for `图片`, `视频`, `音频`, and `其他`; new uploads are classified immediately, and legacy unfiled assets are migrated into the correct folder when the library is opened.
- Added asset-folder APIs for listing, creating, renaming, and deleting custom folders, with protected system folders to keep classification stable.
- Added UI actions for new folder, rename, delete, back, refresh, asset-row usage selection, and folder open/select behavior.
- Added regression coverage for folder classification, legacy migration, folder CRUD, protected system folders, and the Asset Manager UI smoke flow.

## 2026-06-27 - Project Folders, Memory, and Asset Management

- Added named project creation: new conversations can be created with a project title and get a persistent folder under `VIBEBOARD_PROJECTS_DIR` or the default `VibeBoard Projects/` directory.
- Added `src/projectWorkspace.mjs` to manage project folders, `MEMORY.md`, uploaded asset files, build snapshots, project file listing, safe project-file reads, and asset-file renames.
- Wrote project Memory automatically from project creation, chat/Agent activity, asset uploads, generation snapshots, and deploy confirmations.
- Added project and asset APIs: `GET /api/projects/root`, `GET /api/conversations/:id/project-files`, `GET /api/conversations/:id/project-file?path=...`, and `PATCH /api/conversations/:id/assets/:assetId`.
- Expanded Asset Library metadata with usage states and project paths, plus `build_asset_snapshots` records for generated-build usage graphs.
- Added locked project build snapshots under `builds/<build-id>/` with `asset-snapshot.json` for reproducible material traceability.
- Updated the main UI with a named Project creation modal, a Chinese `导入资产` two-step frosted upload modal, drag-and-drop upload, and a left-sidebar `资产管理` drawer for browsing projects/assets, renaming assets, and changing usage.
- Added regression coverage in `verify:agent`, `verify:offline`, and `verify:ui` for project folders, Memory, asset persistence, usage selection, snapshot locking, and the new UI flows.

## 2026-06-27 - Task Center, Background Jobs, and Recoverable Agent Runs

- Added a persisted background job system backed by the existing sql.js database, including job lifecycle state, phase, logs, output, classified error details, cancellation flags, and choice-style next actions.
- Added `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/cancel`, and background mode for `/api/agent`, `/api/generate`, and `/api/deploy` via `background: true`.
- Added a main-dashboard Task Center drawer so running, completed, failed, and canceled jobs remain visible after page refresh; job cards expose button actions such as open result, retry, open model settings, open board status, cancel, and view logs.
- Moved long Agent generation and deploy flows onto background jobs from the UI, so users can switch conversations, create new conversations, and start another task while an earlier task is still running or queued.
- Added runtime tests for job persistence and failure-choice classification, HTTP smoke coverage for background Agent generation and deploy jobs, and UI smoke coverage for the Task Center drawer.

## 2026-06-26 - Non-blocking Chat, Hardware SDK Guard, and Audio Diagnostics

- Kept the main dashboard navigable while an Agent generation is running: conversation selection and "新建" no longer depend on the global running state, and completed builds only update the chat UI if the user is still viewing the originating conversation.
- Renamed the main composer action to "发送" and added Enter-to-send behavior while preserving Shift+Enter for new lines and IME composition safety.
- Added `tests/main-ui-smoke.mjs` plus `npm run verify:ui` to cover main-dashboard navigation during running tasks and keyboard submission.
- Hardened generated-app hardware access by injecting a locked frontend `window.VibeBoardHardware` SDK before build verification, so generated `app.js` can call hardware APIs without replacing the contract implementation.
- Added persistent playbook-backed lessons to generation experience retrieval so prior repair/debug findings can inform future Agent work.
- Improved board microphone diagnostics: `/api/audio/record` now verifies that `arecord` actually stays running, captures `/tmp/vibeboard-audio/arecord.log`, and classifies common failures such as missing recorder, permission denied, busy device, and missing sound input with actionable `errorType`, `userMessage`, and `suggestion` fields.

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
