# Agent Context Routing and Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add risk-aware Agent routing, system-owned hardware contracts, relevance-ranked asset context, and scoped unified project memory retrieval without breaking existing VibeBoard builds.

**Architecture:** Add pure policy/index/retrieval modules first, then connect them through the existing orchestration and generation seams. Keep `project_memory` and `asset_library` as compatibility sources, use derived indexes for search, and make hardware deployment a server-side post-build operation.

**Tech Stack:** Node.js ESM, sql.js/SQLite-compatible SQL, PostgreSQL persistence adapter, existing VibeBoard L0-L3 verifiers, Node `assert` test files.

## Global Constraints

- Preserve public asset and project APIs.
- Hardware contract files are system-owned; the code Agent must not edit `hardware_app.py`.
- Fast routes still execute syntax, render, hardware simulation, and snapshot verification.
- Retrieval must be scoped by organization/project/conversation and return provenance.
- Do not add an external dependency or hosted vector database in this iteration.
- Do not revert unrelated working-tree changes from the checkpoint.
- Every production behavior change gets a failing regression test before implementation.

---

### Task 1: Task Route Policy

**Files:**
- Create: `src/taskRoutePolicy.mjs`
- Create: `tests/task-route-policy.mjs`
- Modify: `src/agentOrchestrator.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `src/agent.mjs`
- Modify: `src/agentRunTelemetry.mjs` if route fields are not already supported

**Interfaces:**
- Produces `scoreTaskRoute(input)`, `classifyTaskRoute(scoreResult)`, and `routeToExecutionProfile(route, scoreResult)`.
- Produces a `task-route.v1` profile with route, score, confidence, reasons, hard gates, turn limits, verification limits, and confirmation requirement.
- `agentOrchestrator` passes the profile into the build request; `generateRuntime` passes it to `runAgent` and telemetry.

- [ ] **Step 1: Write the failing policy tests**

Add assertions for:

```js
import assert from "node:assert/strict";
import { classifyTaskRoute, routeToExecutionProfile, scoreTaskRoute } from "../src/taskRoutePolicy.mjs";

const patch = scoreTaskRoute({ prompt: "把标题改成蓝色", projectFiles: ["index.html", "style.css", "app.js"], action: "confirm_build" });
assert.equal(classifyTaskRoute(patch).route, "fast_patch");

const hardware = scoreTaskRoute({ prompt: "接入麦克风并部署到灰色版", projectFiles: [], action: "confirm_build" });
assert.equal(classifyTaskRoute(hardware).route, "full_agent");
assert(classifyTaskRoute(hardware).hard_gates.includes("hardware_or_deploy"));

const unclear = scoreTaskRoute({ prompt: "把之前那个改好", projectFiles: [], action: "message" });
assert.equal(classifyTaskRoute(unclear).route, "clarify_or_block");

const profile = routeToExecutionProfile("fast_patch", patch);
assert(profile.max_model_turns < 14);
assert.equal(profile.requires_confirmation, true);
```

- [ ] **Step 2: Run the policy test and verify the expected missing-module failure**

Run: `node tests/task-route-policy.mjs`

Expected: FAIL because `src/taskRoutePolicy.mjs` does not exist.

- [ ] **Step 3: Implement the pure policy**

Use hard gates before weighted signals. Return deterministic reasons and a
confidence value. Use these initial thresholds: score `0-20` fast patch,
`21-49` guided build, `50+` full Agent; ambiguity and hard unsupported scope
route to clarify/block. A hardware/API/deploy gate must force full Agent.

- [ ] **Step 4: Run the policy test**

Run: `node tests/task-route-policy.mjs`

Expected: PASS.

- [ ] **Step 5: Integrate without adding another model call**

Call the policy before the build graph. Attach the profile to the build
request and use it to cap Agent turns and repairs. Emit route, score, reasons,
and any promotion in progress telemetry.

- [ ] **Step 6: Run focused regression tests**

Run: `node tests/task-route-policy.mjs; node tests/agent-loop-quality.mjs; node tests/verify-agent.mjs`

Expected: all commands exit 0.

### Task 2: Hardware Contract Firewall

**Files:**
- Modify: `src/agentTaskContract.mjs`
- Modify: `src/agent.mjs`
- Modify: `src/generatedAppTemplate.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `src/marketRuntime.mjs` if deploy filtering is not centralized there
- Create: `tests/hardware-contract-firewall.mjs`

