# VibeBoard To B Control Plane and Worker Architecture Design

Date: 2026-08-10
Status: Approved architecture direction

## 1. Purpose

VibeBoard will evolve from a single-process embedded application prototype into a multi-tenant embedded application delivery platform. The platform must allow multiple organizations and users to generate, verify, build, preview, and deploy applications concurrently without sharing mutable execution state.

The selected architecture is a modular control plane with independent execution workers. The control plane remains one deployable service initially. Agent, build, render, hardware-in-the-loop, and deployment workloads move behind explicit worker contracts and can scale independently.

This design preserves the existing contract-first generation, automatic repair, L0-L4 verification, deployment evidence, and RK3566 delivery path. It replaces their process-global execution context with durable, tenant-scoped identities and immutable artifacts.

## 2. Current Constraints

The current implementation has useful modules but still relies on process-local coordination:

- `src/buildRegistry.mjs` keeps `currentBuild`, endpoints, and deployment state in memory.
- `src/generateRuntime.mjs` permits only one `activeGenerate` per process.
- `src/jobRuntime.mjs` serializes every job through one Promise chain.
- `server.mjs` temporarily mutates global `BOARD`, credentials, endpoint, and deploy lock state.
- `src/contracts.mjs` fixes every generated application to one RK3566 web-and-Python file set.
- `conversation_files` stores the latest conversation snapshot, not immutable build artifacts.
- Job ownership is partly embedded in `input_json`, and jobs have no lease, heartbeat, fencing token, or idempotency constraint.
- Remote Python and render runners are synchronous request-response helpers rather than durable workers.

These constraints permit multiple accounts and histories but do not provide safe concurrent generation or deployment.

## 3. Goals

1. Different users and projects can generate, build, and preview concurrently.
2. Normal concurrent load does not return `generate_busy` or serialize through one global queue.
3. Every command carries explicit organization, project, build, job, and actor identity.
4. A repeated client submission returns the original job and does not repeat side effects.
5. A build references an immutable artifact; deployment never reads a mutable current workspace.
6. Worker restart and control-plane restart do not lose jobs or corrupt state.
7. Only deployment to the same physical device is serialized. Different devices deploy concurrently.
8. Existing RK3566 generation and L0-L4 evidence remain behaviorally compatible during migration.
9. New device families are added through capability, build, verification, and deployment adapters.
10. The architecture supports public cloud, VibeBoard-managed private deployment, and customer-site edge workers.

## 4. Non-Goals

- Do not split every domain into an independently deployed microservice in the first release.
- Do not replace PostgreSQL with an event-streaming platform.
- Do not rewrite the existing Agent loop or RK3566 verifier before execution identity is explicit.
- Do not permit concurrent writes to the same physical device.
- Do not promise zero queue time under unbounded demand. The system removes artificial global serialization and scales workers within configured capacity.
- Do not store source archives, binary assets, screenshots, or evidence bundles as large database text fields after artifact migration.

## 5. Target Architecture

### 5.1 Control Plane

The control plane is a modular Node.js service responsible for:

- Identity, organizations, memberships, and role-based access control.
- Projects, applications, conversations, and version metadata.
- Builds, immutable artifact metadata, and evidence indexes.
- Job submission, idempotency, leasing policy, status, cancellation, and audit events.
- Device registry, device ownership, desired version, and deployment history.
- Capability profiles, adapter selection, policy, quota, and billing events.
- Public APIs and SSE status streams.

HTTP handlers must call domain services with an authenticated `ExecutionContext`. They must not mutate runtime globals or execute long-running build and deployment commands in the request process.

### 5.2 Execution Plane

Workers poll or claim durable jobs and execute one explicit workload:

- Agent Worker: prompt planning, file generation, editing, and repair.
- Build Worker: dependency resolution, syntax checks, compilation, and packaging.
- Render Worker: browser rendering, screenshots, geometry checks, and preview evidence.
- HIL Worker: board reservation, hardware execution, probes, and L4 evidence.
- Deploy Worker: signed bundle delivery, activation, observation, and rollback.

