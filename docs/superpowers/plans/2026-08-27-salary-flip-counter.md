# Salary Flip Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a locally verified and gray-board-deployed 480x360 salary counter with calendar and mechanical flip animations.

**Architecture:** Keep the feature as a self-contained market app. Put deterministic salary math in a small ES module shared by the browser and Node tests, keep visual state in `app.js`, and use a generated bitmap only as an optional background layer. Reuse the repository's immutable hardware contract and deploy only static files.

**Tech Stack:** HTML5, CSS3 3D transforms, browser JavaScript modules, Node.js tests, Playwright, Python SSH deployment helpers already present in the repository.

## Global Constraints

- Display size is exactly 480x360.
- Workday is local time 09:00-18:00 at CNY 1,000 per hour.
- Main display is integer flip cards; precise amount is a smaller two-decimal line.
- No external browser dependency and no hardware capabilities.
- Do not modify the behavior of `hardware_app.py`.

---

### Task 1: Deterministic salary model

**Files:**
- Create: `market-apps/vb-salary-flip-counter/salary-logic.js`
- Create: `tests/salary-flip-counter.mjs`

**Interfaces:**
- Produces: `salarySnapshot(now: Date, options?: { startHour, endHour, hourlyRate })` returning amount, progress, phase, and totals.

- [ ] Write boundary tests for 08:59, 09:00, 13:30, 18:00, and after 18:00.
- [ ] Run `node tests/salary-flip-counter.mjs` and confirm it fails because the module is absent.
- [ ] Implement the clamped local-time calculation without reading network time.
- [ ] Re-run the test and confirm all cases pass.

### Task 2: 480x360 flip-counter application

**Files:**
- Create: `market-apps/vb-salary-flip-counter/index.html`
- Create: `market-apps/vb-salary-flip-counter/style.css`
- Create: `market-apps/vb-salary-flip-counter/app.js`
- Create: `market-apps/vb-salary-flip-counter/manifest.json`
- Create: `market-apps/vb-salary-flip-counter/hardware_app.py`

**Interfaces:**
- Consumes: `salarySnapshot()` from Task 1.
- Produces: a static application bootable from `index.html` with no external requests.

- [ ] Build semantic header, four stable digit slots, precise amount, progress rail, and status region.
- [ ] Implement independent top/bottom flap transitions and carry-safe digit updates.
- [ ] Implement load/day-change calendar page turn and a reduced-motion fallback.
- [ ] Add the system-owned no-capability hardware contract and application manifest.

### Task 3: Background asset and visual verification

**Files:**
- Create: `market-apps/vb-salary-flip-counter/assets/scoreboard-metal.png`
- Create: `market-apps/vb-salary-flip-counter/preview.png`
- Create: `market-apps/vb-salary-flip-counter/preview-report.json`

**Interfaces:**
- Consumes: static app from Task 2.
- Produces: deployable decorative asset and visual evidence at 480x360.

- [ ] Generate a text-free matte black scoreboard texture with GPT Image 2 and copy it into the app.
- [ ] Start a local static server and capture a Playwright screenshot at 480x360 using a deterministic midday clock.
- [ ] Assert the page has no overflow, key values fit, and the screenshot contains non-black content.
- [ ] Inspect the screenshot and correct any clipping or overlap.

### Task 4: Platform and board verification

**Files:**
- Modify only if validation finds a defect in the new app files.

**Interfaces:**
- Consumes: completed application package.
- Produces: local check evidence and a deployed board release.

- [ ] Run `node tests/salary-flip-counter.mjs`, `npm run check`, and `npm run verify:context`.
- [ ] Confirm the gray board SSH route is reachable without exposing credentials.
- [ ] Create a timestamped remote backup, upload only the static package, and restart `taishan-screen.service`.
- [ ] Verify service state and fetch the deployed page from the board before reporting completion.

