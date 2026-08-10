# VibeBoard To B Phase A Execution Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generation and build requests explicitly tenant/project/build scoped so multiple users can execute concurrently without a process-global `generate_busy`, shared workspace, duplicate job, or cross-user status.

**Architecture:** Add an `ExecutionContext` value object, durable idempotent job creation, job-scoped source/build directories, and explicit build handles. Keep the current Agent and RK3566 verification internals temporarily behind these interfaces. Public requests return an accepted job immediately and the existing job status endpoint remains the compatibility polling path; Worker extraction is Phase B.

**Tech Stack:** Node.js ESM, PostgreSQL through the existing `postgres` adapter, sql.js/JSON persistence for isolated tests and local fallback, Node `crypto`, existing test harness in `tests/support/serverHarness.mjs`.

## Global Constraints

- Do not revert or reformat unrelated dirty worktree changes.
- Do not expose raw credentials in contexts, jobs, logs, artifacts, or API responses.
- Existing RK3566 five-file generation and L0-L4 verification behavior must remain available.
- A duplicate request is defined by `(organization_id, operation, idempotency_key)` plus a normalized input digest.
- Different projects may execute concurrently; the same project may only advance its head with the expected revision supplied by the caller.
- Deployment is out of Phase A except for removing generation/build state that can corrupt deployment selection.
- SQLite and JSON adapters must implement the same observable repository contract as PostgreSQL in tests.
- Every implementation task follows RED -> GREEN -> REFACTOR and ends with a focused test command and an atomic commit.

---

### Task 1: Add explicit execution context and request identity

**Files:**
- Create: `src/executionContext.mjs`
- Test: `tests/execution-context.mjs`
- Modify: `server.mjs` at request authentication and job route call sites

**Interfaces:**
- Consumes: authenticated `requestUser`, `conversationId`, `operation`, `client_run_id`, optional `projectId`, `applicationId`, `buildId`, `deviceId`.
- Produces: `createExecutionContext(input)`, `normalizeIdempotencyKey(input)`, `executionContextFromRequest(req, user, body)`.

`createExecutionContext` returns a frozen object with non-empty `organizationId`, `actorId`, `projectId`, `requestId`, and operation. Existing users without an organization receive a deterministic personal organization ID during migration. It rejects missing actor or project identity with a typed `execution_context_invalid` error.

- [ ] **Step 1: Write the failing test**

Add tests proving that equivalent inputs normalize to the same context, that a missing organization is rejected for a non-migrated user, that `client_run_id` is preferred over legacy keys, and that returned context cannot be mutated.

```js
const context = createExecutionContext({
  organizationId: "org-a",
  actorId: "user-a",
  projectId: "project-a",
  operation: "generate",
  requestId: "req-a",
});
assert(context.organizationId === "org-a", "context keeps organization identity");
assert(Object.isFrozen(context), "context is immutable");
assert.throws(() => createExecutionContext({ actorId: "user-a", projectId: "p", operation: "generate" }), /organization/i);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/execution-context.mjs`

Expected: FAIL because `src/executionContext.mjs` does not exist.

- [ ] **Step 3: Implement the minimal context module**

Use `crypto.randomUUID()` only for a missing request ID. Normalize all IDs to trimmed strings, reject control characters, and derive the idempotency key from `client_run_id`, `clientRunId`, or `request_id` in that order. Do not read process-global board or build state from this module.

- [ ] **Step 4: Integrate context creation at job submission**

In `server.mjs`, build the context after `requestUser` is known and before `ensureConversationAccess`, credits, or job creation. Pass `organization_id`, `actor_id`, `project_id`, `application_id`, `build_id`, `device_id`, and `idempotency_key` as explicit job fields. Keep the old `user_id` inside `input` only for response compatibility.

- [ ] **Step 5: Run focused tests and syntax checks**

Run: `node tests/execution-context.mjs` and `npm run check`

Expected: both exit with code 0 and the new test prints `{ "ok": true }`.

- [ ] **Step 6: Commit the context boundary**

```bash
git add src/executionContext.mjs tests/execution-context.mjs server.mjs
git commit -m "feat: add explicit execution context"
```

### Task 2: Make job creation durable and idempotent

**Files:**
- Modify: `src/jobStore.mjs`
- Modify: `src/projectPersistence.mjs`
- Modify: `server.mjs` schema bootstrap only where required for compatibility
- Create: `tests/job-concurrency.mjs`
- Modify: `tests/project-persistence.mjs`

**Interfaces:**
- Consumes: `ExecutionContext` from Task 1 and the existing `createJob({ type, conversationId, title, input })` contract.
- Produces: `createOrGetJob({ context, operation, idempotencyKey, input })`, `getJobForOrganization(id, organizationId)`, and normalized job fields `organization_id`, `project_id`, `build_id`, `idempotency_key`, `input_digest`.

Extend SQLite, PostgreSQL, and JSON persistence together. PostgreSQL uses a unique partial index or unique constraint on organization, operation, and idempotency key. SQLite uses the equivalent unique index. JSON uses an in-memory lookup under its existing serialized mutation lock. The input digest is calculated from stable JSON with secrets and volatile request fields removed.