Workers may share one codebase and image at first, selected by a `WORKER_CAPABILITIES` setting. Process boundaries are operational, not domain boundaries.

### 5.3 Device Plane

Production devices use an outbound Device Agent or a customer-site Edge Worker. The connection uses a per-device identity and does not expose customer devices directly to the public internet.

The existing SSH/FRP adapter remains available for development, migration, and recovery. It is not the default fleet-management protocol.

### 5.4 Data Plane

- PostgreSQL is the source of truth for identities, projects, jobs, builds, devices, deployments, and audit events.
- An S3-compatible Artifact Store holds source snapshots, assets, build bundles, screenshots, logs, SBOMs, and evidence bundles.
- Credentials are stored in a secret manager or encrypted deployment configuration. Domain records contain `credential_ref`, never raw passwords or API keys.
- PostgreSQL-backed job claiming and an outbox table are the initial queue implementation. Redis, NATS, or another broker is introduced only when measured throughput requires it.

## 6. Core Domain Model

### 6.1 Required Identities

Every mutable domain record has a database-level `organization_id`. Every execution request carries:

```text
ExecutionContext {
  organizationId
  actorId
  projectId
  applicationId
  buildId
  jobId
  requestId
}
```

`deviceId` is required only for HIL and deployment jobs. `conversationId` may be included for chat history but is not an execution identity.

### 6.2 Application and Build

```text
ApplicationSpec
  -> DeviceProfile
  -> BuildPlan
  -> Build
  -> ArtifactManifest
  -> EvidenceBundle
  -> Deployment
```

- `ApplicationSpec` describes services, UI, workflows, assets, permissions, and required capabilities.
- `DeviceProfile` declares capabilities, resource limits, runtime, toolchain, adapter identifiers, and verification requirements.
- `BuildPlan` resolves one application version against one device profile.
- `Build` is an immutable execution result with a terminal status and artifact digest.
- `ArtifactManifest` lists every artifact object, digest, size, media type, and purpose.
- `EvidenceBundle` contains normalized L0-L4 checks and references to detailed logs and screenshots.
- `Deployment` binds one artifact digest to one device and records desired, observed, rollback, and final state.

The existing five-file RK3566 contract becomes `rk3566-web-python/v1`. It remains supported as the first adapter profile.

### 6.3 Jobs

Jobs include explicit columns for:

```text
organization_id, project_id, application_id, build_id, device_id,
idempotency_key, status, phase, attempt, max_attempts,
lease_owner, lease_until, heartbeat_at, fencing_token,
available_at, created_by, created_at, updated_at, completed_at
```

The unique idempotency constraint is:

```text
(organization_id, operation, idempotency_key)
```

Submitting the same operation with the same key returns the existing job. A key reused with a different normalized payload returns `409 idempotency_conflict`.

## 7. Required Interfaces

### 7.1 Job Repository

```js
createOrGet({ context, operation, idempotencyKey, input, inputDigest })
claim({ workerId, capabilities, leaseMs })
heartbeat({ jobId, workerId, leaseToken, leaseMs })
complete({ jobId, workerId, leaseToken, output })
fail({ jobId, workerId, leaseToken, error, retryAt })
requestCancel({ jobId, actorId })
```

`claim`, `heartbeat`, `complete`, and `fail` use atomic database predicates. A stale worker cannot complete a job after its lease token changes.

### 7.2 Artifact Store

```js
putArtifact({ organizationId, buildId, name, content, mediaType, digest })
getArtifact({ organizationId, artifactId })
createManifest({ organizationId, buildId, entries })
materializeWorkspace({ organizationId, buildId, targetDir })
```

Artifacts are content-addressed and immutable. Upload is complete only after digest verification. Database metadata and object upload use a pending-to-ready state plus an outbox event, avoiding a false ready record when object upload fails.

### 7.3 Build Executor