**Interfaces:**
- `isAgentWritableFile(path)` must reject `hardware_app.py`.
- A system-side `filterDeployableFiles(files, contract)` returns only allowed
  generated files and declared assets.
- Existing hardware wrapper/injection functions remain callable for legacy
  builds.

- [ ] **Step 1: Write the failing firewall tests**

Cover Agent write rejection, deploy payload filtering, legacy wrapper
compatibility, and confirmation enforcement:

```js
assert.equal(isAgentWritableFile("hardware_app.py"), false);
assert.throws(() => executeTool("edit_file", { path: "hardware_app.py", old_text: "x", new_text: "y" }), /system-owned|cannot modify|not writable/i);
assert.deepEqual(Object.keys(filterDeployableFiles({ "index.html": "", "hardware_app.py": "", "secret.txt": "" })), ["index.html", "hardware_app.py"]);
```

- [ ] **Step 2: Run the firewall test and verify it fails for the current writable set**

Run: `node tests/hardware-contract-firewall.mjs`

Expected: FAIL because the current task contract includes `hardware_app.py`
as writable and deployment does not have a single hard gate.

- [ ] **Step 3: Remove hardware implementation writes from the Agent**

Keep `hardware_app.py` in required system output, but remove it from the
model's create/edit permission. Add a read-only contract summary tool result
instead of exposing mutable implementation as a normal work file.

- [ ] **Step 4: Add system-side normalization and deploy filtering**

Run existing injection/wrapper code after Agent completion, validate the
contract hash/build id/JSON stdout, and filter deployment files before SCP.
Reject deployment unless the server receives explicit confirmation, a bound
device, and a matching contract version/hash.

- [ ] **Step 5: Run hardware-focused tests**

Run: `node tests/hardware-contract-firewall.mjs; node tests/verify-agent.mjs`

Expected: both commands exit 0 and legacy wrapper tests remain green.

### Task 3: Asset Relevance Index

**Files:**
- Create: `src/assetRelevanceIndex.mjs`
- Modify: `src/assetLibrary.mjs`
- Modify: `server.mjs` only where asset context query is assembled
- Create: `tests/asset-relevance-index.mjs`

**Interfaces:**
- `createAssetRelevanceIndex(db, saveDb)` exposes `initSchema`, `upsert`,
  `remove`, `rebuild`, and `searchRelevantAssets`.
- `searchRelevantAssets(conversationId, query, filters)` returns stable top-k
  assets with score, matched facets, and source metadata.
- Existing `promptContext` uses the new search result and falls back to the
  current summary when the index is unavailable.

- [ ] **Step 1: Write failing index tests**

Test exact filename, summary/CTA, scope filtering, stable ranking, legacy
backfill, and non-embeddable asset exclusion.

- [ ] **Step 2: Run the index test and verify the missing-module failure**

Run: `node tests/asset-relevance-index.mjs`

Expected: FAIL because the index module and tables do not exist.

- [ ] **Step 3: Implement portable derived tables and indexes**

Create `asset_relevance_docs` and `asset_relevance_terms`, plus indexes on
conversation/kind/usage, folder, build snapshot, and term lookup. Build terms
from name, kind, category, usage, signals, colors, CTA, fields, and design or
document profiles. Keep the original asset row untouched.

- [ ] **Step 4: Wire write-through and lazy backfill**

Update add/update/delete/build-snapshot paths. On a read, backfill only rows
missing a relevance document; do not rewrite already indexed rows.

- [ ] **Step 5: Replace broad prompt asset injection with top-k retrieval**

Always preserve explicitly selected assets. For inferred assets, return no
more than 12 relevant items and include match reasons. Keep reference-only
assets out of generated file embedding.

- [ ] **Step 6: Run asset tests and existing asset coverage**

Run: `node tests/asset-relevance-index.mjs; node tests/verify-agent.mjs`