- [ ] **Step 1: Write failing idempotency and isolation tests**

Test each persistence adapter with two organizations. Submit the same operation and key twice and assert one ID. Submit the same key with a changed prompt and assert `idempotency_conflict`. Assert organization A cannot retrieve organization B's job. Assert two different keys create two queued jobs.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node tests/job-concurrency.mjs`

Expected: FAIL because the current job schema has no organization or idempotency columns and `createJob` always creates a new ID.

- [ ] **Step 3: Add schema and normalization fields**

Add nullable migration-safe columns first, then backfill legacy rows from `input_json.user_id` into a deterministic personal organization. New writes require the explicit organization. Normalize the fields in all adapters without changing the existing API property names.

- [ ] **Step 4: Implement atomic create-or-get**

Use one transaction/unique constraint path for PostgreSQL, an insert-and-read conflict path for SQLite, and the existing serialized JSON mutation path. Compare `input_digest` on an existing key before returning it. Never run a handler from `createOrGetJob`; creation and execution remain separate.

- [ ] **Step 5: Add organization-scoped reads and route checks**

Replace `filterJobsForUser` as the primary boundary with repository queries constrained by organization and actor membership. Keep the application-level filter temporarily as a defense-in-depth check. Return `404` for an inaccessible job to avoid leaking its existence.

- [ ] **Step 6: Run focused tests and persistence verification**

Run: `node tests/job-concurrency.mjs`, `node tests/project-persistence.mjs`, and `node tests/database-client.mjs`

Expected: all exit with code 0; duplicate submissions report one job ID.

- [ ] **Step 7: Commit the durable job identity change**

```bash
git add src/jobStore.mjs src/projectPersistence.mjs server.mjs tests/job-concurrency.mjs tests/project-persistence.mjs
git commit -m "feat: make job submission idempotent and tenant scoped"
```

### Task 3: Remove mutable current-build selection from generation

**Files:**
- Modify: `src/buildRegistry.mjs`
- Modify: `src/generateRuntime.mjs`
- Modify: `src/buildRuntime.mjs`
- Modify: `src/projectWorkspace.mjs`
- Create: `tests/build-isolation.mjs`

**Interfaces:**
- Consumes: `ExecutionContext`, a source snapshot, and the existing RK3566 contract.
- Produces: `createBuildHandle({ context, buildId, workspaceDir, files })`, `getBuildById(buildId)`, and `buildCurrent({ context, build })`.

The build handle is the only source of files, manifest, evidence, and workspace for an execution. `setCurrentBuild` remains as a compatibility adapter for old UI reads, but generation and build code must stop using it to select work. `generated/current` becomes a legacy read alias only; new work uses `generated/jobs/<jobId>/<buildId>` or a job-local temporary directory.

- [ ] **Step 1: Write failing isolation tests**

Create two build handles with the same filenames but different build IDs and assert that build, snapshot, and preview resolution returns the requested handle. Run two concurrent jobs with delayed writes and assert neither file set changes the other.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/build-isolation.mjs`

Expected: FAIL because the current registry has one `currentBuild` and the generation path writes to one shared directory.

- [ ] **Step 3: Implement explicit build handles**

Change `buildRuntime` and generation internals to receive `{ context, build }`. Every generated file write uses `build.workspaceDir`; every read uses `build.files` or an artifact reference. Preserve `conversationId` and `buildId` in build metadata.

- [ ] **Step 4: Make project snapshots build-addressed**

Use `projectWorkspace.writeBuildSnapshot(conversationId, buildId, ...)` only after the build is complete and write under the build ID. Do not overwrite another build's directory. The persistence record stores the latest project head separately from historical build snapshots.

- [ ] **Step 5: Run focused isolation and existing generation tests**

Run: `node tests/build-isolation.mjs`, `node tests/project-persistence.mjs`, and `node tests/verify-agent.mjs`

Expected: the new isolation test and existing agent tests exit 0; every returned build ID matches the requested job.

- [ ] **Step 6: Commit build isolation**

```bash
git add src/buildRegistry.mjs src/generateRuntime.mjs src/buildRuntime.mjs src/projectWorkspace.mjs tests/build-isolation.mjs
git commit -m "refactor: isolate builds by execution context"
```

### Task 4: Allow concurrent generation without request-bound execution

**Files:**
- Modify: `src/generateRuntime.mjs`
- Modify: `src/jobRuntime.mjs`
- Modify: `server.mjs`
- Modify: `tests/production-persistence.mjs`
- Create: `tests/multi-user-generation.mjs`

**Interfaces:**
- Consumes: idempotent jobs from Task 2 and isolated build handles from Task 3.
- Produces: `enqueueBackgroundJob` that returns a queued job immediately, per-job runtime contexts, and a compatibility response containing `job.id`, `status`, and `poll_url`.

Remove the process-global `activeGenerate` rejection. The runtime factory no longer owns a single active slot; each invocation receives a job-local context and file store. The initial process may use a configurable local concurrency limiter, defaulting to the number of configured Agent Worker slots, but the limiter must queue durably and never return `generate_busy`.

For public deployment, replace `runRequestBoundJob` for `agent` and `generate` with durable enqueue plus `202 Accepted`. Preserve a `result` field only when a compatibility flag explicitly requests synchronous local mode. Update the frontend path that currently expects an immediate generated result to poll `GET /api/jobs/:id` until terminal state.

- [ ] **Step 1: Write failing multi-user integration tests**

Start one server with two authenticated users and deterministic fake generation handlers. Submit two generation requests at the same time. Assert both responses are accepted, IDs differ, neither response contains `generate_busy`, both jobs reach success, and each output has its own conversation and build ID. Submit the first request twice with the same `client_run_id` and assert one job.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/multi-user-generation.mjs`