```js
executeBuild({ context, applicationSpec, deviceProfile, sourceManifest })
```

The executor creates a job-local temporary directory, materializes source by artifact reference, runs the selected adapter, publishes an immutable result, and deletes the temporary directory. It does not read `currentBuild` or `generated/current`.

### 7.4 Device Gateway

```js
deploy({ context, deviceId, artifactManifestId, credentialRef, fencingToken })
observe({ context, deviceId, deploymentId })
rollback({ context, deviceId, deploymentId, fencingToken })
```

The gateway acquires a database-backed device lease. Only the current fencing token can activate or roll back a release. This prevents an expired worker from writing after a replacement worker has taken ownership.

## 8. Command and Event Flow

1. The browser creates one `client_run_id` for a user action.
2. The API authenticates membership and creates an `ExecutionContext`.
3. `createOrGet` atomically creates or returns the job.
4. The API returns `202` with `job_id`; it does not wait for execution.
5. An eligible worker claims the job with a lease.
6. The worker reads source artifacts, executes stages, heartbeats, and appends structured events.
7. The browser receives job events through SSE and can reconnect using the last event ID.
8. Successful build stages publish immutable artifacts and evidence.
9. Deployment jobs reference an artifact manifest and device explicitly.
10. Completion or failure updates the job using the current lease token and emits an outbox event.

## 9. Concurrency Rules

- Different organizations and projects run concurrently.
- Different builds in one project run concurrently because their source snapshots and artifacts are immutable.
- Updating a project head uses optimistic concurrency with `expected_revision`; conflicting writes return `409 project_revision_conflict` and preserve both builds.
- A user quota limits active jobs but does not impose a global generation mutex.
- Device deployment locking is scoped to `device_id`.
- A HIL device reservation is scoped to the physical lab resource, not the organization.
- Worker capacity controls queue time. Queue saturation returns an accepted job with a capacity estimate, not `generate_busy`.

## 10. Failure and Recovery Semantics

- A worker process crash leaves the job leased until `lease_until`; another worker then claims it.
- Retryable stages use bounded retries and retain prior attempt evidence.
- Non-idempotent device activation requires a fencing token and post-action observation before retry.
- Cancellation marks `cancel_requested`; cooperative workers stop between stages. A canceled or stale worker cannot publish final output.
- Object upload failures leave the artifact in `pending` or `failed`, never `ready`.
- Database unavailability rejects new commands with a stable error and does not fall back silently to local SQLite in production.
- Dead-lettered jobs retain source references, attempts, logs, normalized error, and operator actions.
- Every deployment records previous and desired artifact digests so rollback is deterministic.

## 11. Security and Isolation

- Repository methods require `organizationId`; cross-organization lookup is not exposed by default.
- Membership and role checks occur before job creation and artifact access.
- Signed artifact manifests protect device delivery integrity.
- Worker sandboxes have per-job directories, CPU/memory/time limits, and restricted network egress.
- Device and model credentials are resolved by reference at execution time and are excluded from job JSON and logs.
- Audit events cover job submission, worker claims, artifact publication, deployment, rollback, membership change, and secret-reference use.
- Private customers may receive a dedicated worker pool or cell without changing the control-plane API.

## 12. Migration Program

The architecture is implemented as four separately reviewable subprojects.

### Phase A: Multi-User Execution Identity

- Add organization, project, application, build, and job ownership columns.
- Introduce `ExecutionContext` and request-level `client_run_id`.
- Implement atomic idempotent job creation.
- Replace global `activeGenerate` with tenant-scoped capacity policy.
- Make build and generation APIs accept explicit build and source identity.
- Preserve existing synchronous internals behind the new interfaces until Worker extraction.

Exit gate: two users can submit and complete independent generation jobs concurrently without `generate_busy`, shared files, or status crossover.

### Phase B: Durable Jobs and Immutable Artifacts