Expected: all asset tests and existing asset tests pass.

### Task 4: Unified Memory Retrieval

**Files:**
- Create: `src/contextRetriever.mjs`
- Modify: `src/memoryStore.mjs`
- Modify: `src/experienceStore.mjs`
- Modify: `src/playbookStore.mjs`
- Modify: `src/projectWorkspace.mjs`
- Create: `tests/context-retriever.mjs`

**Interfaces:**
- `createContextRetriever(deps)` exposes `loadMemoryContext(input)` and
  `formatMemoryContext(result)`.
- Each result entry includes `source`, `scope`, `content`, `confidence`,
  `updated_at`, and `provenance`.
- Global preferences/playbooks are marked global; project entries require a
  matching organization/project/conversation scope.

- [ ] **Step 1: Write failing retrieval and isolation tests**

Create project, global, preference, experience, and playbook fixtures. Assert
confirmed project facts rank first, query terms affect ordering, provenance is
present, and project A cannot retrieve project B's entries.

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node tests/context-retriever.mjs`

Expected: FAIL because the unified retriever does not exist.

- [ ] **Step 3: Implement the scoped retrieval boundary**

Read structured project memory as the authoritative project source. Treat
`MEMORY.md` as a derived snapshot. Merge recent conversation, asset/file
summaries, user preferences, experiences, and playbooks using the fixed
precedence from the design. Apply a bounded result limit before formatting.

- [ ] **Step 4: Add explicit scope fields or global markers to auxiliary sources**

Preserve old rows by treating missing scope as product-global only for
playbooks. Do not use unscoped user preferences as project facts. Include
source and scope in the formatted prompt.

- [ ] **Step 5: Wire planner and generator to the unified context**

Replace independent broad memory/asset concatenation at the orchestration
boundary with a single retrieval call per phase. Keep degraded fallbacks and
log retrieval source counts.

- [ ] **Step 6: Run retrieval and persistence tests**

Run: `node tests/context-retriever.mjs; node tests/project-persistence.mjs; node tests/verify-agent.mjs`

Expected: all commands exit 0.

### Task 5: Integration, Promotion, and Benchmarking

**Files:**
- Modify: `src/agentOrchestrator.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `src/jobRuntime.mjs` only for route-aware timeout/telemetry propagation
- Modify: `scripts/run-agent-benchmark.mjs`
- Create: `tests/context-routing-integration.mjs`

**Interfaces:**
- Every build evidence object contains `route_profile` and optional
  `route_escalations`.
- The job log records route, score, model turns, verification attempts,
  retrieval counts, and degraded fallbacks.

- [ ] **Step 1: Write failing integration tests**

Exercise four prompts: cosmetic patch, calendar, microphone, and deploy. Assert
profile selection, escalation behavior, hardware write rejection, and local
verification requirements.

- [ ] **Step 2: Run the integration test and verify the missing wiring failure**

Run: `node tests/context-routing-integration.mjs`

Expected: FAIL until the orchestration and generation seams carry the new
profile and retrieval evidence.

- [ ] **Step 3: Connect route, retrieval, and contract firewall**

Use one bounded context assembly per planner/generator phase, pass the route
profile into Agent settings, and promote the profile when a tool result
discovers a hard dependency.

- [ ] **Step 4: Add benchmark scenarios and inspect telemetry**

Extend the fixture benchmark with route selection, model-turn budget,
escalation, asset top-k, and memory provenance measurements.

- [ ] **Step 5: Run the complete verification set**

Run:

```text
npm run check
node tests/task-route-policy.mjs
node tests/hardware-contract-firewall.mjs
node tests/asset-relevance-index.mjs
node tests/context-retriever.mjs
node tests/context-routing-integration.mjs
npm run verify:agent
npm run verify:agent-quality
npm run verify:persistence
```

Expected: every command exits 0. Any pre-existing failure must be separated
from a regression and reported with its exact command output.

- [ ] **Step 6: Run a live small-task smoke test**

Use the existing DeepSeek configuration to generate a calendar and a cosmetic
patch, confirm route telemetry and preview behavior, and do not deploy to a
real device during this change.