Expected: FAIL because public jobs are request-bound and generation rejects a second active request.

- [ ] **Step 3: Refactor the runtime invocation context**

Pass `{ context, jobId, buildId, workspaceDir, conversationId }` into the generation runtime. Replace log fields that read `activeGenerate` with the explicit context. Keep existing model settings, Agent verification, and error classification unchanged.

- [ ] **Step 4: Implement durable enqueue response**

Make `POST /api/jobs` return `202` and:

```json
{
  "ok": true,
  "job": { "id": "job_...", "status": "queued", "organization_id": "org_..." },
  "poll_url": "/api/jobs/job_..."
}
```

The route must use `createOrGetJob`, schedule execution after commit, and return the existing job for an idempotent retry.

- [ ] **Step 5: Update browser job handling**

Find all `POST /api/jobs`, `/api/agent`, and generate result assumptions in `app.js`, `portal.js`, and `index.html`. Add one job polling helper with exponential backoff capped at five seconds, terminal error rendering, cancellation support, and no duplicate submission while the same client run is active. Do not change unrelated UI styling.

- [ ] **Step 6: Run focused and compatibility tests**

Run: `node tests/multi-user-generation.mjs`, `node tests/auth-flow.mjs`, `node tests/production-persistence.mjs`, `node tests/verify-agent.mjs`, and `npm run check`

Expected: both users complete independently, public persistence survives restart, and no test reports a `generate_busy` response.

- [ ] **Step 7: Commit concurrent generation behavior**

```bash
git add src/generateRuntime.mjs src/jobRuntime.mjs server.mjs app.js portal.js index.html tests/production-persistence.mjs tests/multi-user-generation.mjs
git commit -m "feat: accept concurrent generation jobs"
```

### Task 5: Add Phase A verification gate and migration guardrails

**Files:**
- Create: `tests/phase-a-multi-user-acceptance.mjs`
- Create: `scripts/check-execution-isolation.mjs`
- Modify: `package.json`
- Modify: `docs/architecture-opportunities.md`

**Interfaces:**
- Consumes: all Phase A contracts and job APIs.
- Produces: `npm run verify:b2b-phase-a` and a machine-readable acceptance summary.

- [ ] **Step 1: Write failing acceptance checks**

The acceptance script must check concurrent two-user generation, duplicate client submission, build ID isolation, inaccessible job lookup, restart recovery, and absence of `currentBuild`/`generated/current` use in the asynchronous path.

- [ ] **Step 2: Run it and verify RED**

Run: `npm run verify:b2b-phase-a`

Expected: FAIL against the pre-Phase-A implementation.

- [ ] **Step 3: Implement the acceptance runner**

Reuse `tests/support/serverHarness.mjs`; use temporary database, project, and artifact paths. Print a JSON summary with each gate name, status, and evidence path.

- [ ] **Step 4: Register the verification command**

Add `"verify:b2b-phase-a": "node tests/phase-a-multi-user-acceptance.mjs"` to `package.json` without changing existing verification commands.

- [ ] **Step 5: Run the complete Phase A gate**

Run: `npm run verify:b2b-phase-a`, `npm run check`, and `git diff --check`

Expected: all Phase A checks pass and no whitespace errors are reported.

- [ ] **Step 6: Commit the Phase A gate**

```bash
git add tests/phase-a-multi-user-acceptance.mjs scripts/check-execution-isolation.mjs package.json docs/architecture-opportunities.md
git commit -m "test: add b2b multi-user acceptance gate"
```

## Execution Order

Tasks must be completed in order: 1 -> 2 -> 3 -> 4 -> 5. Tasks 1 and 2 may be reviewed by separate agents, but Task 3 cannot begin until the persistence contract from Task 2 is green. Task 4 may use a worker agent only after the focused concurrency tests are red and the current request-bound behavior is documented. Task 5 is the final gate and must run against the integrated branch.

## Completion Criteria

Phase A is complete only when two authenticated users can submit concurrent generation requests, receive different durable jobs, observe independent status, and retrieve builds whose files and Build IDs do not cross over. A successful test run is required before any claim that multi-user concurrent generation is fixed.