- Add job claim, lease, heartbeat, attempt, retry, cancellation, and dead-letter semantics.
- Add S3-compatible Artifact Store with filesystem implementation for tests.
- Store source snapshots and build results as immutable manifests.
- Change preview and deployment to resolve artifacts by build ID.
- Run Agent, Build, and Render as separate worker processes.

Exit gate: control-plane and worker restart tests complete queued jobs exactly once at the observable contract and never deploy an artifact from another build.

### Phase C: Capability-Based Hardware and Device Gateway

- Version `DeviceProfile` and adapter interfaces.
- Wrap the existing RK3566 contract, verifier, SSH deployment, and golden loop as one adapter.
- Add database-backed device leases and fencing tokens.
- Introduce outbound Device Agent or Edge Worker protocol.
- Add signed bundles, desired/observed versions, staged activation, and rollback.

Exit gate: two devices deploy concurrently; two deployments to one device serialize; stale workers cannot activate a release.

### Phase D: Enterprise Operations

- Add organization RBAC, quotas, audit search, worker pools, and private cells.
- Add fleet rollout groups, canary policy, telemetry, alerting, and HIL scheduling.
- Add additional board adapters only after RK3566 adapter acceptance passes.
- Add billing events from durable job and deployment facts.

Exit gate: a pilot customer can operate projects, members, private devices, deployments, rollbacks, evidence, and audit history without administrator access to the host.

## 13. Verification Strategy

### Unit and Contract Tests

- Idempotency returns one job for equivalent duplicate requests and conflicts for different payloads.
- Lease transitions reject stale worker and stale fencing tokens.
- Repository methods cannot read records from another organization.
- Artifact digest mismatch prevents publication.
- Adapter selection is deterministic for a Device Profile version.

### Integration Tests

- Two users generate concurrently and receive only their own events and artifacts.
- Worker crash, lease expiry, and recovery complete a build without duplicate publication.
- Control-plane restart does not change job, build, or deployment identity.
- Two devices deploy concurrently while one device rejects overlapping deployment ownership.
- Preview resolves an immutable artifact after the original worker directory has been deleted.

### End-to-End Acceptance

- Generate, edit, build, preview, verify, deploy, observe, and roll back an RK3566 application.
- Run the same workflow concurrently for at least two users and two projects.
- Confirm no `generate_busy`, no cross-user events, no shared temporary files, and no incorrect Build ID.
- Confirm an intentional worker kill is visible and recoverable.
- Confirm every successful deployment has L0-L4 evidence and previous/current artifact digests.

### Performance Baseline

The first production gate is eight concurrent generation jobs with configurable worker concurrency. No job may fail solely because another user is generating. Capacity beyond the configured worker count may queue durably and must expose queue position or capacity state.

## 14. Compatibility and Rollback

- Existing API responses retain current fields while adding stable IDs and asynchronous job links.
- Existing conversation snapshots remain readable during artifact migration.
- The RK3566 five-file contract and current golden-loop checks remain versioned fixtures.
- Each migration adds schema columns and new tables before switching reads.
- Dual-read validation is permitted; dual-write is limited to migration windows and measured with reconciliation checks.
- Feature flags select legacy in-process execution or durable Worker execution by job type.
- Rollback disables new job claiming, allows leased jobs to finish or expire, and routes new jobs to the previous execution path without deleting new metadata.

## 15. Acceptance Criteria

Route B is complete only when all of the following are true:

1. Generation, build, preview, and deployment do not depend on process-global Build or Board state.
2. Every job and artifact has database-enforced organization ownership.
3. Duplicate client actions produce one job and one set of side effects.
4. Multiple workers cannot successfully own the same lease or device fencing token.
5. Build artifacts remain available after every application process restarts.
6. Different users can generate concurrently without global busy responses.
7. Different devices can deploy concurrently; one device remains serialized.
8. Worker failure and network retry tests preserve correct final state.
9. RK3566 generation, verification, deployment, evidence, and rollback still pass.
10. Operational dashboards expose queue depth, active leases, retry rate, dead letters, build duration, deployment success, and rollback success.
